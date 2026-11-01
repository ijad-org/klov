//! Background task that drains the ingestion channel and persists events in bulk.
//!
//! Up to `FLUSH_MAX_EVENTS` events (or whatever arrived within `FLUSH_INTERVAL_MS`)
//! are written in one transaction with set-based statements, then the requests
//! that sent them are acknowledged and live diffs are broadcast.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use klovplay_schema::{AllureAnnotations, SseStateDiff, TelemetryEvent};
use serde::Serialize;
use sqlx::types::Json;
use tokio::sync::{mpsc, watch};
use uuid::Uuid;

use crate::config::IngestConfig;
use crate::db::{self, Counters};
use crate::fingerprint::{error_cluster_hash, test_fingerprint};
use crate::ingestion::{AckError, IngestItem};
use crate::state::AppState;

const MAX_TEXT: usize = 64 * 1024;
const MAX_TITLE: usize = 4 * 1024;
const MAX_OUTPUT: usize = 256 * 1024;

/// Truncates to at most `max` bytes on a character boundary.
fn clip(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_owned();
    }
    let cut = (0..=max)
        .rev()
        .find(|i| text.is_char_boundary(*i))
        .unwrap_or(0);
    format!("{}…", &text[..cut])
}

fn clip_opt(text: &Option<String>, max: usize) -> Option<String> {
    text.as_deref().map(|t| clip(t, max))
}

/// Keeps output chunks until the byte budget is spent.
fn clip_output(chunks: &[String]) -> Vec<String> {
    let mut used = 0;
    let mut out = Vec::new();
    for chunk in chunks {
        if used + chunk.len() > MAX_OUTPUT {
            out.push(clip(chunk, MAX_OUTPUT.saturating_sub(used)));
            out.push("\n[output truncated by KlovPlay]\n".into());
            break;
        }
        used += chunk.len();
        out.push(chunk.clone());
    }
    out
}

fn is_failure(status: &str) -> bool {
    matches!(status, "failed" | "timedOut" | "interrupted")
}

#[derive(Serialize)]
struct StartRow {
    id: Uuid,
    launch_id: Uuid,
    fingerprint: String,
    playwright_test_id: String,
    title: String,
    file_path: String,
    line: i32,
    suite_path: Vec<String>,
    browser_project: String,
    worker_index: i32,
    parallel_index: i32,
    shard_index: i32,
    retry_attempt: i32,
    annotations: AllureAnnotations,
    started_at: DateTime<Utc>,
}

#[derive(Serialize)]
struct SupersedeRow {
    launch_id: Uuid,
    playwright_test_id: String,
    retry_attempt: i32,
}

#[derive(Serialize)]
struct StepStartRow {
    id: Uuid,
    execution_id: Uuid,
    parent_step_id: Option<Uuid>,
    title: String,
    category: String,
    started_at: DateTime<Utc>,
}

#[derive(Serialize)]
struct StepEndRow {
    id: Uuid,
    status: String,
    duration_ms: i32,
    error_message: Option<String>,
    ended_at: DateTime<Utc>,
}

#[derive(Serialize)]
struct TestEndRow {
    id: Uuid,
    status: String,
    duration_ms: i32,
    error_message: Option<String>,
    error_stack: Option<String>,
    error_snippet: Option<String>,
    error_cluster_hash: Option<String>,
    stdout: Vec<String>,
    stderr: Vec<String>,
    annotations: Option<AllureAnnotations>,
    ended_at: DateTime<Utc>,
}

#[derive(Serialize)]
struct ShardEndRow {
    launch_id: Uuid,
    shard_index: i32,
    status: String,
    ended_at: DateTime<Utc>,
}

struct Completed {
    launch_id: Uuid,
    status: String,
    ended_at: DateTime<Utc>,
    counters: Counters,
}

