import type { TestRow } from '../generated/TestRow';
import { type StatusGroup, statusGroup } from './status';

/**
 * Search syntax for the test tree:
 *   status:failed  @smoke  project:chromium  owner:alice  severity:critical  epic:Checkout  free text
 */
export interface TestQuery {
  text: string[];
  statuses: StatusGroup[];
  tags: string[];
  fields: { key: 'project' | 'owner' | 'severity' | 'epic' | 'feature' | 'story' | 'file'; value: string }[];
}

const FIELDS = new Set(['project', 'owner', 'severity', 'epic', 'feature', 'story', 'file']);

export function parseQuery(input: string): TestQuery {
  const query: TestQuery = { text: [], statuses: [], tags: [], fields: [] };
  for (const token of input.trim().split(/\s+/).filter(Boolean)) {
    const lower = token.toLowerCase();
    const colon = lower.indexOf(':');
    const key = colon > 0 ? lower.slice(0, colon) : '';
    const value = colon > 0 ? lower.slice(colon + 1) : '';
    if (token.startsWith('@')) query.tags.push(lower);
    else if (key === 'status' && value) query.statuses.push(statusGroup(value === 'timedout' ? 'timedOut' : value));
    else if (FIELDS.has(key) && value) query.fields.push({ key: key as TestQuery['fields'][number]['key'], value });
    else query.text.push(lower);
  }
  return query;
}

export function matchesQuery(row: TestRow, query: TestQuery): boolean {
  if (query.statuses.length && !query.statuses.includes(statusGroup(row.status))) return false;
  const tags = row.annotations.tags.map((t) => t.toLowerCase());
  if (query.tags.some((tag) => !tags.some((t) => t.startsWith(tag)))) return false;
  for (const { key, value } of query.fields) {
    const actual = key === 'project' ? row.browser_project : key === 'file' ? row.file_path : row.annotations[key];
    if (!actual || !actual.toLowerCase().includes(value)) return false;
  }
  if (query.text.length) {
    const haystack = `${row.title} ${row.suite_path.join(' ')} ${row.file_path} ${row.error_message ?? ''}`.toLowerCase();
    if (!query.text.every((word) => haystack.includes(word))) return false;
  }
  return true;
}
