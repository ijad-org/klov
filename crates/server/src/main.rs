use std::time::Duration;

use anyhow::Context;
use clap::Parser;
use klovplay_server::App;
use klovplay_server::config::{Cli, Command, Config};
use klovplay_server::s3::Storage;
use sqlx::postgres::PgPoolOptions;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info,sqlx=warn")),
        )
        .init();

    let db = PgPoolOptions::new()
        .max_connections(cli.config.db_max_connections)
        .acquire_timeout(Duration::from_secs(10))
        .connect(&cli.config.database_url)
        .await
        .context("connecting to PostgreSQL")?;
    klovplay_server::MIGRATOR
        .run(&db)
        .await
        .context("running migrations")?;

    match cli.command.unwrap_or(Command::Serve) {
        Command::Migrate => {
            tracing::info!("migrations applied");
            Ok(())
        }
        Command::CreateProject { slug, name } => {
            let name = name.unwrap_or_else(|| slug.clone());
            let (project, api_key) =
                klovplay_server::routes::projects::create_project(&db, &slug, &name)
                    .await
                    .map_err(|e| anyhow::anyhow!(e.to_string()))?;
            println!("Created project '{}' ({})", project.slug, project.id);
            println!("API key (shown once): {api_key}");
            Ok(())
        }
        Command::Serve => serve(cli.config, db).await,
    }
}

async fn serve(config: Config, db: sqlx::PgPool) -> anyhow::Result<()> {
    let storage = Storage::new(&config.s3).await;
    if config.s3.ensure_bucket {
        // The storage container may still be starting.
        let mut attempt = 0;
        loop {
            match storage.ensure_bucket(&config.s3.cors_origins).await {
                Ok(()) => break,
                Err(error) if attempt < 30 => {
                    attempt += 1;
                    tracing::warn!(%error, attempt, "artifact storage not ready, retrying");
                    tokio::time::sleep(Duration::from_secs(1)).await;
                }
                Err(error) => return Err(error.context("preparing the artifact bucket")),
            }
        }
    }

    let bind_addr = config.bind_addr;
    let app = App::build(config, db, storage).await;
    let listener = tokio::net::TcpListener::bind(bind_addr)
        .await
        .with_context(|| format!("binding {bind_addr}"))?;
    tracing::info!(%bind_addr, "KlovPlay server listening");
    axum::serve(listener, app.router.clone())
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    tracing::info!("HTTP server stopped, flushing pending events");
    app.shutdown().await;
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut signal) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            signal.recv().await;
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {}
        _ = terminate => {}
    }
}
