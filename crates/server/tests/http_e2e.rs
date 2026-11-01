//! Exercises the server over real sockets: SSE streaming and pre-signed S3 uploads.
//! The artifact test needs an S3-compatible store (docker compose up s3) and skips without one.

mod common;

use std::time::Duration;

use common::*;
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

async fn spawn_server(app: &TestApp) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let router = app.router.clone();
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    format!("http://{address}")
}

#[sqlx::test(migrator = "klovplay_server::MIGRATOR")]
async fn sse_stream_delivers_diffs_over_http(db: PgPool) {
    let app = test_app(db).await;
    let base = spawn_server(&app).await;
    let launch_id = app.init_launch("run-sse", 1, 1, 1).await;
    let client = reqwest::Client::new();

    let mut stream = client
        .get(format!("{base}/api/v1/launches/{launch_id}/stream"))
        .send()
        .await
        .unwrap();
    assert_eq!(stream.headers()["content-type"], "text/event-stream");
    let first = tokio::time::timeout(Duration::from_secs(2), stream.chunk())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(String::from_utf8_lossy(&first).contains("connected"));

    let spec = TestSpec {
        launch_id,
        execution_id: Uuid::new_v4(),
        test_id: "t",
        title: "live over http",
        file: "l.spec.ts",
        project: "chromium",
        retry: 0,
        at: 0,
    };
    let response = client
        .post(format!("{base}/api/v1/events/batch"))
        .bearer_auth(&app.api_key)
        .json(&json!({ "events": [start(&spec)] }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);

    let mut received = String::new();
    while !received.contains("TEST_ROW_UPDATED") {
        let chunk = tokio::time::timeout(Duration::from_secs(2), stream.chunk())
            .await
            .expect("diff within 2s")
            .unwrap()
            .unwrap();
        received.push_str(&String::from_utf8_lossy(&chunk));
    }
    assert!(received.contains("live over http"));
}

#[sqlx::test(migrator = "klovplay_server::MIGRATOR")]
async fn artifacts_upload_with_presigned_urls(db: PgPool) {
    let app = test_app(db).await;
    if let Err(error) = app.app.state.storage.ensure_bucket("*").await {
        eprintln!("skipping: no S3-compatible store reachable ({error:#})");
        return;
    }
    let base = spawn_server(&app).await;
    let client = reqwest::Client::new();
    let launch_id = app.init_launch("run-artifacts", 1, 1, 1).await;
    let spec = TestSpec {
        launch_id,
        execution_id: Uuid::new_v4(),
        test_id: "t",
        title: "uploads",
        file: "u.spec.ts",
        project: "chromium",
        retry: 0,
        at: 0,
    };

    // Presigning before the execution exists is refused so the reporter retries after its flush.
    let presign_body = json!({
        "launch_id": launch_id, "execution_id": spec.execution_id,
        "artifacts": [{ "name": "screenshot", "content_type": "image/png", "size_bytes": 4, "file_name": "test-failed-1.png" }]
    });
    let early = client
        .post(format!("{base}/api/v1/artifacts/presign"))
        .bearer_auth(&app.api_key)
        .json(&presign_body)
        .send()
        .await
        .unwrap();
    assert_eq!(early.status(), 409);

    app.send_ok(vec![
        start(&spec),
        end(&spec, "failed", Some("Error: boom")),
    ])
    .await;
    let presigned: Value = client
        .post(format!("{base}/api/v1/artifacts/presign"))
        .bearer_auth(&app.api_key)
        .json(&presign_body)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let upload = &presigned["uploads"][0];
    let artifact_id = upload["artifact_id"].as_str().unwrap();

    let before = app
        .get(&format!("/api/v1/executions/{}", spec.execution_id))
        .await;
    assert_eq!(before["artifacts"][0]["uploaded"], false);
    assert!(before["artifacts"][0]["url"].is_null());

    let put = client
        .put(upload["upload_url"].as_str().unwrap())
        .header("content-type", "image/png")
        .body(vec![0x89, b'P', b'N', b'G'])
        .send()
        .await
        .unwrap();
    assert!(
        put.status().is_success(),
        "PUT failed: {}",
        put.text().await.unwrap()
    );

    let complete = client
        .post(format!("{base}/api/v1/artifacts/complete"))
        .bearer_auth(&app.api_key)
        .json(&json!({ "artifact_ids": [artifact_id] }))
        .send()
        .await
        .unwrap();
    assert_eq!(complete.status(), 204);

    let after = app
        .get(&format!("/api/v1/executions/{}", spec.execution_id))
        .await;
    let artifact = &after["artifacts"][0];
    assert_eq!(artifact["uploaded"], true);
    assert_eq!(artifact["size_bytes"], 4);
    let downloaded = client
        .get(artifact["url"].as_str().unwrap())
        .send()
        .await
        .unwrap();
    assert_eq!(downloaded.headers()["content-type"], "image/png");
    assert_eq!(
        downloaded.bytes().await.unwrap().as_ref(),
        &[0x89, b'P', b'N', b'G']
    );

    let no_redirects = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    let redirect = no_redirects
        .get(format!("{base}/api/v1/artifacts/{artifact_id}/content"))
        .send()
        .await
        .unwrap();
    assert_eq!(redirect.status(), 307);
}