/// What a committed flush changed, used to drive live diffs.
#[derive(Default)]
struct Effects {
    launches: HashSet<Uuid>,
    /// Executions whose row changed (started or ended).
    touched: Vec<Uuid>,
    started: HashSet<Uuid>,
    ended: HashSet<Uuid>,
    /// Latest step started per execution in this flush.
    steps: HashMap<Uuid, (String, DateTime<Utc>)>,
    completed: Vec<Completed>,
}

pub struct Flusher {
    state: Arc<AppState>,
    rx: mpsc::Receiver<IngestItem>,
    shutdown: watch::Receiver<bool>,
    config: IngestConfig,
    dirty: HashSet<Uuid>,
    last_recompute: HashMap<Uuid, Instant>,
    failed_groups: HashMap<u64, AckError>,
}

impl Flusher {
    pub fn new(
        state: Arc<AppState>,
        rx: mpsc::Receiver<IngestItem>,
        shutdown: watch::Receiver<bool>,
    ) -> Self {
        let config = state.config.ingest.clone();
        Flusher {
            state,
            rx,
            shutdown,
            config,
            dirty: HashSet::new(),
            last_recompute: HashMap::new(),
            failed_groups: HashMap::new(),
        }
    }

    pub async fn run(mut self) {
        let interval = self.config.flush_interval();
        let max_events = self.config.flush_max_events.max(1);
        let mut buffer: Vec<IngestItem> = Vec::with_capacity(max_events * 2);
        loop {
            let first = tokio::select! {
                item = self.rx.recv() => item,
                _ = tokio::time::sleep(interval) => {
                    self.recompute_due(false).await;
                    continue;
                }
                _ = self.shutdown.changed() => None,
            };
            let Some(first) = first else { break };
            buffer.push(first);

            // Collect for up to one interval, or until the batch is full.
            let deadline = tokio::time::Instant::now() + interval;
            while event_count(&buffer) < max_events {
                let room = max_events - event_count(&buffer) + 1;
                match tokio::time::timeout_at(deadline, self.rx.recv_many(&mut buffer, room)).await
                {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {}
                }
            }
            self.flush(std::mem::take(&mut buffer)).await;
            self.recompute_due(false).await;
        }

        // Shutting down: the HTTP server has stopped, persist whatever is left.
        while let Ok(item) = self.rx.try_recv() {
            buffer.push(item);
        }
        if !buffer.is_empty() {
            self.flush(buffer).await;
        }
        self.recompute_due(true).await;
        tracing::info!("ingestion flusher stopped");
    }

    async fn flush(&mut self, items: Vec<IngestItem>) {
        let mut events: Vec<(u64, TelemetryEvent)> = Vec::new();
        let mut acks = Vec::new();
        for item in items {
            match item {
                IngestItem::Event { group, event } => events.push((group, *event)),
                IngestItem::Ack { group, reply } => acks.push((group, reply)),
            }
        }

        if !events.is_empty() {
            let started = Instant::now();
            match self.persist(&events).await {
                Ok(effects) => {
                    tracing::debug!(events = events.len(), elapsed = ?started.elapsed(), "flushed");
                    self.broadcast(effects).await;
                }
                Err(error) => {
                    tracing::warn!(
                        ?error,
                        events = events.len(),
                        "batch flush failed, retrying requests one by one"
                    );
                    self.persist_groups_separately(events).await;
                }
            }
        }

        for (group, reply) in acks {
            let result = match self.failed_groups.remove(&group) {
                Some(error) => Err(error),
                None => Ok(()),
            };
            let _ = reply.send(result);
        }
    }

    /// Isolates a bad request so it cannot fail the other requests sharing its flush.
    async fn persist_groups_separately(&mut self, events: Vec<(u64, TelemetryEvent)>) {
        let mut groups: Vec<(u64, Vec<(u64, TelemetryEvent)>)> = Vec::new();
        for (group, event) in events {
            match groups.iter_mut().find(|(g, _)| *g == group) {
                Some((_, list)) => list.push((group, event)),
                None => groups.push((group, vec![(group, event)])),
            }
        }
        for (group, group_events) in groups {
            match self.persist(&group_events).await {
                Ok(effects) => self.broadcast(effects).await,
                Err(error) => {
                    tracing::warn!(?error, group, "request rejected by the database");
                    self.failed_groups.insert(group, classify(&error));
                }
            }
        }
    }

