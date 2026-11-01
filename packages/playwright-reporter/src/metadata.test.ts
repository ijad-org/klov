import { describe, expect, it } from 'vitest';

import { detectCi, parseAnnotations, relativePath } from './metadata';

describe('parseAnnotations', () => {
  it('reads Allure labels from annotations and tags', () => {
    const labels = parseAnnotations(
      [
        { type: 'severity', description: 'critical' },
        { type: 'Owner', description: 'payments' },
        { type: 'issue', description: 'PAY-12' },
        { type: 'slow' },
      ],
      ['@smoke', '@epic:Checkout', '@story=Pay by card'],
    );
    expect(labels).toEqual({
      severity: 'critical',
      owner: 'payments',
      issue: 'PAY-12',
      epic: 'Checkout',
      story: 'Pay by card',
      tags: ['@smoke'],
    });
  });
});

describe('detectCi', () => {
  it('derives a shard-stable run id on GitHub Actions', () => {
    const ci = detectCi({
      GITHUB_ACTIONS: 'true',
      GITHUB_RUN_ID: '991',
      GITHUB_RUN_ATTEMPT: '2',
      GITHUB_RUN_NUMBER: '57',
      GITHUB_HEAD_REF: '',
      GITHUB_REF_NAME: 'main',
      GITHUB_SHA: 'abc',
    });
    expect(ci).toEqual({ runId: 'gh-991-2', buildNumber: '57', branch: 'main', commitSha: 'abc' });
  });

  it('uses the pipeline id on GitLab', () => {
    expect(detectCi({ GITLAB_CI: 'true', CI_PIPELINE_ID: '7', CI_COMMIT_REF_NAME: 'feat/x' })).toMatchObject({
      runId: 'gl-7',
      branch: 'feat/x',
    });
  });

  it('returns nothing outside CI', () => {
    expect(detectCi({})).toEqual({});
  });
});

describe('relativePath', () => {
  it('makes paths machine independent', () => {
    expect(relativePath('/home/runner/work/app', '/home/runner/work/app/tests/login.spec.ts')).toBe('tests/login.spec.ts');
  });
});
