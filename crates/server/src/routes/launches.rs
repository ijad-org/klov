use std::collections::HashMap;
use std::sync::Arc;

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use chrono::Utc;
use klovplay_schema::{
    ClusterTest, FailureCluster, LaunchDetail, LaunchInit, LaunchInitResponse, LaunchSummary,
    WorkerState,
};
use serde::Deserialize;
use uuid::Uuid;

use crate::auth::ProjectAuth;
use crate::db::{self, LaunchRecord};
use crate::error::{AppError, AppResult};
use crate::fingerprint::{signature, strip_ansi};
use crate::flusher::counters_diff;
use crate::retry::{RetryTarget, retry_command};
use crate::routes::projects::project_id_by_slug;
use crate::state::AppState;

fn clip_field(value: Option<String>, max: usize) -> Option<String> {
    value
        .map(|v| v.chars().take(max).collect::<String>())
        .filter(|v| !v.is_empty())
}

/// `POST /api/v1/launches/init`
///
/// Shard-aware upsert: every shard reporting the same `ci_run_id` joins one launch.
/// Re-initializing a finished launch (a re-run of a shard) reopens it.
pub async fn init_launch(
    State(state): State<Arc<AppState>>,
    auth: ProjectAuth,
    Json(init): Json<LaunchInit>,
) -> AppResult<Json<LaunchInitResponse>> {
    if init.project_slug != auth.slug {
        return Err(AppError::Forbidden(format!(
            "this API key belongs to project '{}'",
            auth.slug
        )));
    }
    if init.ci_run_id.is_empty() || init.ci_run_id.len() > 128 {
        return Err(AppError::BadRequest(
            "ci_run_id must be 1-128 characters".into(),
        ));
    }
    if init.total_shards < 1 || init.shard_index < 1 || init.shard_index > init.total_shards {
        return Err(AppError::BadRequest(
            "shard_index must be between 1 and total_shards".into(),
        ));
    }

    let mut tx = state.db.begin().await?;
    let launch_id = sqlx::query_scalar!(
        r#"INSERT INTO launches (project_id, ci_run_id, build_number, branch, commit_sha, total_shards, started_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (project_id, ci_run_id) DO UPDATE SET
               total_shards = GREATEST(launches.total_shards, EXCLUDED.total_shards),
               build_number = COALESCE(launches.build_number, EXCLUDED.build_number),
               branch = COALESCE(launches.branch, EXCLUDED.branch),
               commit_sha = COALESCE(launches.commit_sha, EXCLUDED.commit_sha),
               started_at = LEAST(launches.started_at, EXCLUDED.started_at),
               status = 'running', ended_at = NULL, last_event_at = now()
           RETURNING id"#,
        auth.project_id,
        init.ci_run_id,
        clip_field(init.build_number, 64),
        clip_field(init.branch, 128),
        clip_field(init.commit_sha, 64),
        init.total_shards,
        init.timestamp
    )
    .fetch_one(&mut *tx)
    .await?;
    sqlx::query!(
        r#"INSERT INTO launch_shards (launch_id, shard_index, total_tests, started_at) VALUES ($1, $2, $3, $4)
           ON CONFLICT (launch_id, shard_index) DO UPDATE SET
               total_tests = EXCLUDED.total_tests, started_at = EXCLUDED.started_at, status = NULL, ended_at = NULL"#,
        launch_id,
        init.shard_index,
        init.shard_total_tests.max(0),
        init.timestamp
    )
    .execute(&mut *tx)
    .await?;
    sqlx::query!(
        "UPDATE launches SET completed_shards =
             (SELECT count(*)::int FROM launch_shards WHERE launch_id = $1 AND ended_at IS NOT NULL)
         WHERE id = $1",
        launch_id
    )
    .execute(&mut *tx)
    .await?;
    let counters = db::recompute_counters(&mut tx, launch_id).await?;
    tx.commit().await?;

    state.launch_owners.insert(launch_id, auth.project_id);
    if let Some(counters) = counters {
        state
            .live
            .publish(launch_id, &counters_diff(launch_id, counters));
    }
    Ok(Json(LaunchInitResponse {
        launch_id,
        project_id: auth.project_id,
        dashboard_url: state
            .config
            .dashboard_url(&format!("projects/{}/launches/{launch_id}", auth.slug)),
    }))
}

