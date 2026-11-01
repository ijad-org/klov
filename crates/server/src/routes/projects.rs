use std::sync::{Arc, LazyLock};

use axum::Json;
use axum::extract::State;
use klovplay_schema::{CreateProjectRequest, CreateProjectResponse, LaunchSummary, ProjectSummary};
use regex::Regex;
use sqlx::PgPool;
use uuid::Uuid;

use crate::auth::{AdminAuth, generate_api_key, hash_api_key};
use crate::db::LaunchRecord;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

const RECENT_LAUNCHES: i64 = 10;
static SLUG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[a-z0-9][a-z0-9_-]{0,63}$").unwrap());

pub async fn create_project(
    db: &PgPool,
    slug: &str,
    name: &str,
) -> AppResult<(ProjectSummary, String)> {
    if !SLUG.is_match(slug) {
        return Err(AppError::BadRequest(
            "slug must be 1-64 chars of a-z, 0-9, '-' or '_'".into(),
        ));
    }
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 128 {
        return Err(AppError::BadRequest("name must be 1-128 characters".into()));
    }
    let api_key = generate_api_key();
    let row = sqlx::query!(
        "INSERT INTO projects (slug, name, api_key_hash) VALUES ($1, $2, $3)
         ON CONFLICT (slug) DO NOTHING
         RETURNING id, slug, name, created_at",
        slug,
        name,
        hash_api_key(&api_key)
    )
    .fetch_optional(db)
    .await?
    .ok_or_else(|| AppError::Conflict(format!("project '{slug}' already exists")))?;
    let project = ProjectSummary {
        id: row.id,
        slug: row.slug,
        name: row.name,
        created_at: row.created_at,
        launch_count: 0,
        latest_launch: None,
        recent: Vec::new(),
    };
    Ok((project, api_key))
}

/// `POST /api/v1/projects` (admin)
pub async fn create_project_handler(
    State(state): State<Arc<AppState>>,
    _admin: AdminAuth,
    Json(request): Json<CreateProjectRequest>,
) -> AppResult<Json<CreateProjectResponse>> {
    let (project, api_key) = create_project(&state.db, &request.slug, &request.name).await?;
    Ok(Json(CreateProjectResponse { project, api_key }))
}

/// `GET /api/v1/projects`
pub async fn list_projects(
    State(state): State<Arc<AppState>>,
) -> AppResult<Json<Vec<ProjectSummary>>> {
    let projects = sqlx::query!(
        r#"SELECT p.id, p.slug, p.name, p.created_at,
                  (SELECT count(*) FROM launches l WHERE l.project_id = p.id) AS "launch_count!"
           FROM projects p ORDER BY p.name"#
    )
    .fetch_all(&state.db)
    .await?;
    let launches = sqlx::query_as!(
        LaunchRecord,
        r#"SELECT l.id, l.project_id, p.slug AS project_slug, l.ci_run_id, l.build_number, l.branch, l.commit_sha,
                  l.status, l.total_tests, l.passed_count, l.failed_count, l.flaky_count, l.skipped_count,
                  l.running_count, l.total_shards, l.completed_shards, l.started_at, l.ended_at,
                  (EXTRACT(EPOCH FROM (l.ended_at - l.started_at)) * 1000)::bigint AS "duration_ms?"
           FROM launches l JOIN projects p ON p.id = l.project_id
           WHERE l.id IN (SELECT id FROM (SELECT id, row_number() OVER (PARTITION BY project_id ORDER BY started_at DESC) AS rn
                                          FROM launches) ranked
                          WHERE rn <= $1)
           ORDER BY l.started_at DESC"#,
        RECENT_LAUNCHES
    )
    .fetch_all(&state.db)
    .await?;

    let mut by_project: std::collections::HashMap<Uuid, Vec<LaunchSummary>> =
        std::collections::HashMap::new();
    for launch in launches {
        by_project
            .entry(launch.project_id)
            .or_default()
            .push(launch.into());
    }
    let summaries = projects
        .into_iter()
        .map(|p| {
            let recent = by_project.remove(&p.id).unwrap_or_default();
            ProjectSummary {
                id: p.id,
                slug: p.slug,
                name: p.name,
                created_at: p.created_at,
                launch_count: p.launch_count,
                latest_launch: recent.first().cloned(),
                recent,
            }
        })
        .collect();
    Ok(Json(summaries))
}

pub async fn project_id_by_slug(db: &PgPool, slug: &str) -> AppResult<Uuid> {
    sqlx::query_scalar!("SELECT id FROM projects WHERE slug = $1", slug)
        .fetch_optional(db)
        .await?
        .ok_or(AppError::NotFound)
}
