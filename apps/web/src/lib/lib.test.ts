import { describe, expect, it } from 'vitest';

import { parseAnsi, stripAnsi } from './ansi';
import { matchesQuery, parseQuery } from './search';
import { worstStatus } from './status';
import { row } from '../test/fixtures';
import { buildTree, flattenTree } from './tree';

describe('parseAnsi', () => {
  it('maps SGR codes to classes and drops other escapes', () => {
    const segments = parseAnsi('\u001b[2mexpect(\u001b[22m\u001b[31mreceived\u001b[39m\u001b[2K)');
    expect(segments).toEqual([
      { text: 'expect(', classes: ['ansi-dim'] },
      { text: 'received', classes: ['ansi-red'] },
      { text: ')', classes: [] },
    ]);
    expect(stripAnsi('\u001b[1mbold\u001b[0m')).toBe('bold');
  });
});

describe('search', () => {
  const failing = row({ status: 'timedOut', title: 'checkout pays', annotations: { tags: ['@smoke'], owner: 'Payments' } });
  it('supports status, tag, field and text tokens', () => {
    expect(matchesQuery(failing, parseQuery('status:failed @smoke owner:pay checkout'))).toBe(true);
    expect(matchesQuery(failing, parseQuery('status:passed'))).toBe(false);
    expect(matchesQuery(failing, parseQuery('project:firefox'))).toBe(false);
    expect(matchesQuery(failing, parseQuery('@regression'))).toBe(false);
  });
});

describe('tree', () => {
  const rows = [
    row({ playwright_test_id: 'a', file_path: 'a.spec.ts', suite_path: ['Cart'], status: 'failed', annotations: { tags: [], epic: 'Shop' } }),
    row({ playwright_test_id: 'b', file_path: 'a.spec.ts', suite_path: ['Cart'], status: 'passed', annotations: { tags: [], epic: 'Shop' } }),
    row({ playwright_test_id: 'c', file_path: 'b.spec.ts', status: 'flaky' }),
  ];

  it('groups by file and describe with rolled-up status', () => {
    const tree = buildTree(rows, 'suite');
    expect(tree.map((g) => (g.kind === 'group' ? [g.label, g.status, g.total, g.failed] : null))).toEqual([
      ['a.spec.ts', 'failed', 2, 1],
      ['b.spec.ts', 'flaky', 1, 0],
    ]);
    expect(flattenTree(tree, new Set()).length).toBe(6);
    const fileA = tree[0];
    expect(flattenTree(tree, new Set([fileA.id])).length).toBe(3);
  });

  it('groups by behavior', () => {
    const tree = buildTree(rows, 'behavior');
    expect(tree.map((g) => (g.kind === 'group' ? g.label : ''))).toEqual(['Shop', 'No epic']);
  });

  it('ranks failures worst', () => {
    expect(worstStatus(['passed', 'running', 'flaky'])).toBe('running');
    expect(worstStatus(['skipped', 'timedOut'])).toBe('timedOut');
  });
});
