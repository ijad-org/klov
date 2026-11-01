//! "Copy retry command" helpers.

use std::collections::{BTreeMap, BTreeSet};

pub struct RetryTarget<'a> {
    pub file_path: &'a str,
    pub line: i32,
    pub browser_project: &'a str,
}

fn shell_quote(value: &str) -> String {
    if value
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || "-_./:@+=".contains(c))
    {
        value.to_owned()
    } else {
        format!("'{}'", value.replace('\'', r"'\''"))
    }
}

/// Builds `npx playwright test file:line … --project=…`, one command per browser project.
///
/// `file:line` targets exactly one test, unlike `-g "<title>"`, which is a regular
/// expression and can match other tests with similar titles.
pub fn retry_command<'a>(targets: impl IntoIterator<Item = RetryTarget<'a>>) -> Option<String> {
    // BTreeSet keeps locations unique and sorted by (file, line), so commands are stable.
    let mut by_project: BTreeMap<&str, BTreeSet<(&str, i32)>> = BTreeMap::new();
    for target in targets {
        by_project
            .entry(target.browser_project)
            .or_default()
            .insert((target.file_path, target.line));
    }
    if by_project.is_empty() {
        return None;
    }
    let commands: Vec<String> = by_project
        .into_iter()
        .map(|(project, locations)| {
            let files: Vec<String> = locations
                .into_iter()
                .map(|(file, line)| {
                    let location = if line > 0 {
                        format!("{file}:{line}")
                    } else {
                        file.to_owned()
                    };
                    shell_quote(&location)
                })
                .collect();
            let mut command = format!("npx playwright test {}", files.join(" "));
            if !project.is_empty() {
                command.push_str(&format!(" --project={}", shell_quote(project)));
            }
            command
        })
        .collect();
    Some(commands.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn groups_locations_by_project_and_dedupes() {
        let command = retry_command([
            RetryTarget {
                file_path: "tests/a.spec.ts",
                line: 12,
                browser_project: "chromium",
            },
            RetryTarget {
                file_path: "tests/b.spec.ts",
                line: 3,
                browser_project: "chromium",
            },
            RetryTarget {
                file_path: "tests/a.spec.ts",
                line: 12,
                browser_project: "chromium",
            },
            RetryTarget {
                file_path: "tests/a.spec.ts",
                line: 12,
                browser_project: "Mobile Safari",
            },
            RetryTarget {
                file_path: "tests/a.spec.ts",
                line: 9,
                browser_project: "chromium",
            },
        ])
        .unwrap();
        assert_eq!(
            command,
            "npx playwright test tests/a.spec.ts:12 --project='Mobile Safari'\n\
             npx playwright test tests/a.spec.ts:9 tests/a.spec.ts:12 tests/b.spec.ts:3 --project=chromium"
        );
    }

    #[test]
    fn empty_input_has_no_command() {
        assert_eq!(retry_command(Vec::new()), None);
    }
}
