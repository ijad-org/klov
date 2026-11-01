//! KlovPlay server library: everything `main.rs` wires together, exposed for integration tests.

pub mod auth;
pub mod config;
pub mod db;
pub mod error;
pub mod fingerprint;
pub mod flusher;
pub mod ingestion;
pub mod retry;
pub mod routes;
pub mod s3;
pub mod sse;
pub mod state;

use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use dashmap::DashMap;
use sqlx::PgPool;
use sqlx::migrate::Migrator;
use tokio::sync::watch;
use tokio::task::JoinHandle;

use crate::config::Config;
use crate::flusher::{Flusher, run_maintenance};
use crate::ingestion::IngestSender;
use crate::s3::Storage;
use crate::sse::LiveHub;
use crate::state::AppState;

pub static MIGRATOR: Migrator = sqlx::migrate!("../../migrations");

/// A running application: the router plus the background tasks behind it.
pub struct App {
    pub router: Router,
    pub state: Arc<AppState>,
    shutdown: watch::Sender<bool>,
    tasks: Vec<JoinHandle<()>>,
}

impl App {
    pub async fn build(config: Config, db: PgPool, storage: Storage) -> App {
        let (ingest, receiver) = IngestSender::channel(config.ingest.channel_capacity);
        let (shutdown, shutdown_rx) = watch::channel(false);
        let state = Arc::new(AppState {
            db,
            config,
            storage,
            live: LiveHub::default(),
            ingest,
            key_cache: DashMap::new(),
            launch_owners: DashMap::new(),
        });
        let tasks = vec![
            tokio::spawn(Flusher::new(state.clone(), receiver, shutdown_rx.clone()).run()),
            tokio::spawn(run_maintenance(state.clone(), shutdown_rx)),
        ];
        App {
            router: routes::router(state.clone()),
            state,
            shutdown,
            tasks,
        }
    }

    /// Stops background work after the HTTP server has drained, persisting queued events.
    pub async fn shutdown(self) {
        let _ = self.shutdown.send(true);
        for task in self.tasks {
            if tokio::time::timeout(Duration::from_secs(15), task)
                .await
                .is_err()
            {
                tracing::warn!("background task did not stop in time");
            }
        }
    }
}
