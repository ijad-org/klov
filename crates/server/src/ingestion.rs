//! HTTP ingestion → bounded in-memory channel → batch flusher.
//!
//! A request reserves channel capacity for all of its events at once, so a full
//! queue is answered with 503 (the reporter backs off and retries) instead of
//! blocking. The response is sent only after the flusher has committed the
//! events, so a crash can never lose data the reporter believes was delivered.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use axum::Json;
use axum::extract::State;
use klovplay_schema::{EventBatch, EventBatchResponse, TelemetryEvent};
use tokio::sync::{mpsc, oneshot};
use uuid::Uuid;

use crate::auth::ProjectAuth;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// Largest batch accepted in one request.
pub const MAX_EVENTS_PER_BATCH: usize = 10_000;

#[derive(Debug, Clone)]
pub enum AckError {
    /// The events were rejected by the database; retrying will not help.
    Rejected(String),
    /// Transient failure (database unavailable, shutting down).
    Unavailable(String),
}

impl From<AckError> for AppError {
    fn from(error: AckError) -> Self {
        match error {
            AckError::Rejected(message) => AppError::Unprocessable(message),
            AckError::Unavailable(message) => AppError::Unavailable(message),
        }
    }
}

pub enum IngestItem {
    Event {
        group: u64,
        event: Box<TelemetryEvent>,
    },
    /// Follows the last event of a request; resolved once that event is committed.
    Ack {
        group: u64,
        reply: oneshot::Sender<Result<(), AckError>>,
    },
}

#[derive(Clone)]
pub struct IngestSender {
    tx: mpsc::Sender<IngestItem>,
    next_group: Arc<AtomicU64>,
}

impl IngestSender {
    pub fn channel(capacity: usize) -> (Self, mpsc::Receiver<IngestItem>) {
        let (tx, rx) = mpsc::channel(capacity);
        (
            IngestSender {
                tx,
                next_group: Arc::new(AtomicU64::new(1)),
            },
            rx,
        )
    }

    /// Queues the events and waits until they are durably stored.
    pub async fn submit(&self, events: Vec<TelemetryEvent>) -> Result<u32, AppError> {
        let count = events.len();
        if count == 0 {
            return Ok(0);
        }
        let group = self.next_group.fetch_add(1, Ordering::Relaxed);
        let mut permits = self
            .tx
            .try_reserve_many(count + 1)
            .map_err(|error| match error {
                mpsc::error::TrySendError::Full(()) => {
                    AppError::Unavailable("ingestion queue is full, retry shortly".into())
                }
                mpsc::error::TrySendError::Closed(()) => {
                    AppError::Unavailable("server is shutting down".into())
                }
            })?;
        let (reply, ack) = oneshot::channel();
        for event in events {
            permits
                .next()
                .expect("reserved one permit per event")
                .send(IngestItem::Event {
                    group,
                    event: Box::new(event),
                });
        }
        permits
            .next()
            .expect("reserved a permit for the ack")
            .send(IngestItem::Ack { group, reply });
        match ack.await {
            Ok(Ok(())) => Ok(count as u32),
            Ok(Err(error)) => Err(error.into()),
            Err(_) => Err(AppError::Unavailable(
                "ingestion stopped before the batch was stored".into(),
            )),
        }
    }
}

pub fn launch_id_of(event: &TelemetryEvent) -> Option<Uuid> {
    match event {
        TelemetryEvent::LaunchInit(_) => None,
        TelemetryEvent::TestStart { launch_id, .. }
        | TelemetryEvent::StepStart { launch_id, .. }
        | TelemetryEvent::StepEnd { launch_id, .. }
        | TelemetryEvent::TestEnd { launch_id, .. }
        | TelemetryEvent::ShardEnd { launch_id, .. } => Some(*launch_id),
    }
}

/// `POST /api/v1/events/batch`
pub async fn post_events_batch(
    State(state): State<Arc<AppState>>,
    auth: ProjectAuth,
    Json(batch): Json<EventBatch>,
) -> AppResult<Json<EventBatchResponse>> {
    if batch.events.len() > MAX_EVENTS_PER_BATCH {
        return Err(AppError::BadRequest(format!(
            "at most {MAX_EVENTS_PER_BATCH} events per batch"
        )));
    }
    let mut launch_ids = Vec::new();
    for event in &batch.events {
        let Some(launch_id) = launch_id_of(event) else {
            return Err(AppError::BadRequest(
                "LAUNCH_INIT must be sent to /api/v1/launches/init".into(),
            ));
        };
        if !launch_ids.contains(&launch_id) {
            launch_ids.push(launch_id);
        }
    }
    auth.check_launches(&state, &launch_ids).await?;
    let accepted = state.ingest.submit(batch.events).await?;
    Ok(Json(EventBatchResponse { accepted }))
}
