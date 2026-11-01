import { execFileSync } from 'node:child_process';
import { relative, sep } from 'node:path';

import type { TestCase, TestResult } from '@playwright/test/reporter';

import type { AllureAnnotations } from './generated/AllureAnnotations';

type Annotation = { type: string; description?: string };

const LABELS = ['epic', 'feature', 'story', 'severity', 'owner', 'issue'] as const;
type Label = (typeof LABELS)[number];

function isLabel(value: string): value is Label {
  return (LABELS as readonly string[]).includes(value);
}

/**
 * Maps Playwright annotations and tags to Allure-style labels.
 *
 * - annotations: `{ type: 'severity', description: 'critical' }`
 * - tags: `@severity:critical` or `@owner=alice`; any other tag is kept as a tag.
 */
export function parseAnnotations(annotations: readonly Annotation[], tags: readonly string[]): AllureAnnotations {
  const result: AllureAnnotations = { tags: [] };
  for (const annotation of annotations) {
    const type = annotation.type.toLowerCase();
    if (isLabel(type) && annotation.description) result[type] = annotation.description;
    else if (type === 'tag' && annotation.description) result.tags.push(annotation.description);
  }
  for (const tag of tags) {
    const match = /^@?([a-z]+)[:=](.+)$/i.exec(tag);
    const key = match?.[1].toLowerCase();
    if (match && key && isLabel(key)) result[key] = match[2];
    else if (!result.tags.includes(tag)) result.tags.push(tag);
  }
  return result;
}

export interface CiInfo {
  runId?: string;
  buildNumber?: string;
  branch?: string;
  commitSha?: string;
}

const nonEmpty = (value: string | undefined) => (value && value.trim() ? value.trim() : undefined);

/** Detects run, build, branch and commit from common CI providers. */
export function detectCi(env: NodeJS.ProcessEnv): CiInfo {
  if (env.GITHUB_ACTIONS) {
    return {
      runId: env.GITHUB_RUN_ID && `gh-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT ?? '1'}`,
      buildNumber: env.GITHUB_RUN_NUMBER,
      branch: nonEmpty(env.GITHUB_HEAD_REF) ?? env.GITHUB_REF_NAME,
      commitSha: env.GITHUB_SHA,
    };
  }
  if (env.GITLAB_CI) {
    return {
      runId: env.CI_PIPELINE_ID && `gl-${env.CI_PIPELINE_ID}`,
      buildNumber: env.CI_PIPELINE_IID,
      branch: env.CI_COMMIT_REF_NAME,
      commitSha: env.CI_COMMIT_SHA,
    };
  }
  if (env.CIRCLECI) {
    return {
      runId: env.CIRCLE_WORKFLOW_ID && `circle-${env.CIRCLE_WORKFLOW_ID}`,
      buildNumber: env.CIRCLE_BUILD_NUM,
      branch: env.CIRCLE_BRANCH,
      commitSha: env.CIRCLE_SHA1,
    };
  }
  if (env.BUILDKITE) {
    return {
      runId: env.BUILDKITE_BUILD_ID && `bk-${env.BUILDKITE_BUILD_ID}`,
      buildNumber: env.BUILDKITE_BUILD_NUMBER,
      branch: env.BUILDKITE_BRANCH,
      commitSha: env.BUILDKITE_COMMIT,
    };
  }
  if (env.TF_BUILD) {
    return {
      runId: env.BUILD_BUILDID && `azure-${env.BUILD_BUILDID}`,
      buildNumber: env.BUILD_BUILDNUMBER,
      branch: env.BUILD_SOURCEBRANCHNAME,
      commitSha: env.BUILD_SOURCEVERSION,
    };
  }
  if (env.JENKINS_URL) {
    return {
      runId: env.BUILD_TAG,
      buildNumber: env.BUILD_NUMBER,
      branch: env.BRANCH_NAME ?? env.GIT_BRANCH?.replace(/^origin\//, ''),
      commitSha: env.GIT_COMMIT,
    };
  }
  return {};
}

/** Branch and commit of a local checkout, for runs outside CI. */
export function detectGit(cwd: string): Pick<CiInfo, 'branch' | 'commitSha'> {
  const git = (...args: string[]) => {
    try {
      return nonEmpty(execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2_000 }));
    } catch {
      return undefined;
    }
  };
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  return { branch: branch === 'HEAD' ? undefined : branch, commitSha: git('rev-parse', 'HEAD') };
}

/** Path relative to the Playwright root, `/`-separated, so fingerprints match on every machine. */
export function relativePath(rootDir: string, file: string): string {
  const rel = relative(rootDir, file) || file;
  return sep === '/' ? rel : rel.split(sep).join('/');
}

/** Titles of the describe() blocks around a test, outermost first. */
export function suitePath(test: TestCase): string[] {
  const titles: string[] = [];
  for (let suite = test.parent; suite && suite.type === 'describe'; suite = suite.parent!) titles.unshift(suite.title);
  return titles;
}

/**
 * Status as KlovPlay should record it: an expected failure (`test.fail()`) is a
 * pass, and an unexpected pass is a failure.
 */
export function effectiveStatus(test: TestCase, result: TestResult): string {
  if (test.expectedStatus === 'failed') {
    if (result.status === 'failed') return 'passed';
    if (result.status === 'passed') return 'failed';
  }
  return result.status;
}

export interface ErrorFields {
  error_message: string | null;
  error_stack: string | null;
  error_snippet: string | null;
}

export function errorFields(test: TestCase, result: TestResult, status: string): ErrorFields {
  if (status === 'passed' || status === 'skipped') return { error_message: null, error_stack: null, error_snippet: null };
  const [first, ...rest] = result.errors;
  if (!first) {
    const message = test.expectedStatus === 'failed' && result.status === 'passed' ? 'Expected to fail, but passed.' : null;
    return { error_message: message, error_stack: null, error_snippet: null };
  }
  const extra = rest.length > 0 ? `\n\n(+${rest.length} more error${rest.length > 1 ? 's' : ''})` : '';
  return {
    error_message: (first.message ?? first.value ?? 'Unknown error') + extra,
    error_stack: first.stack ?? null,
    error_snippet: first.snippet ?? null,
  };
}

export function outputChunks(chunks: (string | Buffer)[]): string[] {
  return chunks.map((chunk) => (typeof chunk === 'string' ? chunk : chunk.toString('utf8')));
}
