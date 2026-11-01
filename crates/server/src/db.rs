//! Typed rows shared by several queries, and their mapping to API models.

use chrono::{DateTime, Utc};
use klovplay_schema::{AllureAnnotations, HistoryDot, LaunchSummary, TestRow};
use sqlx::types::Json;
use sqlx::{PgConnection, PgPool};
use uuid::Uuid;

pub struct LaunchRecord {
    pub id: Uuid,
    pub project_id: Uuid,
    pub project_slug: String,
    pub ci_run_id: String,
    pub build_number: Option<String>,
    pub branch: Option<String>,
    pub commit_sha: Option<String>,
    pub status: String,
    pub total_tests: i32,
    pub passed_count: i32,
    pub failed_count: i32,
    pub flaky_count: i32,
    pub skipped_count: i32,
    pub running_count: i32,
    pub total_shards: i32,
    pub completed_shards: i32,
    pub started_at: DateTime<Utc>,
    pub ended_at: Option<DateTime<Utc>>,
    pub duration_ms: Option<i64>,
}

impl From<LaunchRecord> for LaunchSummary {
    fn from(r: LaunchRecord) -> Self {
        LaunchSummary {
            id: r.id,
            project_id: r.project_id,
            project_slug: r.project_slug,
            ci_run_id: r.ci_run_id,
            build_number: r.build_number,
            branch: r.branch,
            commit_sha: r.commit_sha,
            status: r.status,
            total_tests: r.total_tests,
            passed_count: r.passed_count,
            failed_count: r.failed_count,
            flaky_count: r.flaky_count,
            skipped_count: r.skipped_count,
            running_count: r.running_count,
            total_shards: r.total_shards,
            completed_shards: r.completed_shards,
            started_at: r.started_at,
            ended_at: r.ended_at,
            duration_ms: r.duration_ms,
        }
    }
}

pub async fn fetch_launch(db: &PgPool, launch_id: Uuid) -> sqlx::Result<Option<LaunchSummary>> {
    let record = sqlx::query_as!(
        LaunchRecord,
        r#"SELECT l.id, l.project_id, p.slug AS project_slug, l.ci_run_id, l.build_number, l.branch, l.commit_sha,
                  l.status, l.total_tests, l.passed_count, l.failed_count, l.flaky_count, l.skipped_count,
                  l.running_count, l.total_shards, l.completed_shards, l.started_at, l.ended_at,
                  (EXTRACT(EPOCH FROM (l.ended_at - l.started_at)) * 1000)::bigint AS "duration_ms?"
           FROM launches l JOIN projects p ON p.id = l.project_id
           WHERE l.id = $1"#,
        launch_id
    )
    .fetch_optional(db)
    .await?;
    Ok(record.map(Into::into))
}

pub struct ExecutionRecord {
    pub id: Uuid,
    pub launch_id: Uuid,
    pub playwright_test_id: String,
    pub fingerprint: String,
    pub title: String,
    pub file_path: String,
    pub line: i32,
    pub suite_path: Vec<String>,
    pub browser_project: String,
    pub worker_index: i32,
    pub parallel_index: i32,
    pub shard_index: i32,
    pub retry_attempt: i32,
    pub status: String,
    pub duration_ms: Option<i32>,
    pub error_message: Option<String>,
    pub error_cluster_hash: Option<String>,
    pub annotations: Json<AllureAnnotations>,
    pub started_at: DateTime<Utc>,
    pub ended_at: Option<DateTime<Utc>>,
}

impl ExecutionRecord {
    pub fn into_row(self, history: Vec<HistoryDot>, avg_duration_ms: Option<i32>) -> TestRow {
        TestRow {
            execution_id: self.id,
            launch_id: self.launch_id,
            playwright_test_id: self.playwright_test_id,
            fingerprint: self.fingerprint,
            title: self.title,
            file_path: self.file_path,
            line: self.line,
            suite_path: self.suite_path,
            browser_project: self.browser_project,
            worker_index: self.worker_index,
            parallel_index: self.parallel_index,
            shard_index: self.shard_index,
            retry_attempt: self.retry_attempt,
            status: self.status,
            duration_ms: self.duration_ms,
            error_message: self.error_message,
            error_cluster_hash: self.error_cluster_hash,
            annotations: self.annotations.0,
            started_at: self.started_at,
            ended_at: self.ended_at,
            history,
            avg_duration_ms,
        }
    }
}

