import type { TestRow } from '../generated/TestRow';
import { worstStatus } from './status';

export type GroupBy = 'suite' | 'behavior';

export interface TreeGroup {
  kind: 'group';
  id: string;
  label: string;
  /** file, describe, epic, feature or story */
  level: string;
  depth: number;
  status: string;
  total: number;
  failed: number;
  children: TreeItem[];
}

export interface TreeLeaf {
  kind: 'test';
  id: string;
  depth: number;
  row: TestRow;
}

export type TreeItem = TreeGroup | TreeLeaf;

function pathFor(row: TestRow, groupBy: GroupBy): { level: string; label: string }[] {
  if (groupBy === 'behavior') {
    return [
      { level: 'epic', label: row.annotations.epic ?? 'No epic' },
      { level: 'feature', label: row.annotations.feature ?? 'No feature' },
      ...(row.annotations.story ? [{ level: 'story', label: row.annotations.story }] : []),
    ];
  }
  return [{ level: 'file', label: row.file_path }, ...row.suite_path.map((label) => ({ level: 'describe', label }))];
}

/** Groups rows (already sorted by file and line) into a tree, keeping first-seen order. */
export function buildTree(rows: TestRow[], groupBy: GroupBy): TreeItem[] {
  const root: TreeGroup = { kind: 'group', id: 'root', label: '', level: 'root', depth: -1, status: 'passed', total: 0, failed: 0, children: [] };
  const index = new Map<string, TreeGroup>();
  for (const row of rows) {
    let parent = root;
    let key = groupBy;
    for (const segment of pathFor(row, groupBy)) {
      key += `␟${segment.level}:${segment.label}`;
      let group = index.get(key);
      if (!group) {
        group = { kind: 'group', id: key, label: segment.label, level: segment.level, depth: parent.depth + 1, status: 'passed', total: 0, failed: 0, children: [] };
        index.set(key, group);
        parent.children.push(group);
      }
      parent = group;
    }
    parent.children.push({ kind: 'test', id: row.execution_id, depth: parent.depth + 1, row });
  }
  const rollUp = (group: TreeGroup): string[] => {
    const statuses: string[] = [];
    for (const child of group.children) {
      if (child.kind === 'test') statuses.push(child.row.status);
      else statuses.push(...rollUp(child));
    }
    group.total = statuses.length;
    group.failed = statuses.filter((s) => s === 'failed' || s === 'timedOut' || s === 'interrupted').length;
    group.status = worstStatus(statuses);
    return statuses;
  };
  rollUp(root);
  return root.children;
}

/** Depth-first list of the items visible with the given groups collapsed. */
export function flattenTree(items: TreeItem[], collapsed: ReadonlySet<string>): TreeItem[] {
  const out: TreeItem[] = [];
  const visit = (list: TreeItem[]) => {
    for (const item of list) {
      out.push(item);
      if (item.kind === 'group' && !collapsed.has(item.id)) visit(item.children);
    }
  };
  visit(items);
  return out;
}
