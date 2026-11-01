import type { ApiError } from '../generated/ApiError';
import type { ExecutionDetail } from '../generated/ExecutionDetail';
import type { LaunchDetail } from '../generated/LaunchDetail';
import type { LaunchSummary } from '../generated/LaunchSummary';
import type { ProjectAnalytics } from '../generated/ProjectAnalytics';
import type { ProjectSummary } from '../generated/ProjectSummary';
import type { TestHistory } from '../generated/TestHistory';
import type { TestPage } from '../generated/TestPage';
import type { TestRow } from '../generated/TestRow';

export class RequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function get<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { accept: 'application/json' } });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as ApiError | null;
    throw new RequestError(response.status, body?.error ?? `${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

export const api = {
  projects: () => get<ProjectSummary[]>('/api/v1/projects'),
  launches: (slug: string, limit = 50) => get<LaunchSummary[]>(`/api/v1/projects/${encodeURIComponent(slug)}/launches?limit=${limit}`),
  analytics: (slug: string) => get<ProjectAnalytics>(`/api/v1/projects/${encodeURIComponent(slug)}/analytics`),
  launch: (id: string) => get<LaunchDetail>(`/api/v1/launches/${id}`),
  execution: (id: string) => get<ExecutionDetail>(`/api/v1/executions/${id}`),
  history: (slug: string, fingerprint: string) =>
    get<TestHistory>(`/api/v1/projects/${encodeURIComponent(slug)}/history/${fingerprint}`),

  /** Every test of a launch, following pagination. */
  async tests(launchId: string): Promise<TestRow[]> {
    const rows: TestRow[] = [];
    let cursor: string | null = null;
    do {
      const query: string = cursor ? `?cursor=${cursor}` : '';
      const page: TestPage = await get<TestPage>(`/api/v1/launches/${launchId}/tests${query}`);
      rows.push(...page.tests);
      cursor = page.next_cursor;
    } while (cursor);
    return rows;
  },
};

export const queryKeys = {
  projects: ['projects'] as const,
  launches: (slug: string) => ['launches', slug] as const,
  analytics: (slug: string) => ['analytics', slug] as const,
  launch: (id: string) => ['launch', id] as const,
  tests: (id: string) => ['launch-tests', id] as const,
  execution: (id: string) => ['execution', id] as const,
  history: (slug: string, fingerprint: string) => ['history', slug, fingerprint] as const,
};
