//! Project API keys (reporter → server) and the admin token.

use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::FromRequestParts;
use axum::http::header::AUTHORIZATION;
use axum::http::request::Parts;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::error::AppError;
use crate::state::AppState;

const KEY_CACHE_TTL: Duration = Duration::from_secs(60);

/// A random, high-entropy key. Only its SHA-256 is stored, so a fast hash is enough.
pub fn generate_api_key() -> String {
    let bytes: [u8; 24] = rand::random();
    format!("kp_{}", hex::encode(bytes))
}

pub fn hash_api_key(key: &str) -> String {
    hex::encode(Sha256::digest(key.as_bytes()))
}

fn bearer(parts: &Parts) -> Option<&str> {
    parts
        .headers
        .get(AUTHORIZATION)?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
        .map(str::trim)
        .filter(|token| !token.is_empty())
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[derive(Debug, Clone)]
pub struct ProjectAuth {
    pub project_id: Uuid,
    pub slug: String,
}

impl FromRequestParts<Arc<AppState>> for ProjectAuth {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &Arc<AppState>,
    ) -> Result<Self, Self::Rejection> {
        let key = bearer(parts).ok_or(AppError::Unauthorized)?;
        let hash = hash_api_key(key);
        if let Some(entry) = state.key_cache.get(&hash)
            && entry.1.elapsed() < KEY_CACHE_TTL
        {
            return Ok(entry.0.clone());
        }
        let row = sqlx::query!(
            "SELECT id, slug FROM projects WHERE api_key_hash = $1",
            hash
        )
        .fetch_optional(&state.db)
        .await?
        .ok_or(AppError::Unauthorized)?;
        let auth = ProjectAuth {
            project_id: row.id,
            slug: row.slug,
        };
        state.key_cache.insert(hash, (auth.clone(), Instant::now()));
        Ok(auth)
    }
}

impl ProjectAuth {
    /// Ensures every launch belongs to this project, so one project's key cannot write into another's launches.
    pub async fn check_launches(
        &self,
        state: &AppState,
        launch_ids: &[Uuid],
    ) -> Result<(), AppError> {
        let mut unknown = Vec::new();
        for id in launch_ids {
            match state.launch_owners.get(id) {
                Some(owner) if *owner == self.project_id => {}
                Some(_) => {
                    return Err(AppError::Forbidden(format!(
                        "launch {id} belongs to another project"
                    )));
                }
                None => unknown.push(*id),
            }
        }
        if unknown.is_empty() {
            return Ok(());
        }
        let rows = sqlx::query!(
            "SELECT id, project_id FROM launches WHERE id = ANY($1)",
            &unknown
        )
        .fetch_all(&state.db)
        .await?;
        for row in &rows {
            state.launch_owners.insert(row.id, row.project_id);
            if row.project_id != self.project_id {
                return Err(AppError::Forbidden(format!(
                    "launch {} belongs to another project",
                    row.id
                )));
            }
        }
        if rows.len() != unknown.len() {
            return Err(AppError::BadRequest(
                "unknown launch_id; call /api/v1/launches/init first".into(),
            ));
        }
        Ok(())
    }
}

/// Requires `Authorization: Bearer <ADMIN_TOKEN>`.
pub struct AdminAuth;

impl FromRequestParts<Arc<AppState>> for AdminAuth {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &Arc<AppState>,
    ) -> Result<Self, Self::Rejection> {
        let Some(expected) = state.config.admin_token.as_deref() else {
            return Err(AppError::Forbidden(
                "admin endpoints are disabled: set ADMIN_TOKEN".into(),
            ));
        };
        match bearer(parts) {
            Some(token) if constant_time_eq(token.as_bytes(), expected.as_bytes()) => Ok(AdminAuth),
            _ => Err(AppError::Unauthorized),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn api_keys_are_random_and_hash_deterministically() {
        let a = generate_api_key();
        let b = generate_api_key();
        assert_ne!(a, b);
        assert!(a.starts_with("kp_") && a.len() == 51);
        assert_eq!(hash_api_key(&a), hash_api_key(&a));
        assert_eq!(hash_api_key(&a).len(), 64);
    }

    #[test]
    fn constant_time_eq_compares_content_and_length() {
        assert!(constant_time_eq(b"secret", b"secret"));
        assert!(!constant_time_eq(b"secret", b"secreT"));
        assert!(!constant_time_eq(b"secret", b"secret1"));
    }
}