pub async fn fetch_executions(db: &PgPool, ids: &[Uuid]) -> sqlx::Result<Vec<ExecutionRecord>> {
    sqlx::query_as!(
        ExecutionRecord,
        r#"SELECT id, launch_id, playwright_test_id, fingerprint, title, file_path, line, suite_path, browser_project,
                  worker_index, parallel_index, shard_index, retry_attempt, status, duration_ms, error_message,
                  error_cluster_hash, annotations AS "annotations: Json<AllureAnnotations>", started_at, ended_at
           FROM test_executions WHERE id = ANY($1)"#,
        ids
    )
    .fetch_all(db)
    .await
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Counters {
    pub total_tests: i32,
    pub passed: i32,
    pub failed: i32,
    pub flaky: i32,
    pub skipped: i32,
    pub running: i32,
}

/// Recomputes launch counters from the latest attempt of every test.
///
/// Counters are derived, never incremented, so re-delivered events cannot skew them,
/// and a retry that passes automatically stops counting its earlier failure.
pub async fn recompute_counters(
    conn: &mut PgConnection,
    launch_id: Uuid,
) -> sqlx::Result<Option<Counters>> {
    let row = sqlx::query!(
        r#"UPDATE launches l SET
               passed_count = c.passed, failed_count = c.failed, flaky_count = c.flaky,
               skipped_count = c.skipped, running_count = c.running,
               total_tests = GREATEST(c.total, s.planned)
           FROM (SELECT count(*) FILTER (WHERE status = 'passed')::int AS passed,
                        count(*) FILTER (WHERE status IN ('failed', 'timedOut', 'interrupted'))::int AS failed,
                        count(*) FILTER (WHERE status = 'flaky')::int AS flaky,
                        count(*) FILTER (WHERE status = 'skipped')::int AS skipped,
                        count(*) FILTER (WHERE status = 'running')::int AS running,
                        count(*)::int AS total
                 FROM test_executions WHERE launch_id = $1 AND NOT superseded) c,
                (SELECT COALESCE(sum(total_tests), 0)::int AS planned FROM launch_shards WHERE launch_id = $1) s
           WHERE l.id = $1
           RETURNING l.total_tests, l.passed_count, l.failed_count, l.flaky_count, l.skipped_count, l.running_count"#,
        launch_id
    )
    .fetch_optional(conn)
    .await?;
    Ok(row.map(|r| Counters {
        total_tests: r.total_tests,
        passed: r.passed_count,
        failed: r.failed_count,
        flaky: r.flaky_count,
        skipped: r.skipped_count,
        running: r.running_count,
    }))
}

/// Marks a launch finished: open attempts become interrupted, counters are final.
pub async fn finalize_launch(
    conn: &mut PgConnection,
    launch_id: Uuid,
    interrupted: bool,
    any_shard_failed: bool,
    ended_at: DateTime<Utc>,
) -> sqlx::Result<(String, Counters)> {
    sqlx::query!(
        "UPDATE test_executions SET status = 'interrupted', ended_at = $2
         WHERE launch_id = $1 AND status = 'running' AND NOT superseded",
        launch_id,
        ended_at
    )
    .execute(&mut *conn)
    .await?;
    sqlx::query!(
        "UPDATE test_steps s SET status = 'interrupted', ended_at = $2
         FROM test_executions e
         WHERE s.execution_id = e.id AND e.launch_id = $1 AND s.ended_at IS NULL",
        launch_id,
        ended_at
    )
    .execute(&mut *conn)
    .await?;
    let counters = recompute_counters(conn, launch_id)
        .await?
        .ok_or(sqlx::Error::RowNotFound)?;
    let status = if interrupted {
        "interrupted"
    } else if counters.failed > 0 || any_shard_failed {
        "failed"
    } else {
        "passed"
    };
    sqlx::query!(
        "UPDATE launches SET status = $2, ended_at = $3 WHERE id = $1",
        launch_id,
        status,
        ended_at
    )
    .execute(&mut *conn)
    .await?;
    Ok((status.to_owned(), counters))
}
