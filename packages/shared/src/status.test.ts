import { describe, expect, it } from 'vitest';
import { deriveTestStatus, isAssertionError, passRate, emptyStats, stripAnsi } from './status.js';

describe('deriveTestStatus', () => {
  it('keeps the test running while Playwright will retry it', () => {
    expect(deriveTestStatus({ status: 'failed', outcome: 'unexpected', willRetry: true, errors: [] })).toBe('running');
  });

  it('maps outcomes to final statuses', () => {
    expect(deriveTestStatus({ status: 'passed', outcome: 'expected', willRetry: false, errors: [] })).toBe('passed');
    expect(deriveTestStatus({ status: 'passed', outcome: 'flaky', willRetry: false, errors: [] })).toBe('flaky');
    expect(deriveTestStatus({ status: 'skipped', outcome: 'skipped', willRetry: false, errors: [] })).toBe('skipped');
    expect(deriveTestStatus({ status: 'timedOut', outcome: 'unexpected', willRetry: false, errors: [] })).toBe('broken');
    expect(deriveTestStatus({ status: 'interrupted', outcome: 'unexpected', willRetry: false, errors: [] })).toBe('interrupted');
  });

  it('treats an expected failure (test.fail) as passed and an unexpected pass as failed', () => {
    expect(deriveTestStatus({ status: 'failed', outcome: 'expected', willRetry: false, errors: [] })).toBe('passed');
    expect(deriveTestStatus({ status: 'passed', outcome: 'unexpected', willRetry: false, errors: [] })).toBe('failed');
  });

  it('separates assertion failures from other errors', () => {
    const assertion = { message: '\u001b[31mError: expect(received).toBe(expected)\u001b[39m' };
    const crash = { message: "TypeError: Cannot read properties of undefined (reading 'click')" };
    expect(deriveTestStatus({ status: 'failed', outcome: 'unexpected', willRetry: false, errors: [assertion] })).toBe('failed');
    expect(deriveTestStatus({ status: 'failed', outcome: 'unexpected', willRetry: false, errors: [crash] })).toBe('broken');
    expect(isAssertionError({ message: 'Error: Timed out 5000ms waiting for expect(locator).toBeVisible()' })).toBe(true);
  });
});

describe('passRate', () => {
  it('ignores skipped and unfinished tests and counts flaky as passed', () => {
    const stats = { ...emptyStats(), total: 10, passed: 6, flaky: 1, failed: 2, skipped: 1 };
    expect(passRate(stats)).toBeCloseTo(7 / 9);
    expect(passRate(emptyStats())).toBeNull();
  });
});

describe('stripAnsi', () => {
  it('removes color codes', () => {
    expect(stripAnsi('\u001b[2mexpect(\u001b[22m\u001b[31mreceived\u001b[39m')).toBe('expect(received');
  });
});
