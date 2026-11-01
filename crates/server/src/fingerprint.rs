//! Deterministic test fingerprints and failure clustering.

use std::sync::LazyLock;

use regex::Regex;
use sha2::{Digest, Sha256};

/// Links one test across launches: SHA-256 of `file::suite>path::title::project`.
pub fn test_fingerprint(
    file_path: &str,
    suite_path: &[String],
    title: &str,
    browser_project: &str,
) -> String {
    let input = format!(
        "{}::{}::{}::{}",
        file_path,
        suite_path.join(">"),
        title,
        browser_project
    );
    hex::encode(Sha256::digest(input.as_bytes()))
}

static ANSI: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07").unwrap());
static UUID: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b").unwrap()
});
static TIMESTAMP: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b|\b\d{2}:\d{2}:\d{2}(?:\.\d+)?\b|\b1\d{12}\b").unwrap()
});
static ADDRESS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\b0x[0-9a-f]{4,}\b").unwrap());
static PORT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)\b(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|[a-z0-9.-]+\.[a-z]{2,}):\d{2,5}\b",
    )
    .unwrap()
});
static ABSOLUTE_DIR: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?:[A-Za-z]:)?(?:[/\\][^\s/\\:()'"]+)+[/\\]"#).unwrap());
static LONG_NUMBER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\b\d{6,}\b").unwrap());
static WHITESPACE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[ \t]+").unwrap());

pub fn strip_ansi(text: &str) -> String {
    ANSI.replace_all(text, "").into_owned()
}

/// Removes values that change between runs (ids, times, ports, addresses, machine paths)
/// so the same root cause hashes the same everywhere.
pub fn normalize_error(message: &str, stack: Option<&str>) -> String {
    let message = strip_ansi(message);
    // Playwright appends a call log whose content is timing dependent.
    let message = message.split("Call log:").next().unwrap_or_default();
    let stack_head: Vec<String> = stack
        .map(|s| {
            strip_ansi(s)
                .lines()
                .map(str::trim)
                .filter(|l| l.starts_with("at "))
                .take(3)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    let mut text = message.trim().to_owned();
    for line in stack_head {
        text.push('\n');
        text.push_str(&line);
    }
    let text = UUID.replace_all(&text, "<uuid>");
    let text = TIMESTAMP.replace_all(&text, "<time>");
    let text = ADDRESS.replace_all(&text, "<addr>");
    let text = PORT.replace_all(&text, "$1:<port>");
    let text = ABSOLUTE_DIR.replace_all(&text, "");
    let text = LONG_NUMBER.replace_all(&text, "<n>");
    WHITESPACE.replace_all(&text, " ").trim().to_owned()
}

pub fn error_cluster_hash(message: Option<&str>, stack: Option<&str>) -> Option<String> {
    let message = message.filter(|m| !m.trim().is_empty())?;
    Some(hex::encode(Sha256::digest(
        normalize_error(message, stack).as_bytes(),
    )))
}

/// First meaningful line of an error, for cluster titles.
pub fn signature(message: &str) -> String {
    let clean = strip_ansi(message);
    let line = clean
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or_default();
    let mut line = line.to_owned();
    if line.len() > 300 {
        let cut = (0..=300)
            .rev()
            .find(|i| line.is_char_boundary(*i))
            .unwrap_or(0);
        line.truncate(cut);
        line.push('…');
    }
    line
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fingerprint_is_stable_and_project_specific() {
        let suite = vec!["Login".to_string(), "valid user".to_string()];
        let a = test_fingerprint("tests/auth.spec.ts", &suite, "signs in", "chromium");
        assert_eq!(
            a,
            test_fingerprint("tests/auth.spec.ts", &suite, "signs in", "chromium")
        );
        assert_ne!(
            a,
            test_fingerprint("tests/auth.spec.ts", &suite, "signs in", "firefox")
        );
        assert_eq!(a.len(), 64);
    }

    #[test]
    fn cluster_hash_ignores_volatile_values() {
        let a = "Error: GET http://localhost:51234/api/orders/3f2b8c1e-1d2a-4b9e-9c3f-2a1b3c4d5e6f failed at 2026-11-01T10:00:01Z";
        let b = "Error: GET http://localhost:40012/api/orders/9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d failed at 2026-11-02T22:13:59Z";
        let stack_a = "Error: x\n    at /home/runner/work/app/tests/orders.spec.ts:12:5\n    at /home/runner/work/app/node_modules/x.js:1:1";
        let stack_b = "Error: x\n    at /Users/dev/app/tests/orders.spec.ts:12:5\n    at /Users/dev/app/node_modules/x.js:1:1";
        assert_eq!(
            error_cluster_hash(Some(a), Some(stack_a)),
            error_cluster_hash(Some(b), Some(stack_b))
        );
    }

    #[test]
    fn cluster_hash_separates_different_failures_and_skips_empty() {
        let a = error_cluster_hash(
            Some(
                "Error: expect(locator).toBeVisible() failed\n\nLocator: getByRole('button', { name: 'Pay' })",
            ),
            None,
        );
        let b = error_cluster_hash(
            Some(
                "Error: expect(locator).toBeVisible() failed\n\nLocator: getByRole('link', { name: 'Home' })",
            ),
            None,
        );
        assert_ne!(a, b);
        assert_eq!(error_cluster_hash(Some("  "), None), None);
        assert_eq!(error_cluster_hash(None, None), None);
    }

    #[test]
    fn normalize_strips_ansi_and_call_log() {
        let message = "\u{1b}[31mError: Timed out 5000ms waiting for expect(locator).toHaveText(expected)\u{1b}[39m\n\nCall log:\n  - waiting for locator 0x7ffd5e2a";
        assert_eq!(
            normalize_error(message, None),
            "Error: Timed out 5000ms waiting for expect(locator).toHaveText(expected)"
        );
    }

    #[test]
    fn signature_takes_first_non_empty_line() {
        assert_eq!(
            signature("\n\u{1b}[2mError: boom\u{1b}[22m\nmore"),
            "Error: boom"
        );
    }
}