    async fn persist(&self, events: &[(u64, TelemetryEvent)]) -> sqlx::Result<Effects> {
        let mut effects = Effects::default();
        let mut starts: Vec<StartRow> = Vec::new();
        let mut supersedes: Vec<SupersedeRow> = Vec::new();
        let mut step_starts: Vec<StepStartRow> = Vec::new();
        let mut step_ends: HashMap<Uuid, StepEndRow> = HashMap::new();
        let mut test_ends: HashMap<Uuid, TestEndRow> = HashMap::new();
        let mut shard_ends: HashMap<(Uuid, i32), ShardEndRow> = HashMap::new();

        for (_, event) in events {
            match event {
                TelemetryEvent::TestStart {
                    launch_id,
                    execution_id,
                    playwright_test_id,
                    title,
                    file_path,
                    line,
                    suite_path,
                    browser_project,
                    worker_index,
                    parallel_index,
                    shard_index,
                    retry_attempt,
                    annotations,
                    timestamp,
                } => {
                    effects.launches.insert(*launch_id);
                    if !effects.started.insert(*execution_id) {
                        continue;
                    }
                    effects.touched.push(*execution_id);
                    let project = clip(browser_project, 64);
                    let test_id = clip(playwright_test_id, 128);
                    starts.push(StartRow {
                        id: *execution_id,
                        launch_id: *launch_id,
                        fingerprint: test_fingerprint(file_path, suite_path, title, &project),
                        playwright_test_id: test_id.clone(),
                        title: clip(title, MAX_TITLE),
                        file_path: clip(file_path, MAX_TITLE),
                        line: *line,
                        suite_path: suite_path.iter().map(|s| clip(s, MAX_TITLE)).collect(),
                        browser_project: project,
                        worker_index: *worker_index,
                        parallel_index: *parallel_index,
                        shard_index: *shard_index,
                        retry_attempt: *retry_attempt,
                        annotations: annotations.clone(),
                        started_at: *timestamp,
                    });
                    if *retry_attempt > 0 {
                        supersedes.push(SupersedeRow {
                            launch_id: *launch_id,
                            playwright_test_id: test_id,
                            retry_attempt: *retry_attempt,
                        });
                    }
                }
                TelemetryEvent::StepStart {
                    launch_id,
                    execution_id,
                    step_id,
                    parent_step_id,
                    title,
                    category,
                    timestamp,
                } => {
                    effects.launches.insert(*launch_id);
                    effects
                        .steps
                        .insert(*execution_id, (clip(title, 500), *timestamp));
                    step_starts.push(StepStartRow {
                        id: *step_id,
                        execution_id: *execution_id,
                        parent_step_id: *parent_step_id,
                        title: clip(title, MAX_TITLE),
                        category: clip(category, 32),
                        started_at: *timestamp,
                    });
                }
                TelemetryEvent::StepEnd {
                    launch_id,
                    step_id,
                    status,
                    duration_ms,
                    error_message,
                    timestamp,
                    ..
                } => {
                    effects.launches.insert(*launch_id);
                    step_ends.insert(
                        *step_id,
                        StepEndRow {
                            id: *step_id,
                            status: clip(status, 24),
                            duration_ms: *duration_ms,
                            error_message: clip_opt(error_message, MAX_TEXT),
                            ended_at: *timestamp,
                        },
                    );
                }
                TelemetryEvent::TestEnd {
                    launch_id,
                    execution_id,
                    status,
                    duration_ms,
                    error_message,
                    error_stack,
                    error_snippet,
                    stdout,
                    stderr,
                    annotations,
                    timestamp,
                } => {
                    effects.launches.insert(*launch_id);
                    if effects.ended.insert(*execution_id)
                        && !effects.started.contains(execution_id)
                    {
                        effects.touched.push(*execution_id);
                    }
                    let hash = if is_failure(status) {
                        error_cluster_hash(error_message.as_deref(), error_stack.as_deref())
                    } else {
                        None
                    };
                    test_ends.insert(
                        *execution_id,
                        TestEndRow {
                            id: *execution_id,
                            status: clip(status, 24),
                            duration_ms: *duration_ms,
                            error_message: clip_opt(error_message, MAX_TEXT),
                            error_stack: clip_opt(error_stack, MAX_TEXT),
                            error_snippet: clip_opt(error_snippet, MAX_TEXT / 4),
                            error_cluster_hash: hash,
                            stdout: clip_output(stdout),
                            stderr: clip_output(stderr),
                            annotations: annotations.clone(),
                            ended_at: *timestamp,
                        },
                    );
                }
                TelemetryEvent::ShardEnd {
                    launch_id,
                    shard_index,
                    status,
                    timestamp,
                } => {
                    effects.launches.insert(*launch_id);
                    shard_ends.insert(
                        (*launch_id, *shard_index),
                        ShardEndRow {
                            launch_id: *launch_id,
                            shard_index: *shard_index,
                            status: clip(status.as_deref().unwrap_or("passed"), 24),
                            ended_at: *timestamp,
                        },
                    );
                }
                TelemetryEvent::LaunchInit(_) => {}
            }
        }

        let mut tx = self.state.db.begin().await?;

        if !starts.is_empty() {
            sqlx::query!(
                r#"INSERT INTO test_executions (id, launch_id, project_id, fingerprint, playwright_test_id, title, file_path,
                       line, suite_path, browser_project, worker_index, parallel_index, shard_index, retry_attempt,
                       annotations, started_at)
                   SELECT x.id, x.launch_id, l.project_id, x.fingerprint, x.playwright_test_id, x.title, x.file_path,
                          x.line, x.suite_path, x.browser_project, x.worker_index, x.parallel_index, x.shard_index,
                          x.retry_attempt, x.annotations, x.started_at
                   FROM jsonb_to_recordset($1::jsonb) AS x(id uuid, launch_id uuid, fingerprint text,
                        playwright_test_id text, title text, file_path text, line int, suite_path text[],
                        browser_project text, worker_index int, parallel_index int, shard_index int,
                        retry_attempt int, annotations jsonb, started_at timestamptz)
                   JOIN launches l ON l.id = x.launch_id
                   ON CONFLICT (id) DO NOTHING"#,
                Json(&starts) as _
            )
            .execute(&mut *tx)
            .await?;
        }

