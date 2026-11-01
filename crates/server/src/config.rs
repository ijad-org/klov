use std::net::SocketAddr;
use std::path::PathBuf;
use std::time::Duration;

use clap::{Parser, Subcommand};

#[derive(Debug, Clone, Parser)]
#[command(
    name = "klovplay-server",
    version,
    about = "Real-time Playwright reporting server"
)]
pub struct Cli {
    #[command(subcommand)]
    pub command: Option<Command>,

    #[command(flatten)]
    pub config: Config,
}

#[derive(Debug, Clone, Subcommand)]
pub enum Command {
    /// Run the HTTP server (default).
    Serve,
    /// Apply database migrations and exit.
    Migrate,
    /// Create a project and print its API key.
    CreateProject {
        #[arg(long)]
        slug: String,
        #[arg(long)]
        name: Option<String>,
    },
}

#[derive(Debug, Clone, clap::Args)]
pub struct Config {
    #[arg(long, env = "BIND_ADDR", default_value = "0.0.0.0:8080")]
    pub bind_addr: SocketAddr,

    #[arg(long, env = "DATABASE_URL")]
    pub database_url: String,

    #[arg(long, env = "DB_MAX_CONNECTIONS", default_value_t = 20)]
    pub db_max_connections: u32,

    /// Base URL of the dashboard, used in links returned to reporters.
    #[arg(long, env = "PUBLIC_URL", default_value = "http://localhost:8080")]
    pub public_url: String,

    /// Bearer token for admin endpoints (project creation). Admin endpoints are disabled when unset.
    #[arg(long, env = "ADMIN_TOKEN", hide_env_values = true)]
    pub admin_token: Option<String>,

    /// Directory with the built dashboard (apps/web/dist).
    #[arg(long, env = "WEB_DIR", default_value = "apps/web/dist")]
    pub web_dir: PathBuf,

    #[command(flatten)]
    pub s3: S3Config,

    #[command(flatten)]
    pub ingest: IngestConfig,
}

#[derive(Debug, Clone, clap::Args)]
pub struct S3Config {
    #[arg(
        long = "s3-bucket",
        env = "S3_BUCKET",
        default_value = "klovplay-artifacts"
    )]
    pub bucket: String,

    #[arg(long = "s3-region", env = "S3_REGION", default_value = "us-east-1")]
    pub region: String,

    /// Endpoint the server uses (e.g. http://s3:9000 inside docker-compose). Defaults to AWS.
    #[arg(long = "s3-endpoint", env = "S3_ENDPOINT")]
    pub endpoint: Option<String>,

    /// Endpoint embedded in pre-signed URLs; must be reachable by reporters and browsers.
    #[arg(long = "s3-public-endpoint", env = "S3_PUBLIC_ENDPOINT")]
    pub public_endpoint: Option<String>,

    #[arg(
        long = "s3-force-path-style",
        env = "S3_FORCE_PATH_STYLE",
        default_value_t = false
    )]
    pub force_path_style: bool,

    /// Static credentials; the default AWS credential chain is used when unset.
    #[arg(
        long = "s3-access-key-id",
        env = "S3_ACCESS_KEY_ID",
        hide_env_values = true
    )]
    pub access_key_id: Option<String>,

    #[arg(
        long = "s3-secret-access-key",
        env = "S3_SECRET_ACCESS_KEY",
        hide_env_values = true
    )]
    pub secret_access_key: Option<String>,

    /// Create the bucket and its CORS rule at startup.
    #[arg(
        long = "s3-ensure-bucket",
        env = "S3_ENSURE_BUCKET",
        default_value_t = false
    )]
    pub ensure_bucket: bool,

    /// Comma-separated origins allowed to fetch artifacts from the bucket (the trace viewer needs this).
    #[arg(long = "s3-cors-origins", env = "S3_CORS_ORIGINS", default_value = "*")]
    pub cors_origins: String,

    #[arg(
        long = "presign-ttl-secs",
        env = "PRESIGN_TTL_SECS",
        default_value_t = 3600
    )]
    pub presign_ttl_secs: u64,
}

#[derive(Debug, Clone, clap::Args)]
pub struct IngestConfig {
    /// Capacity of the ingestion channel, in events.
    #[arg(long, env = "INGEST_CHANNEL_CAPACITY", default_value_t = 50_000)]
    pub channel_capacity: usize,

    /// Maximum events persisted per database transaction.
    #[arg(long, env = "FLUSH_MAX_EVENTS", default_value_t = 250)]
    pub flush_max_events: usize,

    /// Maximum time events wait in the channel before being persisted.
    #[arg(long, env = "FLUSH_INTERVAL_MS", default_value_t = 200)]
    pub flush_interval_ms: u64,

    /// Minimum interval between counter recomputations for one launch.
    #[arg(long, env = "COUNTERS_INTERVAL_MS", default_value_t = 500)]
    pub counters_interval_ms: u64,

    /// Launches without any activity for this long are marked interrupted.
    #[arg(long, env = "STALE_LAUNCH_MINUTES", default_value_t = 30)]
    pub stale_launch_minutes: i64,

    /// Maximum size of one event batch request body.
    #[arg(long, env = "MAX_BATCH_MB", default_value_t = 32)]
    pub max_batch_mb: usize,
}

impl IngestConfig {
    pub fn flush_interval(&self) -> Duration {
        Duration::from_millis(self.flush_interval_ms)
    }

    pub fn counters_interval(&self) -> Duration {
        Duration::from_millis(self.counters_interval_ms)
    }
}

impl Config {
    pub fn dashboard_url(&self, path: &str) -> String {
        format!(
            "{}/{}",
            self.public_url.trim_end_matches('/'),
            path.trim_start_matches('/')
        )
    }
}
