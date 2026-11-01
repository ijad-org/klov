mod common;

use std::time::Duration;

use axum::http::{Method, StatusCode};
use chrono::Utc;
use common::*;
use klovplay_schema::{SseStateDiff, TelemetryEvent};
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

#[sqlx::test(migrator = "klovplay_server::MIGRATOR")]
async fn retried_test_becomes_flaky_and_launch_completes(db: PgPool) {
    let app = test_app(db).await;
    let launch_id = app.init_launch("run-1", 1, 1, 2).await;

    let first = TestSpec {
        launch_id,
        execution_id: Uuid::new_v4(),
        test_id: "t-a",
        title: "pays",
        file: "tests/pay.spec.ts",
        project: "chromium",
        retry: 0,
        at: 0,
    };
    let other = TestSpec {
        launch_id,
        execution_id: Uuid::new_v4(),
        test_id: "t-b",
        title: "browses",
        file: "tests/browse.spec.ts",
        project: "chromium",
        retry: 0,
        at: 10,
    };
    let step_id = Uuid::new_v4();
    let child_id = Uuid::new_v4();
    app.send_ok(vec![
        start(&first),
        start(&other),
        TelemetryEvent::StepStart {
            launch_id,
            execution_id: first.execution_id,
            step_id,
            parent_step_id: None,
            title: "open cart".into(),
            category: "test.step".into(),
            timestamp: ts(5),
        },
        TelemetryEvent::StepStart {
            launch_id,
            execution_id: first.execution_id,
            step_id: child_id,
            parent_step_id: Some(step_id),
            title: "click Pay".into(),
            category: "pw:api".into(),
            timestamp: ts(6),
        },
        TelemetryEvent::StepEnd {
            launch_id,
            execution_id: first.execution_id,
            step_id: child_id,
            status: "failed".into(),
            duration_ms: 3,
            error_message: Some("boom".into()),
            timestamp: ts(9),
        },
        end(
            &first,
            "failed",
            Some("Error: expect(locator).toBeVisible() failed"),
        ),
        end(&other, "passed", None),
    ])
    .await;

    // While the retry runs, the earlier failure still counts.
    let detail = wait_for_launch(&app, launch_id, |l| {
        l["failed_count"] == 1 && l["passed_count"] == 1
    })
    .await;
    assert_eq!(detail["launch"]["status"], "running");
    assert_eq!(detail["clusters"][0]["count"], 1);

    let retry = TestSpec {
        execution_id: Uuid::new_v4(),
        retry: 1,
        at: 2000,
        ..first
    };
    app.send_ok(vec![
        start(&retry),
        end(&retry, "passed", None),
        shard_end(launch_id, 1, "passed"),
    ])
    .await;

    let detail = wait_for_launch(&app, launch_id, |l| l["status"] != "running").await;
    let launch = &detail["launch"];
    assert_eq!(launch["status"], "passed");
    assert_eq!(
        (
            launch["total_tests"].as_i64(),
            launch["passed_count"].as_i64(),
            launch["flaky_count"].as_i64(),
            launch["failed_count"].as_i64()
        ),
        (Some(2), Some(1), Some(1), Some(0))
    );
    assert_eq!(launch["completed_shards"], 1);
    assert!(detail["clusters"].as_array().unwrap().is_empty());

    let page = app
        .get(&format!("/api/v1/launches/{launch_id}/tests"))
        .await;
    let tests = page["tests"].as_array().unwrap();
    assert_eq!(tests.len(), 2, "superseded attempts are hidden");
    let pays = tests.iter().find(|t| t["title"] == "pays").unwrap();
    assert_eq!(pays["status"], "flaky");
    assert_eq!(pays["retry_attempt"], 1);
    assert_eq!(pays["annotations"]["severity"], "critical");

    let execution = app
        .get(&format!("/api/v1/executions/{}", first.execution_id))
        .await;
    assert_eq!(execution["test"]["status"], "failed");
    assert_eq!(execution["attempts"].as_array().unwrap().len(), 2);
    assert_eq!(execution["steps"][0]["title"], "open cart");
    assert_eq!(execution["steps"][0]["children"][0]["title"], "click Pay");
    assert_eq!(
        execution["steps"][0]["children"][0]["error_message"],
        "boom"
    );
    // The open parent step is closed when its test ends.
    assert_eq!(execution["steps"][0]["status"], "interrupted");
    assert_eq!(
        execution["retry_command"],
        "npx playwright test tests/pay.spec.ts:10 --project=chromium"
    );
    assert_eq!(execution["stdout"][0], "hello\n");
}