        if !supersedes.is_empty() {
            sqlx::query!(
                r#"UPDATE test_executions t SET superseded = true
                   FROM jsonb_to_recordset($1::jsonb) AS x(launch_id uuid, playwright_test_id text, retry_attempt int)
                   WHERE t.launch_id = x.launch_id AND t.playwright_test_id = x.playwright_test_id
                     AND t.retry_attempt < x.retry_attempt AND NOT t.superseded"#,
                Json(&supersedes) as _
            )
            .execute(&mut *tx)
            .await?;
        }

        if !step_starts.is_empty() {
            let batch_ids: Vec<Uuid> = step_starts.iter().map(|s| s.id).collect();
            // Steps of unknown executions are dropped and unknown parents become roots,
            // so one odd event cannot fail the whole batch.
            sqlx::query!(
                r#"INSERT INTO test_steps (id, execution_id, parent_step_id, title, category, started_at)
                   SELECT x.id, x.execution_id,
                          CASE WHEN x.parent_step_id IS NULL THEN NULL
                               WHEN x.parent_step_id = ANY($2::uuid[]) THEN x.parent_step_id
                               WHEN EXISTS (SELECT 1 FROM test_steps p WHERE p.id = x.parent_step_id) THEN x.parent_step_id
                          END,
                          x.title, x.category, x.started_at
                   FROM jsonb_to_recordset($1::jsonb) AS x(id uuid, execution_id uuid, parent_step_id uuid, title text,
                        category text, started_at timestamptz)
                   WHERE EXISTS (SELECT 1 FROM test_executions e WHERE e.id = x.execution_id)
                   ON CONFLICT (id) DO NOTHING"#,
                Json(&step_starts) as _,
                &batch_ids
            )
            .execute(&mut *tx)
            .await?;
        }

