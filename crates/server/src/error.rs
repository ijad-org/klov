use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use klovplay_schema::ApiError;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("not found")]
    NotFound,
    #[error("missing or invalid credentials")]
    Unauthorized,
    #[error("{0}")]
    Forbidden(String),
    #[error("{0}")]
    BadRequest(String),
    #[error("{0}")]
    Conflict(String),
    /// The request was well-formed but could not be stored; retrying will not help.
    #[error("{0}")]
    Unprocessable(String),
    /// Temporary overload or outage; clients should retry after a delay.
    #[error("{0}")]
    Unavailable(String),
    #[error(transparent)]
    Internal(#[from] anyhow::Error),
}

pub type AppResult<T> = Result<T, AppError>;

impl From<sqlx::Error> for AppError {
    fn from(error: sqlx::Error) -> Self {
        match error {
            sqlx::Error::RowNotFound => AppError::NotFound,
            other => AppError::Internal(other.into()),
        }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let status = match &self {
            AppError::NotFound => StatusCode::NOT_FOUND,
            AppError::Unauthorized => StatusCode::UNAUTHORIZED,
            AppError::Forbidden(_) => StatusCode::FORBIDDEN,
            AppError::BadRequest(_) => StatusCode::BAD_REQUEST,
            AppError::Conflict(_) => StatusCode::CONFLICT,
            AppError::Unprocessable(_) => StatusCode::UNPROCESSABLE_ENTITY,
            AppError::Unavailable(_) => StatusCode::SERVICE_UNAVAILABLE,
            AppError::Internal(error) => {
                tracing::error!(error = ?error, "request failed");
                StatusCode::INTERNAL_SERVER_ERROR
            }
        };
        let message = match &self {
            AppError::Internal(_) => "internal server error".to_string(),
            other => other.to_string(),
        };
        let mut response = (status, Json(ApiError { error: message })).into_response();
        if status == StatusCode::SERVICE_UNAVAILABLE {
            response
                .headers_mut()
                .insert("retry-after", "1".parse().expect("static header"));
        }
        response
    }
}
