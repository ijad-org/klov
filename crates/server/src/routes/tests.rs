use std::collections::HashMap;
use std::sync::Arc;

use axum::Json;
use axum::extract::{Path, Query, State};
use chrono::{DateTime, Utc};
use klovplay_schema::{
    AllureAnnotations, ArtifactInfo, AttemptRef, ExecutionDetail, HistoryDot, StepNode, TestPage,
};
use serde::Deserialize;
use sqlx::types::Json as SqlJson;
use uuid::Uuid;

use crate::db::{self, ExecutionRecord};
use crate::error::{AppError, AppResult};
use crate::retry::{RetryTarget, retry_command};
use crate::state::AppState;

const DEFAULT_PAGE: i64 = 1000;
const MAX_PAGE: i64 = 5000;

#[derive(Deserialize)]
pub struct ListTestsQuery {
    cursor: Option<String>,
    limit: Option<i64>,
    status: Option<String>,
}

/// `GET /api/v1/launches/{id}/tests`: the latest attempt of every test, each with
/// its last 10 results from earlier launches and their average duration.
pub async fn list_tests(
    State(state): State<Arc<AppState>>,
    Path(launch_id): Path<Uuid>,
    Query(query): Query<ListTestsQuery>,
) -> AppResult<Json<TestPage>> {
    let limit = query.limit.unwrap_or(DEFAULT_PAGE).clamp(1, MAX_PAGE);
    let offset = match query.cursor.as_deref() {
        Some(cursor) => cursor
            .parse::<i64>()
            .map_err(|_| AppError::BadRequest("invalid cursor".into()))?
            .max(0),
        None => 0,
    };
    let rows = sqlx::query!(
        r#"SELECT e.id, e.launch_id, e.playwright_test_id, e.fingerprint, e.title, e.file_path, e.line, e.suite_path,
                  e.browser_project, e.worker_index, e.parallel_index, e.shard_index, e.retry_attempt, e.status,
                  e.duration_ms, e.error_message, e.error_cluster_hash,
                  e.annotations AS "annotations: SqlJson<AllureAnnotations>", e.started_at, e.ended_at,
                  h.history AS "history?: SqlJson<Vec<HistoryDot>>", h.avg_duration_ms AS "avg_duration_ms?"
           FROM test_executions e
           LEFT JOIN LATERAL (
               SELECT json_agg(json_build_object('launch_id', p.launch_id, 'execution_id', p.id,
                                                 'status', p.status, 'duration_ms', p.duration_ms)
                               ORDER BY p.started_at DESC) AS history,
                      (avg(p.duration_ms) FILTER (WHERE p.status IN ('passed', 'flaky')))::int AS avg_duration_ms
               FROM (SELECT id, launch_id, status, duration_ms, started_at
                     FROM test_executions p
                     WHERE p.project_id = e.project_id AND p.fingerprint = e.fingerprint
                       AND p.launch_id <> e.launch_id AND p.started_at < e.started_at
                       AND NOT p.superseded AND p.status <> 'running'
                     ORDER BY p.started_at DESC LIMIT 10) p
           ) h ON true
           WHERE e.launch_id = $1 AND NOT e.superseded AND ($2::text IS NULL OR e.status = $2)
           ORDER BY e.file_path, e.line, e.browser_project, e.id
           LIMIT $3 OFFSET $4"#,
        launch_id,
        query.status,
        limit,
        offset
    )
    .fetch_all(&state.db)
    .await?;

    let next_cursor = (rows.len() as i64 == limit).then(|| (offset + limit).to_string());
    let tests = rows
        .into_iter()
        .map(|r| {
            ExecutionRecord {
                id: r.id,
                launch_id: r.launch_id,
                playwright_test_id: r.playwright_test_id,
                fingerprint: r.fingerprint,
                title: r.title,
                file_path: r.file_path,
                line: r.line,
                suite_path: r.suite_path,
                browser_project: r.browser_project,
                worker_index: r.worker_index,
                parallel_index: r.parallel_index,
                shard_index: r.shard_index,
                retry_attempt: r.retry_attempt,
                status: r.status,
                duration_ms: r.duration_ms,
                error_message: r.error_message,
                error_cluster_hash: r.error_cluster_hash,
                annotations: r.annotations,
                started_at: r.started_at,
                ended_at: r.ended_at,
            }
            .into_row(
                r.history.map(|h| h.0).unwrap_or_default(),
                r.avg_duration_ms,
            )
        })
        .collect();
    Ok(Json(TestPage { tests, next_cursor }))
}

