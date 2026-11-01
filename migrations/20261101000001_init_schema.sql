-- KlovPlay initial schema. PostgreSQL 13+ (gen_random_uuid() is built in).

CREATE TABLE projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug VARCHAR(64) UNIQUE NOT NULL,
    name VARCHAR(128) NOT NULL,
    api_key_hash VARCHAR(128) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE launches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    ci_run_id VARCHAR(128) NOT NULL,
    build_number VARCHAR(64),
    branch VARCHAR(128),
    commit_sha VARCHAR(64),
    status VARCHAR(24) NOT NULL DEFAULT 'running', -- running, passed, failed, interrupted
    -- Counters are recomputed from test_executions (never incremented), so
    -- re-delivered batches cannot double count.
    total_tests INT NOT NULL DEFAULT 0,
    passed_count INT NOT NULL DEFAULT 0,
    failed_count INT NOT NULL DEFAULT 0,
    flaky_count INT NOT NULL DEFAULT 0,
    skipped_count INT NOT NULL DEFAULT 0,
    running_count INT NOT NULL DEFAULT 0,
    total_shards INT NOT NULL DEFAULT 1,
    completed_shards INT NOT NULL DEFAULT 0,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ended_at TIMESTAMPTZ,
    -- Last ingestion activity; launches idle past the stale timeout are marked interrupted.
    last_event_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(project_id, ci_run_id)
);

-- One row per shard so LAUNCH_INIT and SHARD_END stay idempotent.
CREATE TABLE launch_shards (
    launch_id UUID NOT NULL REFERENCES launches(id) ON DELETE CASCADE,
    shard_index INT NOT NULL,
    total_tests INT NOT NULL DEFAULT 0,
    status VARCHAR(24), -- null while running; passed, failed, timedout, interrupted
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ended_at TIMESTAMPTZ,
    PRIMARY KEY (launch_id, shard_index)
);

-- One row per attempt. A retry starts a new execution and marks earlier
-- attempts of the same test as superseded; counters and history only look at
-- the latest attempt.
CREATE TABLE test_executions (
    id UUID PRIMARY KEY,
    launch_id UUID NOT NULL REFERENCES launches(id) ON DELETE CASCADE,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    fingerprint VARCHAR(64) NOT NULL, -- SHA-256(file + suite_path + title + browser_project)
    playwright_test_id VARCHAR(128) NOT NULL,
    title TEXT NOT NULL,
    file_path TEXT NOT NULL,
    line INT NOT NULL DEFAULT 0,
    suite_path TEXT[] NOT NULL DEFAULT '{}',
    browser_project VARCHAR(64) NOT NULL,
    worker_index INT NOT NULL DEFAULT 0,
    parallel_index INT NOT NULL DEFAULT 0,
    shard_index INT NOT NULL DEFAULT 1,
    retry_attempt INT NOT NULL DEFAULT 0,
    superseded BOOLEAN NOT NULL DEFAULT false,
    status VARCHAR(24) NOT NULL DEFAULT 'running', -- running, passed, failed, timedOut, skipped, interrupted, flaky
    duration_ms INT,
    error_message TEXT,
    error_stack TEXT,
    error_snippet TEXT,
    error_cluster_hash VARCHAR(64), -- SHA-256 of normalized message + top of stack
    annotations JSONB NOT NULL DEFAULT '{}'::jsonb, -- epic, feature, story, severity, owner, issue, tags
    stdout TEXT[] NOT NULL DEFAULT '{}',
    stderr TEXT[] NOT NULL DEFAULT '{}',
    started_at TIMESTAMPTZ NOT NULL,
    ended_at TIMESTAMPTZ
);

CREATE TABLE test_steps (
    id UUID PRIMARY KEY,
    execution_id UUID NOT NULL REFERENCES test_executions(id) ON DELETE CASCADE,
    parent_step_id UUID REFERENCES test_steps(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    category VARCHAR(32) NOT NULL, -- test.step, hook, fixture, pw:api, expect
    status VARCHAR(24) NOT NULL DEFAULT 'running',
    duration_ms INT,
    error_message TEXT,
    started_at TIMESTAMPTZ NOT NULL,
    ended_at TIMESTAMPTZ
);

CREATE TABLE artifacts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    execution_id UUID NOT NULL REFERENCES test_executions(id) ON DELETE CASCADE,
    name VARCHAR(128) NOT NULL, -- trace, screenshot, video
    content_type VARCHAR(64) NOT NULL,
    s3_key TEXT NOT NULL,
    size_bytes BIGINT NOT NULL DEFAULT 0,
    file_name TEXT,
    -- Set when the reporter confirms the pre-signed PUT finished.
    uploaded_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for real-time dashboard & historical sparklines
CREATE UNIQUE INDEX idx_projects_api_key ON projects(api_key_hash);
CREATE INDEX idx_launches_project_started ON launches(project_id, started_at DESC);
CREATE INDEX idx_launches_running ON launches(last_event_at) WHERE status = 'running';
CREATE INDEX idx_executions_launch_status ON test_executions(launch_id, status);
CREATE INDEX idx_executions_launch_test ON test_executions(launch_id, playwright_test_id, retry_attempt);
CREATE INDEX idx_executions_fingerprint_history ON test_executions(project_id, fingerprint, started_at DESC);
CREATE INDEX idx_executions_error_cluster ON test_executions(launch_id, error_cluster_hash) WHERE error_cluster_hash IS NOT NULL;
CREATE INDEX idx_steps_execution ON test_steps(execution_id, started_at ASC);
CREATE INDEX idx_artifacts_execution ON artifacts(execution_id);
