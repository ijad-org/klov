//! Live fan-out: one broadcast channel per launch, consumed as Server-Sent Events.

use std::convert::Infallible;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::{Path, State};
use axum::response::sse::{Event, KeepAlive, Sse};
use dashmap::DashMap;
use futures::{Stream, StreamExt};
use klovplay_schema::SseStateDiff;
use tokio::sync::broadcast;
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::wrappers::errors::BroadcastStreamRecvError;
use uuid::Uuid;

use crate::state::AppState;

const CHANNEL_CAPACITY: usize = 4096;

/// Diffs are serialized once and shared by every subscriber.
type Payload = Arc<str>;

#[derive(Default)]
pub struct LiveHub {
    channels: DashMap<Uuid, broadcast::Sender<Payload>>,
}

impl LiveHub {
    pub fn subscribe(&self, launch_id: Uuid) -> broadcast::Receiver<Payload> {
        self.channels
            .entry(launch_id)
            .or_insert_with(|| broadcast::channel(CHANNEL_CAPACITY).0)
            .subscribe()
    }

    pub fn publish(&self, launch_id: Uuid, diff: &SseStateDiff) {
        let Some(sender) = self.channels.get(&launch_id) else {
            return;
        };
        if sender.receiver_count() == 0 {
            return;
        }
        match serde_json::to_string(diff) {
            Ok(json) => {
                let _ = sender.send(json.into());
            }
            Err(error) => tracing::warn!(?error, "failed to serialize live diff"),
        }
    }

    pub fn has_subscribers(&self, launch_id: Uuid) -> bool {
        self.channels
            .get(&launch_id)
            .is_some_and(|s| s.receiver_count() > 0)
    }

    /// Drops channels nobody listens to any more.
    pub fn prune(&self) {
        self.channels
            .retain(|_, sender| sender.receiver_count() > 0);
    }
}

/// `GET /api/v1/launches/{id}/stream`
///
/// Clients load the launch over REST, then apply these diffs. A client that
/// falls too far behind is disconnected; `EventSource` reconnects and the
/// client re-syncs from REST.
pub async fn launch_stream(
    State(state): State<Arc<AppState>>,
    Path(launch_id): Path<Uuid>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let receiver = state.live.subscribe(launch_id);
    let hello = futures::stream::once(async {
        Ok(Event::default()
            .retry(Duration::from_secs(2))
            .comment("connected"))
    });
    let diffs = BroadcastStream::new(receiver)
        .take_while(|item| {
            futures::future::ready(!matches!(item, Err(BroadcastStreamRecvError::Lagged(_))))
        })
        .filter_map(|item| {
            futures::future::ready(
                item.ok()
                    .map(|json| Ok(Event::default().data(json.as_ref()))),
            )
        });
    Sse::new(hello.chain(diffs)).keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
}