struct StepRecord {
    id: Uuid,
    parent_step_id: Option<Uuid>,
    title: String,
    category: String,
    status: String,
    duration_ms: Option<i32>,
    error_message: Option<String>,
    started_at: DateTime<Utc>,
}

/// Assembles the flat step list (ordered by start time) into a tree.
fn build_step_tree(records: Vec<StepRecord>) -> Vec<StepNode> {
    let known: std::collections::HashSet<Uuid> = records.iter().map(|r| r.id).collect();
    let mut children: HashMap<Option<Uuid>, Vec<StepRecord>> = HashMap::new();
    for record in records {
        let parent = record.parent_step_id.filter(|p| known.contains(p));
        children.entry(parent).or_default().push(record);
    }
    fn assemble(
        parent: Option<Uuid>,
        children: &mut HashMap<Option<Uuid>, Vec<StepRecord>>,
    ) -> Vec<StepNode> {
        let Some(records) = children.remove(&parent) else {
            return Vec::new();
        };
        records
            .into_iter()
            .map(|r| StepNode {
                children: assemble(Some(r.id), children),
                id: r.id,
                title: r.title,
                category: r.category,
                status: r.status,
                duration_ms: r.duration_ms,
                error_message: r.error_message,
                started_at: r.started_at,
            })
            .collect()
    }
    assemble(None, &mut children)
}