/// `POST /api/v1/launches/{id}/heartbeat`: keeps a launch with long, quiet tests from being marked stale.
pub async fn heartbeat(
    State(state): State<Arc<AppState>>,
    auth: ProjectAuth,
    Path(launch_id): Path<Uuid>,
) -> AppResult<StatusCode> {
    auth.check_launches(&state, &[launch_id]).await?;
    sqlx::query!(
        "UPDATE launches SET last_event_at = now() WHERE id = $1 AND status = 'running'",
        launch_id
    )
    .execute(&state.db)
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub struct ListLaunchesQuery {
    limit: Option<i64>,
    offset: Option<i64>,
}

/// `GET /api/v1/projects/{slug}/launches`
pub async fn list_launches(
    State(state): State<Arc<AppState>>,
    Path(slug): Path<String>,
    Query(query): Query<ListLaunchesQuery>,
) -> AppResult<Json<Vec<LaunchSummary>>> {
    let project_id = project_id_by_slug(&state.db, &slug).await?;
    let limit = query.limit.unwrap_or(50).clamp(1, 500);
    let offset = query.offset.unwrap_or(0).max(0);
    let launches = sqlx::query_as!(
        LaunchRecord,
        r#"SELECT l.id, l.project_id, p.slug AS project_slug, l.ci_run_id, l.build_number, l.branch, l.commit_sha,
                  l.status, l.total_tests, l.passed_count, l.failed_count, l.flaky_count, l.skipped_count,
                  l.running_count, l.total_shards, l.completed_shards, l.started_at, l.ended_at,
                  (EXTRACT(EPOCH FROM (l.ended_at - l.started_at)) * 1000)::bigint AS "duration_ms?"
           FROM launches l JOIN projects p ON p.id = l.project_id
           WHERE l.project_id = $1
           ORDER BY l.started_at DESC
           LIMIT $2 OFFSET $3"#,
        project_id,
        limit,
        offset
    )
    .fetch_all(&state.db)
    .await?;
    Ok(Json(launches.into_iter().map(Into::into).collect()))
}

/// `GET /api/v1/launches/{id}`: summary, worker lanes and failure clusters.
pub async fn get_launch(
    State(state): State<Arc<AppState>>,
    Path(launch_id): Path<Uuid>,
) -> AppResult<Json<LaunchDetail>> {
    let launch = db::fetch_launch(&state.db, launch_id)
        .await?
        .ok_or(AppError::NotFound)?;
    let workers = load_workers(&state, &launch).await?;
    let (clusters, retry) = load_failures(&state, launch_id).await?;
    Ok(Json(LaunchDetail {
        launch,
        workers,
        clusters,
        retry_command: retry,
    }))
}

async fn load_workers(state: &AppState, launch: &LaunchSummary) -> AppResult<Vec<WorkerState>> {
    // The latest execution in each (shard, parallel slot) lane tells what that worker is doing.
    let lanes = sqlx::query!(
        r#"SELECT DISTINCT ON (shard_index, parallel_index)
                  id, shard_index, parallel_index, title, status, started_at, ended_at
           FROM test_executions WHERE launch_id = $1
           ORDER BY shard_index, parallel_index, started_at DESC"#,
        launch.id
    )
    .fetch_all(&state.db)
    .await?;
    let running: Vec<Uuid> = lanes
        .iter()
        .filter(|l| l.status == "running")
        .map(|l| l.id)
        .collect();
    let mut steps: HashMap<Uuid, (String, chrono::DateTime<Utc>)> = HashMap::new();
    if !running.is_empty() {
        let open = sqlx::query!(
            r#"SELECT DISTINCT ON (execution_id) execution_id, title, started_at
               FROM test_steps WHERE execution_id = ANY($1) AND ended_at IS NULL
               ORDER BY execution_id, started_at DESC"#,
            &running
        )
        .fetch_all(&state.db)
        .await?;
        steps.extend(
            open.into_iter()
                .map(|s| (s.execution_id, (s.title, s.started_at))),
        );
    }
    Ok(lanes
        .into_iter()
        .map(|lane| {
            let busy = lane.status == "running" && launch.status == "running";
            let step = if busy { steps.remove(&lane.id) } else { None };
            WorkerState {
                worker_id: format!("shard-{}-worker-{}", lane.shard_index, lane.parallel_index),
                shard_index: lane.shard_index,
                parallel_index: lane.parallel_index,
                execution_id: Some(lane.id),
                test_title: Some(lane.title),
                started_at: match (&step, busy) {
                    (Some((_, at)), _) => *at,
                    (None, true) => lane.started_at,
                    (None, false) => lane.ended_at.unwrap_or(lane.started_at),
                },
                current_step: step.map(|(title, _)| title),
                status: if busy { "running" } else { "idle" }.into(),
            }
        })
        .collect())
}

async fn load_failures(
    state: &AppState,
    launch_id: Uuid,
) -> AppResult<(Vec<FailureCluster>, Option<String>)> {
    let failing = sqlx::query!(
        r#"SELECT id, title, file_path, line, browser_project, status, error_cluster_hash, error_message, error_stack
           FROM test_executions
           WHERE launch_id = $1 AND NOT superseded AND status IN ('failed', 'timedOut', 'interrupted')
           ORDER BY started_at"#,
        launch_id
    )
    .fetch_all(&state.db)
    .await?;

    let launch_retry = retry_command(failing.iter().map(|f| RetryTarget {
        file_path: &f.file_path,
        line: f.line,
        browser_project: &f.browser_project,
    }));

    let mut clusters: Vec<FailureCluster> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    for failure in &failing {
        let Some(hash) = &failure.error_cluster_hash else {
            continue;
        };
        let position = *index.entry(hash.clone()).or_insert_with(|| {
            let message = failure.error_message.clone().unwrap_or_default();
            clusters.push(FailureCluster {
                error_cluster_hash: hash.clone(),
                signature: signature(&message),
                message: strip_ansi(&message),
                sample_stack: failure.error_stack.as_deref().map(strip_ansi),
                count: 0,
                browser_projects: Vec::new(),
                tests: Vec::new(),
                retry_command: String::new(),
            });
            clusters.len() - 1
        });
        let cluster = &mut clusters[position];
        cluster.count += 1;
        if !cluster.browser_projects.contains(&failure.browser_project) {
            cluster
                .browser_projects
                .push(failure.browser_project.clone());
        }
        cluster.tests.push(ClusterTest {
            execution_id: failure.id,
            title: failure.title.clone(),
            file_path: failure.file_path.clone(),
            line: failure.line,
            browser_project: failure.browser_project.clone(),
            status: failure.status.clone(),
        });
    }
    for cluster in &mut clusters {
        cluster.retry_command = retry_command(cluster.tests.iter().map(|t| RetryTarget {
            file_path: &t.file_path,
            line: t.line,
            browser_project: &t.browser_project,
        }))
        .unwrap_or_default();
    }
    clusters.sort_by_key(|c| std::cmp::Reverse(c.count));
    Ok((clusters, launch_retry))
}
