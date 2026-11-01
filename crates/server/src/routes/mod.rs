use std::sync::Arc;

use axum::Router;
use axum::extract::DefaultBodyLimit;
use axum::routing::{any, get, post};
use tower_http::compression::CompressionLayer;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::trace::TraceLayer;

use crate::error::AppError;
use crate::state::AppState;
use crate::{ingestion, sse};

pub mod analytics;
pub mod artifacts;
pub mod launches;
pub mod projects;
pub mod tests;

pub fn router(state: Arc<AppState>) -> Router {
    let batch_limit = state.config.ingest.max_batch_mb * 1024 * 1024;
    let api = Router::new()
        .route("/health", get(|| async { "ok" }))
        .route(
            "/projects",
            get(projects::list_projects).post(projects::create_project_handler),
        )
        .route("/projects/{slug}/launches", get(launches::list_launches))
        .route(
            "/projects/{slug}/analytics",
            get(analytics::project_analytics),
        )
        .route(
            "/projects/{slug}/history/{fingerprint}",
            get(analytics::test_history),
        )
        .route("/launches/init", post(launches::init_launch))
        .route("/launches/{id}", get(launches::get_launch))
        .route("/launches/{id}/heartbeat", post(launches::heartbeat))
        .route("/launches/{id}/stream", get(sse::launch_stream))
        .route("/launches/{id}/tests", get(tests::list_tests))
        .route("/executions/{id}", get(tests::get_execution))
        .route(
            "/events/batch",
            post(ingestion::post_events_batch).layer(DefaultBodyLimit::max(batch_limit)),
        )
        .route("/artifacts/presign", post(artifacts::presign))
        .route("/artifacts/complete", post(artifacts::complete))
        .route("/artifacts/{id}/content", get(artifacts::content))
        .route("/{*rest}", any(|| async { AppError::NotFound }));

    let web_dir = state.config.web_dir.clone();
    let mut app = Router::new().nest("/api/v1", api);
    if web_dir.join("index.html").exists() {
        let index = ServeFile::new(web_dir.join("index.html"));
        app = app.fallback_service(ServeDir::new(&web_dir).fallback(index));
    } else {
        tracing::warn!(dir = %web_dir.display(), "dashboard assets not found; serving the API only");
    }
    app.layer(CompressionLayer::new())
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}
