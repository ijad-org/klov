/**
 * Helpers for Allure-style labels. They return plain Playwright annotations,
 * so they work without the reporter installed:
 *
 *   import { severity, owner, epic } from '@klovplay/playwright-reporter/annotations';
 *   test('pays with a card', { annotation: [severity('critical'), owner('payments'), epic('Checkout')] }, async () => {});
 *
 * Labels can also be added while the test runs:
 *
 *   test.info().annotations.push(issue('PAY-123'));
 */
export type Severity = 'blocker' | 'critical' | 'normal' | 'minor' | 'trivial';

export interface KlovPlayAnnotation {
  type: string;
  description: string;
}

const label = (type: string) => (description: string): KlovPlayAnnotation => ({ type, description });

export const severity = (level: Severity | (string & {})): KlovPlayAnnotation => ({ type: 'severity', description: level });
export const owner = label('owner');
export const epic = label('epic');
export const feature = label('feature');
export const story = label('story');
export const issue = label('issue');
