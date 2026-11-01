//! "Copy retry command" helpers.

use std::collections::BTreeMap;

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
    let mut by_project: BTreeMap<&str, Vec<String>> = BTreeMap::new();
    for target in targets {
        let location = if target.line > 0 {
            format!("{}:{}", target.file_path, target.line)
        } else {
            target.file_path.to_owned()
        };
        let locations = by_project.entry(target.browser_project).or_default();
        if !locations.contains(&location) {
            locations.push(location);
        }
    }
    if by_project.is_empty() {
        return None;
    }
    let commands: Vec<String> = by_project
        .into_iter()
        .map(|(project, locations)| {
            let files: Vec<String> = locations.iter().map(|l| shell_quote(l)).collect();
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
        ])
        .unwrap();
        assert_eq!(
            command,
            "npx playwright test tests/a.spec.ts:12 --project='Mobile Safari'\n\
             npx playwright test tests/a.spec.ts:12 tests/b.spec.ts:3 --project=chromium"
        );
    }

    #[test]
    fn empty_input_has_no_command() {
        assert_eq!(retry_command(Vec::new()), None);
    }
}
