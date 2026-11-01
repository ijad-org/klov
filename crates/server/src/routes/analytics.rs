use std::sync::Arc;

use axum::Json;
use axum::extract::{Path, Query, State};
use klovplay_schema::{FlakyTest, HistoryEntry, ProjectAnalytics, TestHistory, TrendPoint};
use serde::Deserialize;

use crate::error::{AppError, AppResult};
use crate::routes::projects::project_id_by_slug;
use crate::state::AppState;

#[derive(Deserialize)]
pub struct AnalyticsQuery {
    /// Number of launches in the trend and flakiness window.
    launches: Option<i64>,
}

/// `GET /api/v1/projects/{slug}/analytics`: launch trend and the flakiest tests.
pub async fn project_analytics(
    State(state): State<Arc<AppState>>,
    Path(slug): Path<String>,
    Query(query): Query<AnalyticsQuery>,
) -> AppResult<Json<ProjectAnalytics>> {
    let project_id = project_id_by_slug(&state.db, &slug).await?;
    let window = query.launches.unwrap_or(30).clamp(2, 200);

    let mut trend = sqlx::query_as!(
        TrendPoint,
        r#"SELECT id AS launch_id, build_number, branch, status, started_at,
                  (EXTRACT(EPOCH FROM (ended_at - started_at)) * 1000)::bigint AS "duration_ms?",
                  total_tests, passed_count AS passed, failed_count AS failed, flaky_count AS flaky,
                  skipped_count AS skipped
           FROM launches WHERE project_id = $1 ORDER BY started_at DESC LIMIT $2"#,
        project_id,
        window
    )
    .fetch_all(&state.db)
    .await?;
    trend.reverse();

    let flaky = sqlx::query!(
        r#"WITH recent AS (
               SELECT id FROM launches WHERE project_id = $1 AND status <> 'running'
               ORDER BY started_at DESC LIMIT $2)
           SELECT e.fingerprint,
                  (array_agg(e.title ORDER BY e.started_at DESC))[1] AS "title!",
                  (array_agg(e.file_path ORDER BY e.started_at DESC))[1] AS "file_path!",
                  (array_agg(e.browser_project ORDER BY e.started_at DESC))[1] AS "browser_project!",
                  (array_agg(e.id ORDER BY e.started_at DESC))[1] AS "last_execution_id!",
                  count(*) AS "runs!",
                  count(*) FILTER (WHERE e.status = 'flaky') AS "flaky!",
                  count(*) FILTER (WHERE e.status IN ('failed', 'timedOut', 'interrupted')) AS "failed!"
           FROM test_executions e JOIN recent r ON r.id = e.launch_id
           WHERE NOT e.superseded
           GROUP BY e.fingerprint
           HAVING count(*) FILTER (WHERE e.status = 'flaky') > 0
           ORDER BY count(*) FILTER (WHERE e.status = 'flaky')::float / count(*) DESC, count(*) DESC
           LIMIT 25"#,
        project_id,
        window
    )
    .fetch_all(&state.db)
    .await?;
    let flaky_tests = flaky
        .into_iter()
        .map(|f| FlakyTest {
            flaky_rate: f.flaky as f64 / f.runs.max(1) as f64,
            fingerprint: f.fingerprint,
            title: f.title,
            file_path: f.file_path,
            browser_project: f.browser_project,
            runs: f.runs,
            flaky: f.flaky,
            failed: f.failed,
            last_execution_id: f.last_execution_id,
        })
        .collect();
    Ok(Json(ProjectAnalytics { trend, flaky_tests }))
}

#[derive(Deserialize)]
pub struct HistoryQuery {
    limit: Option<i64>,
}

/// `GET /api/v1/projects/{slug}/history/{fingerprint}`: one test across launches.
pub async fn test_history(
    State(state): State<Arc<AppState>>,
    Path((slug, fingerprint)): Path<(String, String)>,
    Query(query): Query<HistoryQuery>,
) -> AppResult<Json<TestHistory>> {
    let project_id = project_id_by_slug(&state.db, &slug).await?;
    let limit = query.limit.unwrap_or(50).clamp(1, 500);
    let rows = sqlx::query!(
        r#"SELECT e.id, e.launch_id, e.title, e.file_path, e.browser_project, e.status, e.duration_ms,
                  e.retry_attempt, e.error_message, e.started_at, l.build_number, l.branch
           FROM test_executions e JOIN launches l ON l.id = e.launch_id
           WHERE e.project_id = $1 AND e.fingerprint = $2 AND NOT e.superseded
           ORDER BY e.started_at DESC LIMIT $3"#,
        project_id,
        fingerprint,
        limit
    )
    .fetch_all(&state.db)
    .await?;
    let first = rows.first().ok_or(AppError::NotFound)?;
    let (title, file_path, browser_project) = (
        first.title.clone(),
        first.file_path.clone(),
        first.browser_project.clone(),
    );

    let finished: Vec<_> = rows
        .iter()
        .filter(|r| r.status != "running" && r.status != "skipped")
        .collect();
    let rate = |predicate: &dyn Fn(&str) -> bool| {
        (!finished.is_empty()).then(|| {
            finished.iter().filter(|r| predicate(&r.status)).count() as f64 / finished.len() as f64
        })
    };
    let pass_rate = rate(&|s| s == "passed" || s == "flaky");
    let flaky_rate = rate(&|s| s == "flaky");
    let durations: Vec<f64> = finished
        .iter()
        .filter_map(|r| r.duration_ms.map(f64::from))
        .collect();
    let avg_duration_ms =
        (!durations.is_empty()).then(|| durations.iter().sum::<f64>() / durations.len() as f64);

    let entries = rows
        .into_iter()
        .map(|r| HistoryEntry {
            execution_id: r.id,
            launch_id: r.launch_id,
            build_number: r.build_number,
            branch: r.branch,
            status: r.status,
            duration_ms: r.duration_ms,
            retry_attempt: r.retry_attempt,
            error_message: r.error_message,
            started_at: r.started_at,
        })
        .collect();
    Ok(Json(TestHistory {
        fingerprint,
        title,
        file_path,
        browser_project,
        entries,
        pass_rate,
        flaky_rate,
        avg_duration_ms,
    }))
}