        if !step_ends.is_empty() {
            let rows: Vec<&StepEndRow> = step_ends.values().collect();
            sqlx::query!(
                r#"UPDATE test_steps s SET status = x.status, duration_ms = x.duration_ms,
                       error_message = x.error_message, ended_at = x.ended_at
                   FROM jsonb_to_recordset($1::jsonb) AS x(id uuid, status text, duration_ms int, error_message text,
                        ended_at timestamptz)
                   WHERE s.id = x.id"#,
                Json(&rows) as _
            )
            .execute(&mut *tx)
            .await?;
        }

        if !test_ends.is_empty() {
            let rows: Vec<&TestEndRow> = test_ends.values().collect();
            sqlx::query!(
                r#"UPDATE test_executions t SET
                       status = CASE WHEN x.status = 'passed' AND t.retry_attempt > 0 THEN 'flaky' ELSE x.status END,
                       duration_ms = x.duration_ms, error_message = x.error_message, error_stack = x.error_stack,
                       error_snippet = x.error_snippet, error_cluster_hash = x.error_cluster_hash,
                       stdout = x.stdout, stderr = x.stderr, ended_at = x.ended_at,
                       annotations = COALESCE(x.annotations, t.annotations)
                   FROM jsonb_to_recordset($1::jsonb) AS x(id uuid, status text, duration_ms int, error_message text,
                        error_stack text, error_snippet text, error_cluster_hash text, stdout text[], stderr text[],
                        annotations jsonb, ended_at timestamptz)
                   WHERE t.id = x.id"#,
                Json(&rows) as _
            )
            .execute(&mut *tx)
            .await?;
            // Steps still open when the test ended (filtered or aborted) are closed with it.
            let ended_ids: Vec<Uuid> = test_ends.keys().copied().collect();
            sqlx::query!(
                r#"UPDATE test_steps s SET status = CASE WHEN e.status IN ('passed', 'flaky') THEN 'passed' ELSE 'interrupted' END,
                       ended_at = e.ended_at
                   FROM test_executions e
                   WHERE s.execution_id = e.id AND e.id = ANY($1) AND s.ended_at IS NULL"#,
                &ended_ids
            )
            .execute(&mut *tx)
            .await?;
        }

        if !shard_ends.is_empty() {
            let rows: Vec<&ShardEndRow> = shard_ends.values().collect();
            sqlx::query!(
                r#"INSERT INTO launch_shards (launch_id, shard_index, status, ended_at)
                   SELECT x.launch_id, x.shard_index, x.status, x.ended_at
                   FROM jsonb_to_recordset($1::jsonb) AS x(launch_id uuid, shard_index int, status text, ended_at timestamptz)
                   JOIN launches l ON l.id = x.launch_id
                   ON CONFLICT (launch_id, shard_index) DO UPDATE SET status = EXCLUDED.status, ended_at = EXCLUDED.ended_at"#,
                Json(&rows) as _
            )
            .execute(&mut *tx)
            .await?;

            let launch_ids: HashSet<Uuid> =
                shard_ends.keys().map(|(launch_id, _)| *launch_id).collect();
            for launch_id in launch_ids {
                let Some(total_shards) = sqlx::query_scalar!(
                    "SELECT total_shards FROM launches WHERE id = $1 FOR UPDATE",
                    launch_id
                )
                .fetch_optional(&mut *tx)
                .await?
                else {
                    continue;
                };
                let shards = sqlx::query!(
                    r#"SELECT count(*) FILTER (WHERE ended_at IS NOT NULL)::int AS "done!",
                              COALESCE(bool_or(status IN ('interrupted', 'timedout')), false) AS "interrupted!",
                              COALESCE(bool_or(status = 'failed'), false) AS "failed!",
                              max(ended_at) AS ended_at
                       FROM launch_shards WHERE launch_id = $1"#,
                    launch_id
                )
                .fetch_one(&mut *tx)
                .await?;
                sqlx::query!(
                    "UPDATE launches SET completed_shards = $2 WHERE id = $1",
                    launch_id,
                    shards.done
                )
                .execute(&mut *tx)
                .await?;
                if shards.done >= total_shards {
                    let ended_at = shards.ended_at.unwrap_or_else(Utc::now);
                    let (status, counters) = db::finalize_launch(
                        &mut tx,
                        launch_id,
                        shards.interrupted,
                        shards.failed,
                        ended_at,
                    )
                    .await?;
                    effects.completed.push(Completed {
                        launch_id,
                        status,
                        ended_at,
                        counters,
                    });
                }
            }
        }