#[sqlx::test(migrator = "klovplay_server::MIGRATOR")]
async fn redelivered_batches_do_not_double_count(db: PgPool) {
    let app = test_app(db.clone()).await;
    let launch_id = app.init_launch("run-dup", 1, 1, 1).await;
    let spec = TestSpec {
        launch_id,
        execution_id: Uuid::new_v4(),
        test_id: "t-a",
        title: "a",
        file: "a.spec.ts",
        project: "firefox",
        retry: 0,
        at: 0,
    };
    let batch = vec![start(&spec), end(&spec, "failed", Some("Error: nope"))];
    app.send_ok(batch.clone()).await;
    app.send_ok(batch).await;
    app.send_ok(vec![shard_end(launch_id, 1, "failed")]).await;
    app.send_ok(vec![shard_end(launch_id, 1, "failed")]).await;

    let detail = wait_for_launch(&app, launch_id, |l| l["status"] == "failed").await;
    assert_eq!(detail["launch"]["failed_count"], 1);
    assert_eq!(detail["launch"]["total_tests"], 1);
    assert_eq!(detail["launch"]["completed_shards"], 1);
    let rows: i64 = sqlx::query_scalar("SELECT count(*) FROM test_executions")
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(rows, 1);
}

#[sqlx::test(migrator = "klovplay_server::MIGRATOR")]
async fn shards_merge_into_one_launch(db: PgPool) {
    let app = test_app(db).await;
    let first = app.init_launch("ci-77", 1, 2, 1).await;
    let second = app.init_launch("ci-77", 2, 2, 1).await;
    assert_eq!(first, second, "same ci_run_id joins the same launch");

    let a = TestSpec {
        launch_id: first,
        execution_id: Uuid::new_v4(),
        test_id: "a",
        title: "a",
        file: "a.spec.ts",
        project: "chromium",
        retry: 0,
        at: 0,
    };
    let b = TestSpec {
        launch_id: first,
        execution_id: Uuid::new_v4(),
        test_id: "b",
        title: "b",
        file: "b.spec.ts",
        project: "chromium",
        retry: 0,
        at: 0,
    };
    app.send_ok(vec![
        start(&a),
        end(&a, "passed", None),
        shard_end(first, 1, "passed"),
    ])
    .await;
    let detail = wait_for_launch(&app, first, |l| l["completed_shards"] == 1).await;
    assert_eq!(
        detail["launch"]["status"], "running",
        "one of two shards finished"
    );
    assert_eq!(detail["launch"]["total_tests"], 2);

    app.send_ok(vec![
        start(&b),
        end(&b, "timedOut", Some("Test timeout of 30000ms exceeded.")),
        shard_end(first, 2, "failed"),
    ])
    .await;
    let detail = wait_for_launch(&app, first, |l| l["status"] != "running").await;
    assert_eq!(detail["launch"]["status"], "failed");
    assert_eq!(detail["launch"]["completed_shards"], 2);
    assert_eq!(
        detail["retry_command"],
        "npx playwright test b.spec.ts:10 --project=chromium"
    );
}