/// `GET /api/v1/executions/{id}`
pub async fn get_execution(
    State(state): State<Arc<AppState>>,
    Path(execution_id): Path<Uuid>,
) -> AppResult<Json<ExecutionDetail>> {
    let row = sqlx::query!(
        r#"SELECT id, launch_id, project_id, playwright_test_id, fingerprint, title, file_path, line, suite_path,
                  browser_project, worker_index, parallel_index, shard_index, retry_attempt, status, duration_ms,
                  error_message, error_cluster_hash, annotations AS "annotations: SqlJson<AllureAnnotations>",
                  started_at, ended_at, error_stack, error_snippet, stdout, stderr
           FROM test_executions WHERE id = $1"#,
        execution_id
    )
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::NotFound)?;

    let history = sqlx::query!(
        r#"SELECT id, launch_id, status, duration_ms FROM test_executions
           WHERE project_id = $1 AND fingerprint = $2 AND launch_id <> $3 AND started_at < $4
             AND NOT superseded AND status <> 'running'
           ORDER BY started_at DESC LIMIT 10"#,
        row.project_id,
        row.fingerprint,
        row.launch_id,
        row.started_at
    )
    .fetch_all(&state.db)
    .await?;
    let passing: Vec<i32> = history
        .iter()
        .filter(|h| h.status == "passed" || h.status == "flaky")
        .filter_map(|h| h.duration_ms)
        .collect();
    let avg_duration_ms = (!passing.is_empty())
        .then(|| (passing.iter().map(|d| *d as i64).sum::<i64>() / passing.len() as i64) as i32);
    let history = history
        .into_iter()
        .map(|h| HistoryDot {
            launch_id: h.launch_id,
            execution_id: h.id,
            status: h.status,
            duration_ms: h.duration_ms.map(i64::from),
        })
        .collect();

    let steps = sqlx::query_as!(
        StepRecord,
        r#"SELECT id, parent_step_id, title, category, status, duration_ms, error_message, started_at
           FROM test_steps WHERE execution_id = $1 ORDER BY started_at, id"#,
        execution_id
    )
    .fetch_all(&state.db)
    .await?;

    let artifact_rows = sqlx::query!(
        r#"SELECT id, name, content_type, s3_key, size_bytes, file_name, uploaded_at
           FROM artifacts WHERE execution_id = $1 ORDER BY created_at, name"#,
        execution_id
    )
    .fetch_all(&state.db)
    .await?;
    let mut artifacts = Vec::with_capacity(artifact_rows.len());
    for a in artifact_rows {
        let url = match a.uploaded_at {
            Some(_) => Some(
                state
                    .storage
                    .presign_get(&a.s3_key, &a.content_type, a.file_name.as_deref())
                    .await?,
            ),
            None => None,
        };
        artifacts.push(ArtifactInfo {
            id: a.id,
            name: a.name,
            content_type: a.content_type,
            size_bytes: a.size_bytes,
            file_name: a.file_name,
            uploaded: a.uploaded_at.is_some(),
            url,
        });
    }

    let attempts = sqlx::query_as!(
        AttemptRef,
        r#"SELECT id AS execution_id, retry_attempt, status, duration_ms FROM test_executions
           WHERE launch_id = $1 AND playwright_test_id = $2 ORDER BY retry_attempt"#,
        row.launch_id,
        row.playwright_test_id
    )
    .fetch_all(&state.db)
    .await?;

    let launch = db::fetch_launch(&state.db, row.launch_id)
        .await?
        .ok_or(AppError::NotFound)?;
    let retry = retry_command([RetryTarget {
        file_path: &row.file_path,
        line: row.line,
        browser_project: &row.browser_project,
    }])
    .unwrap_or_default();

    let test = ExecutionRecord {
        id: row.id,
        launch_id: row.launch_id,
        playwright_test_id: row.playwright_test_id,
        fingerprint: row.fingerprint,
        title: row.title,
        file_path: row.file_path,
        line: row.line,
        suite_path: row.suite_path,
        browser_project: row.browser_project,
        worker_index: row.worker_index,
        parallel_index: row.parallel_index,
        shard_index: row.shard_index,
        retry_attempt: row.retry_attempt,
        status: row.status,
        duration_ms: row.duration_ms,
        error_message: row.error_message,
        error_cluster_hash: row.error_cluster_hash,
        annotations: row.annotations,
        started_at: row.started_at,
        ended_at: row.ended_at,
    }
    .into_row(history, avg_duration_ms);

    Ok(Json(ExecutionDetail {
        test,
        error_stack: row.error_stack,
        error_snippet: row.error_snippet,
        stdout: row.stdout,
        stderr: row.stderr,
        steps: build_step_tree(steps),
        artifacts,
        attempts,
        launch,
        retry_command: retry,
    }))
}

#[cfg(test)]
mod step_tree_tests {
    use super::*;

    fn step(id: u128, parent: Option<u128>, title: &str) -> StepRecord {
        StepRecord {
            id: Uuid::from_u128(id),
            parent_step_id: parent.map(Uuid::from_u128),
            title: title.into(),
            category: "test.step".into(),
            status: "passed".into(),
            duration_ms: Some(1),
            error_message: None,
            started_at: Utc::now(),
        }
    }

    #[test]
    fn builds_nested_tree_and_promotes_orphans() {
        let tree = build_step_tree(vec![
            step(1, None, "login"),
            step(2, Some(1), "fill form"),
            step(3, Some(2), "type password"),
            step(4, Some(99), "orphan"),
            step(5, None, "checkout"),
        ]);
        let titles: Vec<&str> = tree.iter().map(|n| n.title.as_str()).collect();
        assert_eq!(titles, ["login", "orphan", "checkout"]);
        assert_eq!(tree[0].children[0].children[0].title, "type password");
    }
}
