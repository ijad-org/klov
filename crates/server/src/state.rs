use std::time::Instant;

use dashmap::DashMap;
use sqlx::PgPool;
use uuid::Uuid;

use crate::auth::ProjectAuth;
use crate::config::Config;
use crate::ingestion::IngestSender;
use crate::s3::Storage;
use crate::sse::LiveHub;

pub struct AppState {
    pub db: PgPool,
    pub config: Config,
    pub storage: Storage,
    /// Per-launch broadcast channels feeding the SSE streams.
    pub live: LiveHub,
    /// Bounded channel into the batch flusher.
    pub ingest: IngestSender,
    /// API key hash → project, cached briefly to keep ingestion off the projects table.
    pub key_cache: DashMap<String, (ProjectAuth, Instant)>,
    /// launch → owning project, for authorizing event batches.
    pub launch_owners: DashMap<Uuid, Uuid>,
}