#[sqlx::test(migrator = "klovplay_server::MIGRATOR")]
async fn similar_errors_cluster_together(db: PgPool) {
    let app = test_app(db).await;
    let launch_id = app.init_launch("run-cluster", 1, 1, 3).await;
    let mut events = Vec::new();
    for (i, port) in [41234, 50001].iter().enumerate() {
        let spec = TestSpec {
            launch_id,
            execution_id: Uuid::new_v4(),
            test_id: if i == 0 { "x" } else { "y" },
            title: if i == 0 { "orders" } else { "invoices" },
            file: "api.spec.ts",
            project: "chromium",
            retry: 0,
            at: i as i64,
        };
        events.push(start(&spec));
        events.push(end(
            &spec,
            "failed",
            Some(&format!("Error: connect ECONNREFUSED 127.0.0.1:{port}")),
        ));
    }
    let lone = TestSpec {
        launch_id,
        execution_id: Uuid::new_v4(),
        test_id: "z",
        title: "login",
        file: "auth.spec.ts",
        project: "webkit",
        retry: 0,
        at: 5,
    };
    events.push(start(&lone));
    events.push(end(
        &lone,
        "failed",
        Some("Error: expect(page).toHaveURL(expected) failed"),
    ));
    app.send_ok(events).await;

    let detail = wait_for_launch(&app, launch_id, |l| l["failed_count"] == 3).await;
    let clusters = detail["clusters"].as_array().unwrap();
    assert_eq!(clusters.len(), 2);
    assert_eq!(clusters[0]["count"], 2);
    assert_eq!(
        clusters[0]["signature"],
        "Error: connect ECONNREFUSED 127.0.0.1:41234"
    );
    assert_eq!(
        clusters[0]["retry_command"],
        "npx playwright test api.spec.ts:10 --project=chromium"
    );
}

#[sqlx::test(migrator = "klovplay_server::MIGRATOR")]
async fn history_and_flaky_analytics_span_launches(db: PgPool) {
    let app = test_app(db).await;
    let statuses = ["passed", "failed", "passed"];
    let mut last_launch = Uuid::nil();
    for (i, status) in statuses.iter().enumerate() {
        let launch_id = app.init_launch(&format!("run-{i}"), 1, 1, 1).await;
        let spec = TestSpec {
            launch_id,
            execution_id: Uuid::new_v4(),
            test_id: "t",
            title: "search",
            file: "search.spec.ts",
            project: "chromium",
            retry: 0,
            at: i as i64 * 10_000,
        };
        let mut events = vec![
            start(&spec),
            end(&spec, status, (*status == "failed").then_some("Error: x")),
        ];
        if i == 2 {
            // Third launch: fails once, then passes on retry.
            let retry = TestSpec {
                execution_id: Uuid::new_v4(),
                retry: 1,
                at: spec.at + 2000,
                ..spec
            };
            events = vec![
                start(&spec),
                end(&spec, "failed", Some("Error: x")),
                start(&retry),
                end(&retry, "passed", None),
            ];
        }
        events.push(shard_end(launch_id, 1, "passed"));
        app.send_ok(events).await;
        wait_for_launch(&app, launch_id, |l| l["status"] != "running").await;
        last_launch = launch_id;
    }

    let page = app
        .get(&format!("/api/v1/launches/{last_launch}/tests"))
        .await;
    let row = &page["tests"][0];
    assert_eq!(row["status"], "flaky");
    let history: Vec<&str> = row["history"]
        .as_array()
        .unwrap()
        .iter()
        .map(|h| h["status"].as_str().unwrap())
        .collect();
    assert_eq!(
        history,
        ["failed", "passed"],
        "previous launches, newest first"
    );
    assert_eq!(row["avg_duration_ms"], 1500);

    let fingerprint = row["fingerprint"].as_str().unwrap();
    let history = app
        .get(&format!("/api/v1/projects/web/history/{fingerprint}"))
        .await;
    assert_eq!(history["entries"].as_array().unwrap().len(), 3);
    assert_eq!(history["pass_rate"].as_f64().unwrap(), 2.0 / 3.0);

    let analytics = app.get("/api/v1/projects/web/analytics").await;
    assert_eq!(analytics["trend"].as_array().unwrap().len(), 3);
    assert_eq!(analytics["trend"][1]["failed"], 1);
    assert_eq!(analytics["flaky_tests"][0]["flaky"], 1);
    assert_eq!(analytics["flaky_tests"][0]["runs"], 3);

    let projects = app.get("/api/v1/projects").await;
    assert_eq!(projects[0]["launch_count"], 3);
    assert_eq!(projects[0]["latest_launch"]["id"], last_launch.to_string());
}

