use std::sync::Arc;

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::Redirect;
use klovplay_schema::{
    CompleteArtifactsRequest, PresignRequest, PresignResponse, PresignedUpload, SseStateDiff,
};
use uuid::Uuid;

use crate::auth::ProjectAuth;
use crate::error::{AppError, AppResult};
use crate::s3::artifact_key;
use crate::state::AppState;

const MAX_ARTIFACTS_PER_REQUEST: usize = 50;

fn content_type_or_default(content_type: &str) -> &str {
    let valid = !content_type.is_empty()
        && content_type.len() <= 64
        && content_type.contains('/')
        && content_type.is_ascii();
    if valid {
        content_type
    } else {
        "application/octet-stream"
    }
}

/// `POST /api/v1/artifacts/presign`: registers artifacts and returns pre-signed PUT URLs.
pub async fn presign(
    State(state): State<Arc<AppState>>,
    auth: ProjectAuth,
    Json(request): Json<PresignRequest>,
) -> AppResult<Json<PresignResponse>> {
    if request.artifacts.is_empty() || request.artifacts.len() > MAX_ARTIFACTS_PER_REQUEST {
        return Err(AppError::BadRequest(format!(
            "send 1-{MAX_ARTIFACTS_PER_REQUEST} artifacts per request"
        )));
    }
    auth.check_launches(&state, &[request.launch_id]).await?;
    let known = sqlx::query_scalar!(
        "SELECT EXISTS (SELECT 1 FROM test_executions WHERE id = $1 AND launch_id = $2) AS \"exists!\"",
        request.execution_id,
        request.launch_id
    )
    .fetch_one(&state.db)
    .await?;
    if !known {
        // The TEST_START for this execution has not been stored yet; the reporter retries.
        return Err(AppError::Conflict(
            "execution not found yet; send its TEST_START first".into(),
        ));
    }

    let mut uploads = Vec::with_capacity(request.artifacts.len());
    let mut tx = state.db.begin().await?;
    for artifact in &request.artifacts {
        let artifact_id = Uuid::new_v4();
        let content_type = content_type_or_default(&artifact.content_type);
        let file_name = artifact
            .file_name
            .clone()
            .unwrap_or_else(|| artifact.name.clone());
        let key = artifact_key(
            auth.project_id,
            request.launch_id,
            request.execution_id,
            artifact_id,
            &file_name,
        );
        let name: String = artifact.name.chars().take(128).collect();
        sqlx::query!(
            "INSERT INTO artifacts (id, execution_id, name, content_type, s3_key, size_bytes, file_name)
             VALUES ($1, $2, $3, $4, $5, $6, $7)",
            artifact_id,
            request.execution_id,
            name,
            content_type,
            key,
            artifact.size_bytes.max(0),
            file_name
        )
        .execute(&mut *tx)
        .await?;
        let upload_url = state.storage.presign_put(&key, content_type).await?;
        uploads.push(PresignedUpload {
            artifact_id,
            upload_url,
        });
    }
    tx.commit().await?;
    Ok(Json(PresignResponse { uploads }))
}

/// `POST /api/v1/artifacts/complete`: confirms uploads after checking the objects exist.
pub async fn complete(
    State(state): State<Arc<AppState>>,
    auth: ProjectAuth,
    Json(request): Json<CompleteArtifactsRequest>,
) -> AppResult<StatusCode> {
    let rows = sqlx::query!(
        r#"SELECT a.id, a.s3_key, a.execution_id, e.launch_id
           FROM artifacts a JOIN test_executions e ON e.id = a.execution_id
           WHERE a.id = ANY($1) AND e.project_id = $2"#,
        &request.artifact_ids,
        auth.project_id
    )
    .fetch_all(&state.db)
    .await?;
    if rows.len() != request.artifact_ids.len() {
        return Err(AppError::NotFound);
    }
    for row in rows {
        let Some(size) = state.storage.object_size(&row.s3_key).await? else {
            return Err(AppError::Conflict(format!(
                "artifact {} has not been uploaded",
                row.id
            )));
        };
        sqlx::query!(
            "UPDATE artifacts SET uploaded_at = COALESCE(uploaded_at, now()), size_bytes = $2 WHERE id = $1",
            row.id,
            size
        )
        .execute(&state.db)
        .await?;
        state.live.publish(
            row.launch_id,
            &SseStateDiff::ArtifactUploaded {
                execution_id: row.execution_id,
                artifact_id: row.id,
            },
        );
    }
    Ok(StatusCode::NO_CONTENT)
}

/// `GET /api/v1/artifacts/{id}/content`: stable link that redirects to a fresh pre-signed URL.
pub async fn content(
    State(state): State<Arc<AppState>>,
    Path(artifact_id): Path<Uuid>,
) -> AppResult<Redirect> {
    let artifact = sqlx::query!(
        "SELECT s3_key, content_type, file_name FROM artifacts WHERE id = $1 AND uploaded_at IS NOT NULL",
        artifact_id
    )
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::NotFound)?;
    let url = state
        .storage
        .presign_get(
            &artifact.s3_key,
            &artifact.content_type,
            artifact.file_name.as_deref(),
        )
        .await?;
    Ok(Redirect::temporary(&url))
}
