#![allow(dead_code)]

use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use chrono::{DateTime, Utc};
use clap::Parser;
use http_body_util::BodyExt;
use klovplay_schema::{AllureAnnotations, TelemetryEvent};
use klovplay_server::App;
use klovplay_server::config::Cli;
use klovplay_server::s3::Storage;
use serde_json::{Value, json};
use sqlx::PgPool;
use tower::ServiceExt;
use uuid::Uuid;

pub const S3_BUCKET: &str = "klovplay-test";

pub struct TestApp {
    pub app: App,
    pub router: Router,
    pub api_key: String,
    pub slug: String,
}

pub fn config() -> klovplay_server::config::Config {
    let mut config =
        Cli::try_parse_from(["klovplay-server", "--database-url", "postgres://unused"])
            .unwrap()
            .config;
    config.ingest.flush_interval_ms = 20;
    config.ingest.counters_interval_ms = 0;
    config.admin_token = Some("admin-secret".into());
    config.web_dir = "/nonexistent".into();
    config.s3.bucket = S3_BUCKET.into();
    config.s3.endpoint = Some(
        std::env::var("KLOVPLAY_TEST_S3_ENDPOINT")
            .unwrap_or_else(|_| "http://localhost:9000".into()),
    );
    config.s3.public_endpoint = None;
    config.s3.force_path_style = true;
    config.s3.access_key_id =
        Some(std::env::var("KLOVPLAY_TEST_S3_ACCESS_KEY").unwrap_or_else(|_| "klovplay".into()));
    config.s3.secret_access_key = Some(
        std::env::var("KLOVPLAY_TEST_S3_SECRET_KEY").unwrap_or_else(|_| "klovplay-secret".into()),
    );
    config
}

pub async fn test_app(db: PgPool) -> TestApp {
    test_app_with(db, config()).await
}

pub async fn test_app_with(db: PgPool, config: klovplay_server::config::Config) -> TestApp {
    let storage = Storage::new(&config.s3).await;
    let (project, api_key) = klovplay_server::routes::projects::create_project(&db, "web", "Web")
        .await
        .unwrap();
    let app = App::build(config, db, storage).await;
    TestApp {
        router: app.router.clone(),
        app,
        api_key,
        slug: project.slug,
    }
}

impl TestApp {
    pub async fn call(
        &self,
        method: Method,
        uri: &str,
        key: Option<&str>,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let mut request = Request::builder().method(method).uri(uri);
        if let Some(key) = key {
            request = request.header("authorization", format!("Bearer {key}"));
        }
        let request = match body {
            Some(body) => request
                .header("content-type", "application/json")
                .body(Body::from(body.to_string())),
            None => request.body(Body::empty()),
        }
        .unwrap();
        let response = self.router.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let value = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes)
                .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).into()))
        };
        (status, value)
    }

    pub async fn get(&self, uri: &str) -> Value {
        let (status, body) = self.call(Method::GET, uri, None, None).await;
        assert_eq!(status, StatusCode::OK, "GET {uri}: {body}");
        body
    }

    pub async fn init_launch(
        &self,
        ci_run_id: &str,
        shard_index: i32,
        total_shards: i32,
        tests: i32,
    ) -> Uuid {
        let (status, body) = self
            .call(
                Method::POST,
                "/api/v1/launches/init",
                Some(&self.api_key),
                Some(json!({
                    "project_slug": self.slug, "ci_run_id": ci_run_id, "branch": "main", "commit_sha": "abc123",
                    "build_number": "42", "shard_index": shard_index, "total_shards": total_shards,
                    "shard_total_tests": tests, "timestamp": Utc::now()
                })),
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        body["launch_id"].as_str().unwrap().parse().unwrap()
    }

    pub async fn send(&self, events: Vec<TelemetryEvent>) -> (StatusCode, Value) {
        self.call(
            Method::POST,
            "/api/v1/events/batch",
            Some(&self.api_key),
            Some(json!({ "events": events })),
        )
        .await
    }

    pub async fn send_ok(&self, events: Vec<TelemetryEvent>) {
        let count = events.len();
        let (status, body) = self.send(events).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["accepted"], count);
    }
}

pub fn ts(offset_ms: i64) -> DateTime<Utc> {
    DateTime::from_timestamp_millis(1_800_000_000_000 + offset_ms).unwrap()
}

pub struct TestSpec<'a> {
    pub launch_id: Uuid,
    pub execution_id: Uuid,
    pub test_id: &'a str,
    pub title: &'a str,
    pub file: &'a str,
    pub project: &'a str,
    pub retry: i32,
    pub at: i64,
}

pub fn start(spec: &TestSpec) -> TelemetryEvent {
    TelemetryEvent::TestStart {
        launch_id: spec.launch_id,
        execution_id: spec.execution_id,
        playwright_test_id: spec.test_id.into(),
        title: spec.title.into(),
        file_path: spec.file.into(),
        line: 10,
        suite_path: vec!["Checkout".into()],
        browser_project: spec.project.into(),
        worker_index: spec.retry,
        parallel_index: 0,
        shard_index: 1,
        retry_attempt: spec.retry,
        annotations: AllureAnnotations {
            severity: Some("critical".into()),
            tags: vec!["@smoke".into()],
            ..Default::default()
        },
        timestamp: ts(spec.at),
    }
}

pub fn end(spec: &TestSpec, status: &str, error: Option<&str>) -> TelemetryEvent {
    TelemetryEvent::TestEnd {
        launch_id: spec.launch_id,
        execution_id: spec.execution_id,
        status: status.into(),
        duration_ms: 1500,
        error_message: error.map(Into::into),
        error_stack: error.map(|e| format!("{e}\n    at /home/runner/work/app/{}:10:5", spec.file)),
        error_snippet: None,
        stdout: vec!["hello\n".into()],
        stderr: Vec::new(),
        timestamp: ts(spec.at + 1500),
    }
}

pub fn shard_end(launch_id: Uuid, shard_index: i32, status: &str) -> TelemetryEvent {
    TelemetryEvent::ShardEnd {
        launch_id,
        shard_index,
        status: Some(status.into()),
        timestamp: Utc::now(),
    }
}

/// Counters are recomputed asynchronously after a flush.
pub async fn wait_for_launch(
    app: &TestApp,
    launch_id: Uuid,
    predicate: impl Fn(&Value) -> bool,
) -> Value {
    for _ in 0..100 {
        let detail = app.get(&format!("/api/v1/launches/{launch_id}")).await;
        if predicate(&detail["launch"]) {
            return detail;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!(
        "launch {launch_id} never reached the expected state: {}",
        app.get(&format!("/api/v1/launches/{launch_id}")).await
    );
}