#[sqlx::test(migrator = "klovplay_server::MIGRATOR")]
async fn keys_are_scoped_to_their_project(db: PgPool) {
    let app = test_app(db.clone()).await;
    let launch_id = app.init_launch("run-auth", 1, 1, 1).await;
    let spec = TestSpec {
        launch_id,
        execution_id: Uuid::new_v4(),
        test_id: "t",
        title: "t",
        file: "t.spec.ts",
        project: "",
        retry: 0,
        at: 0,
    };

    let (status, _) = app
        .call(
            Method::POST,
            "/api/v1/events/batch",
            None,
            Some(json!({ "events": [start(&spec)] })),
        )
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _) = app
        .call(
            Method::POST,
            "/api/v1/events/batch",
            Some("kp_wrong"),
            Some(json!({ "events": [start(&spec)] })),
        )
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    let (status, created) = app
        .call(
            Method::POST,
            "/api/v1/projects",
            Some("admin-secret"),
            Some(json!({ "slug": "mobile", "name": "Mobile" })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    let other_key = created["api_key"].as_str().unwrap();
    let (status, _) = app
        .call(
            Method::POST,
            "/api/v1/events/batch",
            Some(other_key),
            Some(json!({ "events": [start(&spec)] })),
        )
        .await;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "another project's key cannot write into this launch"
    );

    let (status, _) = app
        .call(
            Method::POST,
            "/api/v1/projects",
            Some("nope"),
            Some(json!({ "slug": "x", "name": "X" })),
        )
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _) = app
        .call(
            Method::POST,
            "/api/v1/projects",
            Some("admin-secret"),
            Some(json!({ "slug": "mobile", "name": "Again" })),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT);
}

#[sqlx::test(migrator = "klovplay_server::MIGRATOR")]
async fn live_subscribers_receive_diffs(db: PgPool) {
    let app = test_app(db).await;
    let launch_id = app.init_launch("run-live", 1, 1, 1).await;
    let mut live = app.app.state.live.subscribe(launch_id);

    let spec = TestSpec {
        launch_id,
        execution_id: Uuid::new_v4(),
        test_id: "t",
        title: "streams",
        file: "s.spec.ts",
        project: "chromium",
        retry: 0,
        at: 0,
    };
    app.send_ok(vec![
        start(&spec),
        TelemetryEvent::StepStart {
            launch_id,
            execution_id: spec.execution_id,
            step_id: Uuid::new_v4(),
            parent_step_id: None,
            title: "fill email".into(),
            category: "test.step".into(),
            timestamp: Utc::now(),
        },
    ])
    .await;
    let mut kinds = Vec::new();
    let mut saw_step = false;
    while let Ok(Ok(json)) = tokio::time::timeout(Duration::from_millis(500), live.recv()).await {
        let diff: SseStateDiff = serde_json::from_str(&json).unwrap();
        match &diff {
            SseStateDiff::WorkerActivity {
                worker_id,
                current_step,
                status,
                ..
            } => {
                assert_eq!(worker_id, "shard-1-worker-0");
                assert_eq!(status, "running");
                saw_step |= current_step.as_deref() == Some("fill email");
            }
            SseStateDiff::TestRowUpdated(row) => assert_eq!(row.status, "running"),
            SseStateDiff::CountersUpdated { running, .. } => assert_eq!(*running, 1),
            _ => {}
        }
        kinds.push(
            serde_json::to_value(&diff).unwrap()["kind"]
                .as_str()
                .unwrap()
                .to_owned(),
        );
    }
    assert!(kinds.contains(&"TEST_ROW_UPDATED".to_owned()), "{kinds:?}");
    assert!(kinds.contains(&"COUNTERS_UPDATED".to_owned()), "{kinds:?}");
    assert!(
        saw_step,
        "worker activity carries the current step: {kinds:?}"
    );

    let detail = app.get(&format!("/api/v1/launches/{launch_id}")).await;
    assert_eq!(detail["workers"][0]["current_step"], "fill email");
    assert_eq!(detail["workers"][0]["status"], "running");

    app.send_ok(vec![
        end(&spec, "passed", None),
        shard_end(launch_id, 1, "passed"),
    ])
    .await;
    let mut completed = false;
    while let Ok(Ok(json)) = tokio::time::timeout(Duration::from_millis(500), live.recv()).await {
        completed |= matches!(
            serde_json::from_str(&json).unwrap(),
            SseStateDiff::LaunchCompleted { .. }
        );
    }
    assert!(completed);
}