        let launch_ids: Vec<Uuid> = effects.launches.iter().copied().collect();
        sqlx::query!(
            "UPDATE launches SET last_event_at = now() WHERE id = ANY($1)",
            &launch_ids
        )
        .execute(&mut *tx)
        .await?;

        tx.commit().await?;
        Ok(effects)
    }

    async fn broadcast(&mut self, effects: Effects) {
        let live = &self.state.live;
        for launch_id in &effects.launches {
            self.dirty.insert(*launch_id);
        }
        for done in &effects.completed {
            self.dirty.remove(&done.launch_id);
            live.publish(
                done.launch_id,
                &counters_diff(done.launch_id, done.counters),
            );
            live.publish(
                done.launch_id,
                &SseStateDiff::LaunchCompleted {
                    launch_id: done.launch_id,
                    status: done.status.clone(),
                    ended_at: done.ended_at,
                },
            );
        }

        // Rows are only re-read when someone is watching.
        if !effects.launches.iter().any(|id| live.has_subscribers(*id)) {
            return;
        }
        let mut ids = effects.touched.clone();
        ids.extend(
            effects
                .steps
                .keys()
                .filter(|id| !effects.started.contains(id) && !effects.ended.contains(id)),
        );
        if ids.is_empty() {
            return;
        }
        let rows = match db::fetch_executions(&self.state.db, &ids).await {
            Ok(rows) => rows,
            Err(error) => {
                tracing::warn!(?error, "failed to load rows for live diffs");
                return;
            }
        };
        let touched: HashSet<Uuid> = effects.touched.iter().copied().collect();
        for row in rows {
            let launch_id = row.launch_id;
            if !live.has_subscribers(launch_id) {
                continue;
            }
            let worker_id = format!("shard-{}-worker-{}", row.shard_index, row.parallel_index);
            let activity = if effects.ended.contains(&row.id) {
                Some(SseStateDiff::WorkerActivity {
                    worker_id,
                    execution_id: Some(row.id),
                    test_title: Some(row.title.clone()),
                    current_step: None,
                    status: "idle".into(),
                    started_at: row.ended_at.unwrap_or_else(Utc::now),
                })
            } else if row.status == "running" {
                let step = effects.steps.get(&row.id);
                Some(SseStateDiff::WorkerActivity {
                    worker_id,
                    execution_id: Some(row.id),
                    test_title: Some(row.title.clone()),
                    current_step: step.map(|(title, _)| title.clone()),
                    status: "running".into(),
                    started_at: step.map_or(row.started_at, |(_, at)| *at),
                })
            } else {
                None
            };
            if touched.contains(&row.id) {
                live.publish(
                    launch_id,
                    &SseStateDiff::TestRowUpdated(Box::new(row.into_row(Vec::new(), None))),
                );
            }
            if let Some(activity) = activity {
                live.publish(launch_id, &activity);
            }
        }
    }

    /// Recomputes counters for launches changed since their last recomputation,
    /// at most once per `COUNTERS_INTERVAL_MS` each.
    async fn recompute_due(&mut self, force: bool) {
        if self.dirty.is_empty() {
            return;
        }
        let now = Instant::now();
        let interval = self.config.counters_interval();
        let due: Vec<Uuid> = self
            .dirty
            .iter()
            .filter(|id| {
                force
                    || self
                        .last_recompute
                        .get(id)
                        .is_none_or(|at| now.duration_since(*at) >= interval)
            })
            .copied()
            .collect();
        for launch_id in due {
            self.dirty.remove(&launch_id);
            self.last_recompute.insert(launch_id, now);
            let result = match self.state.db.acquire().await {
                Ok(mut conn) => db::recompute_counters(&mut conn, launch_id).await,
                Err(error) => Err(error),
            };
            match result {
                Ok(Some(counters)) => self
                    .state
                    .live
                    .publish(launch_id, &counters_diff(launch_id, counters)),
                Ok(None) => {}
                Err(error) => {
                    tracing::warn!(?error, %launch_id, "counter recomputation failed");
                    self.dirty.insert(launch_id);
                }
            }
        }
        self.last_recompute
            .retain(|_, at| now.duration_since(*at) < Duration::from_secs(600));
    }
}

