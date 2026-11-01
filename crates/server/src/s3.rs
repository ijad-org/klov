//! S3-compatible artifact storage. Bytes never pass through the server:
//! reporters PUT and browsers GET with pre-signed URLs.

use std::time::Duration;

use anyhow::Context;
use aws_sdk_s3::Client;
use aws_sdk_s3::config::{
    BehaviorVersion, Credentials, Region, RequestChecksumCalculation, ResponseChecksumValidation,
};
use aws_sdk_s3::presigning::PresigningConfig;
use aws_sdk_s3::types::{
    BucketLocationConstraint, CorsConfiguration, CorsRule, CreateBucketConfiguration,
};
use uuid::Uuid;

use crate::config::S3Config;

#[derive(Clone)]
pub struct Storage {
    /// Talks to `S3_ENDPOINT` (may be a private address).
    client: Client,
    /// Signs URLs for `S3_PUBLIC_ENDPOINT`; the host is part of the signature.
    presigner: Client,
    bucket: String,
    region: String,
    ttl: Duration,
}

async fn build_client(config: &S3Config, endpoint: Option<&str>) -> Client {
    let shared = aws_config::defaults(BehaviorVersion::latest())
        .region(Region::new(config.region.clone()))
        .load()
        .await;
    let mut builder = aws_sdk_s3::config::Builder::from(&shared)
        .force_path_style(config.force_path_style)
        // Checksums baked into pre-signed URLs would force clients to send matching
        // headers, which S3-compatible stores handle inconsistently.
        .request_checksum_calculation(RequestChecksumCalculation::WhenRequired)
        .response_checksum_validation(ResponseChecksumValidation::WhenRequired);
    if let Some(endpoint) = endpoint {
        builder = builder.endpoint_url(endpoint);
    }
    if let (Some(id), Some(secret)) = (&config.access_key_id, &config.secret_access_key) {
        builder = builder.credentials_provider(Credentials::new(
            id,
            secret,
            None,
            None,
            "klovplay-static",
        ));
    }
    Client::from_conf(builder.build())
}

impl Storage {
    pub async fn new(config: &S3Config) -> Self {
        let client = build_client(config, config.endpoint.as_deref()).await;
        let presigner = build_client(
            config,
            config
                .public_endpoint
                .as_deref()
                .or(config.endpoint.as_deref()),
        )
        .await;
        Storage {
            client,
            presigner,
            bucket: config.bucket.clone(),
            region: config.region.clone(),
            ttl: Duration::from_secs(config.presign_ttl_secs),
        }
    }

    /// Creates the bucket if needed and allows browsers to fetch artifacts cross-origin
    /// (the embedded trace viewer loads trace.zip with `fetch`).
    pub async fn ensure_bucket(&self, cors_origins: &str) -> anyhow::Result<()> {
        if self
            .client
            .head_bucket()
            .bucket(&self.bucket)
            .send()
            .await
            .is_err()
        {
            let mut request = self.client.create_bucket().bucket(&self.bucket);
            if self.region != "us-east-1" {
                request = request.create_bucket_configuration(
                    CreateBucketConfiguration::builder()
                        .location_constraint(BucketLocationConstraint::from(self.region.as_str()))
                        .build(),
                );
            }
            if let Err(error) = request.send().await {
                let service = error.as_service_error();
                let exists = service.is_some_and(|e| {
                    e.is_bucket_already_owned_by_you() || e.is_bucket_already_exists()
                });
                if !exists {
                    return Err(error).context(format!("creating bucket {}", self.bucket));
                }
            }
            tracing::info!(bucket = %self.bucket, "created artifact bucket");
        }
        let origins: Vec<String> = cors_origins
            .split(',')
            .map(|o| o.trim().to_owned())
            .filter(|o| !o.is_empty())
            .collect();
        let rule = CorsRule::builder()
            .set_allowed_origins(Some(origins))
            .allowed_methods("GET")
            .allowed_methods("HEAD")
            .allowed_methods("PUT")
            .allowed_headers("*")
            .expose_headers("ETag")
            .expose_headers("Content-Length")
            .expose_headers("Content-Range")
            .max_age_seconds(3600)
            .build()?;
        self.client
            .put_bucket_cors()
            .bucket(&self.bucket)
            .cors_configuration(CorsConfiguration::builder().cors_rules(rule).build()?)
            .send()
            .await
            .context("configuring bucket CORS")?;
        Ok(())
    }

    pub async fn presign_put(&self, key: &str, content_type: &str) -> anyhow::Result<String> {
        let request = self
            .presigner
            .put_object()
            .bucket(&self.bucket)
            .key(key)
            .content_type(content_type)
            .presigned(PresigningConfig::expires_in(self.ttl)?)
            .await?;
        Ok(request.uri().to_string())
    }

    pub async fn presign_get(
        &self,
        key: &str,
        content_type: &str,
        file_name: Option<&str>,
    ) -> anyhow::Result<String> {
        let mut request = self
            .presigner
            .get_object()
            .bucket(&self.bucket)
            .key(key)
            .response_content_type(content_type);
        if let Some(name) = file_name {
            let safe: String = name
                .chars()
                .filter(|c| *c != '"' && !c.is_control())
                .collect();
            request = request.response_content_disposition(format!("inline; filename=\"{safe}\""));
        }
        Ok(request
            .presigned(PresigningConfig::expires_in(self.ttl)?)
            .await?
            .uri()
            .to_string())
    }

    /// Size of a stored object, or `None` if it does not exist.
    pub async fn object_size(&self, key: &str) -> anyhow::Result<Option<i64>> {
        match self
            .client
            .head_object()
            .bucket(&self.bucket)
            .key(key)
            .send()
            .await
        {
            Ok(head) => Ok(Some(head.content_length().unwrap_or(0))),
            Err(error) if error.as_service_error().is_some_and(|e| e.is_not_found()) => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    pub async fn delete_prefix(&self, prefix: &str) -> anyhow::Result<()> {
        let mut pages = self
            .client
            .list_objects_v2()
            .bucket(&self.bucket)
            .prefix(prefix)
            .into_paginator()
            .send();
        while let Some(page) = pages.next().await {
            for object in page?.contents() {
                if let Some(key) = object.key() {
                    self.client
                        .delete_object()
                        .bucket(&self.bucket)
                        .key(key)
                        .send()
                        .await?;
                }
            }
        }
        Ok(())
    }
}

fn sanitize_file_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') {
                c
            } else {
                '_'
            }
        })
        .take(100)
        .collect();
    if cleaned.is_empty() {
        "artifact".into()
    } else {
        cleaned
    }
}

pub fn artifact_key(
    project_id: Uuid,
    launch_id: Uuid,
    execution_id: Uuid,
    artifact_id: Uuid,
    file_name: &str,
) -> String {
    format!(
        "projects/{project_id}/launches/{launch_id}/{execution_id}/{artifact_id}/{}",
        sanitize_file_name(file_name)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_are_scoped_and_safe() {
        let id = Uuid::nil();
        assert_eq!(
            artifact_key(id, id, id, id, "../trace file?.zip"),
            format!("projects/{id}/launches/{id}/{id}/{id}/.._trace_file_.zip")
        );
        assert!(artifact_key(id, id, id, id, "").ends_with("/artifact"));
    }
}