#[sqlx::test(migrator = "klovplay_server::MIGRATOR")]
async fn stale_launches_are_interrupted(db: PgPool) {
    let app = test_app(db.clone()).await;
    let launch_id = app.init_launch("run-stale", 1, 1, 2).await;
    let spec = TestSpec {
        launch_id,
        execution_id: Uuid::new_v4(),
        test_id: "t",
        title: "hangs",
        file: "h.spec.ts",
        project: "chromium",
        retry: 0,
        at: 0,
    };
    app.send_ok(vec![start(&spec)]).await;
    sqlx::query("UPDATE launches SET last_event_at = now() - interval '2 hours' WHERE id = $1")
        .bind(launch_id)
        .execute(&db)
        .await
        .unwrap();

    let reaped = klovplay_server::flusher::reap_stale_launches(&app.app.state)
        .await
        .unwrap();
    assert_eq!(reaped, 1);
    let detail = app.get(&format!("/api/v1/launches/{launch_id}")).await;
    assert_eq!(detail["launch"]["status"], "interrupted");
    assert_eq!(
        detail["launch"]["failed_count"], 1,
        "the hanging test is counted as interrupted"
    );
}

#[sqlx::test(migrator = "klovplay_server::MIGRATOR")]
async fn full_queue_is_answered_with_503(db: PgPool) {
    let mut config = config();
    config.ingest.channel_capacity = 2;
    let app = test_app_with(db, config).await;
    let launch_id = app.init_launch("run-full", 1, 1, 1).await;
    let spec = TestSpec {
        launch_id,
        execution_id: Uuid::new_v4(),
        test_id: "t",
        title: "t",
        file: "t.spec.ts",
        project: "",
        retry: 0,
        at: 0,
    };
    let (status, _) = app
        .send(vec![start(&spec), end(&spec, "passed", None)])
        .await;
    assert_eq!(
        status,
        StatusCode::SERVICE_UNAVAILABLE,
        "2 events + ack exceed a capacity of 2"
    );
    app.send_ok(vec![start(&spec)]).await;
}

#[sqlx::test(migrator = "klovplay_server::MIGRATOR")]
async fn runtime_annotations_replace_start_labels(db: PgPool) {
    let app = test_app(db).await;
    let launch_id = app.init_launch("run-labels", 1, 1, 1).await;
    let spec = TestSpec {
        launch_id,
        execution_id: Uuid::new_v4(),
        test_id: "t",
        title: "labels",
        file: "l.spec.ts",
        project: "chromium",
        retry: 0,
        at: 0,
    };
    let mut finished = end(&spec, "passed", None);
    if let TelemetryEvent::TestEnd { annotations, .. } = &mut finished {
        *annotations = Some(klovplay_schema::AllureAnnotations {
            owner: Some("payments-team".into()),
            epic: Some("Checkout".into()),
            ..Default::default()
        });
    }
    app.send_ok(vec![start(&spec), finished]).await;
    let execution = app
        .get(&format!("/api/v1/executions/{}", spec.execution_id))
        .await;
    assert_eq!(execution["test"]["annotations"]["owner"], "payments-team");
    assert_eq!(execution["test"]["annotations"]["epic"], "Checkout");
    assert!(execution["test"]["annotations"]["severity"].is_null());
}