fn event_count(items: &[IngestItem]) -> usize {
    items
        .iter()
        .filter(|item| matches!(item, IngestItem::Event { .. }))
        .count()
}

pub fn counters_diff(launch_id: Uuid, c: Counters) -> SseStateDiff {
    SseStateDiff::CountersUpdated {
        launch_id,
        total_tests: c.total_tests,
        passed: c.passed,
        failed: c.failed,
        flaky: c.flaky,
        skipped: c.skipped,
        running: c.running,
    }
}

/// Data and constraint errors (SQLSTATE classes 22 and 23) will fail again on retry.
fn classify(error: &sqlx::Error) -> AckError {
    if let sqlx::Error::Database(db_error) = error
        && let Some(code) = db_error.code()
        && (code.starts_with("22") || code.starts_with("23"))
    {
        return AckError::Rejected(format!("events rejected: {}", db_error.message()));
    }
    AckError::Unavailable("database unavailable, retry shortly".into())
}

/// Marks launches that stopped reporting (crashed CI job, killed runner) as interrupted.
pub async fn run_maintenance(state: Arc<AppState>, mut shutdown: watch::Receiver<bool>) {
    let mut ticker = tokio::time::interval(Duration::from_secs(60));
    loop {
        tokio::select! {
            _ = ticker.tick() => {}
            _ = shutdown.changed() => return,
        }
        state.live.prune();
        if let Err(error) = reap_stale_launches(&state).await {
            tracing::warn!(?error, "stale launch cleanup failed");
        }
    }
}

pub async fn reap_stale_launches(state: &AppState) -> sqlx::Result<usize> {
    let minutes = state.config.ingest.stale_launch_minutes;
    let stale = sqlx::query!(
        r#"SELECT id, last_event_at FROM launches
           WHERE status = 'running' AND last_event_at < now() - make_interval(mins => $1::int)"#,
        minutes as i32
    )
    .fetch_all(&state.db)
    .await?;
    for launch in &stale {
        let mut tx = state.db.begin().await?;
        let (status, counters) =
            db::finalize_launch(&mut tx, launch.id, true, false, launch.last_event_at).await?;
        tx.commit().await?;
        tracing::info!(launch_id = %launch.id, "marked stale launch as interrupted");
        state
            .live
            .publish(launch.id, &counters_diff(launch.id, counters));
        state.live.publish(
            launch.id,
            &SseStateDiff::LaunchCompleted {
                launch_id: launch.id,
                status,
                ended_at: launch.last_event_at,
            },
        );
    }
    Ok(stale.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clip_respects_char_boundaries() {
        assert_eq!(clip("héllo", 2), "h…");
        assert_eq!(clip("short", 10), "short");
    }

    #[test]
    fn output_is_capped() {
        let chunk = "x".repeat(200 * 1024);
        let out = clip_output(&[chunk.clone(), chunk]);
        let total: usize = out.iter().map(String::len).sum();
        assert!(total <= MAX_OUTPUT + 64);
        assert!(out.last().unwrap().contains("truncated"));
    }
}
