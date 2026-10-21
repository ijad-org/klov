# Klov for Playwright — phased plan (draft, awaiting approval)

Goal: a Klov-style report server for Playwright with a modern UI, results that
appear on the dashboard while tests are still running, and Allure-level depth
(history, flakiness, categories, timeline, rich attachments). It must scale to
many parallel CI runs.

The original Klov server has never been published as source, and its repository
has no licence. This is a clean-room build. The Klov data model is taken from the
Apache-2.0 `ExtentKlovReporter` in `extentreports-java`: projects, builds, tests,
logs, categories, authors, devices, exceptions, environment and media.

## Proposed architecture

```
Playwright run(s) ──HTTP batches──▶ Klov server (N replicas) ──▶ PostgreSQL
  custom reporter                    │                         ──▶ S3 or disk (screenshots, video, traces)
                                     └──live stream (SSE)──▶ browser dashboard
                   (replicas share live updates through Postgres LISTEN/NOTIFY)
```

- **TypeScript throughout.** Playwright Test's reporter API only runs in Node.
- **PostgreSQL instead of MongoDB.** Trends, flakiness and history are SQL-shaped
  queries, and LISTEN/NOTIFY shares live updates between servers without Redis.
- **Server-Sent Events** for live updates: one-way, works through proxies, and
  the browser reconnects on its own.
- **Save results, stream progress.** Each test is saved when it finishes. The
  "currently running step" is broadcast but never stored, so database load stays
  flat as suites grow.
- **Safe to retry.** Every event can be sent twice without changing the result,
  and attachments carry their own IDs, so they can arrive in any order. Reporting
  is best-effort: if the server is down, tests still run and pass or fail normally.

## Phases

### Phase 0: Decisions and spec
- Settle the open questions below.
- Write a 1–2 page spec: event format, data model, and a feature checklist (Klov
  features plus the Allure features we want).
- Done when: the spec is approved.

### Phase 1: Live results, minimal version
- The reporter sends run start, the list of planned tests, test start and end, and run end.
- The server stores them and pushes them to the dashboard straight away.
- Minimal UI: a list of runs, and a run page with a live progress bar and a test
  list that fills in as tests finish.
- An example Playwright suite.
- Done when: an automated test shows results reaching the dashboard while the run
  is still going.

### Phase 2: Match Klov, plus rich test detail
- Projects and builds.
- A detail page per test: retries, errors with the failing code line, the step
  tree, and console output.
- Attachments: screenshots, video, and Playwright traces that open in the trace
  viewer with one click.
- Statuses: passed, failed, broken, flaky and skipped.
- Klov's views carried over: categories become tags, authors become a test owner,
  devices become browser projects, exceptions become groups of similar errors.
  Environment and CI details (branch, commit, build link) are shown.
- Sharded CI jobs merge into one report.
- Done when: every item on the checklist can be demonstrated.

### Phase 3: Allure-style analytics
- Project dashboard with pass-rate and duration trends across builds.
- History for each test, a ranking of flaky tests, and lists of the most-failing
  and slowest tests.
- Failure categories with configurable rules (like Allure's `categories.json`),
  and grouping of similar errors.
- A timeline of what each parallel worker ran.
- "New failures and fixes since the last run on this branch".
- Severity, owner, epic/feature/story and issue links, taken from test annotations.

### Phase 4: Scale, security, operations
- Agree load targets and load-test against them.
- S3-compatible storage, multiple servers, retention rules, and automatic cleanup
  of runs whose reporter crashed.
- Per-project tokens for uploading results, and single sign-on for the dashboard.
- Docker image, Helm chart, CI pipeline and metrics.

### Phase 5: Other languages and add-ons (optional)
- Reporters for Playwright Java, Python and .NET using the same HTTP API.
- A bridge from ExtentReports so existing Klov users can move over.
- A command-line tool to upload results after the fact.
- Slack and webhook alerts, and muting of known-flaky tests.

## Open questions (needed before Phase 1)
1. Which Playwright: Playwright Test (TypeScript/JavaScript), or Playwright Java
   with TestNG or JUnit?
2. Where should it live? This repository has no licence. Options: a new repo, or
   adding an Apache-2.0 licence for the new code.
3. Is PostgreSQL acceptable, or is MongoDB required?
4. Scale and login: tests per run, runs per day, parallel CI jobs, and whether
   single sign-on is needed.

## Status of the code in this branch
The `packages/` folder holds an early draft written before this plan existed:
- workspace layout
- a draft event format (`packages/shared`)
- a draft Postgres schema and server config (`packages/server`)

`docker-compose.yml` was moved to `legacy/`. Work on it is paused until the plan
is approved. It can be revised or dropped.
