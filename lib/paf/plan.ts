// lib/paf/plan.ts
// ---------------------------------------------------------------------------
// Plan types for the paf-ui Plans sidebar.
//
// The authoritative plan comes from the
// SERVER — `GET /api/conversations/{id}/plan` (snapshot on load/switch/settle)
// and live `plan` SSE frames (full-snapshot per mutation, mid-turn). The pain
// that used to live here — reconstructing the plan client-side from tool-call
// records (`write_plan` / `update_task_status` …) via `derivePlan()` — carried
// two defects: id-mismatch (fake ids meant statuses silently no-op'd) and
// per-turn resets (multi-turn state was lost because the sidebar never read the
// durable store). That reconstruction is DELETED. There is one source of truth
// (the server's FilePlanStore); this module holds the types plus a pure view
// helper that nests subtasks under their parent for rendering.
//
// `PlanItem` / `PlanStatus` are re-exported from ./types so existing callers
// (`derivePlan` days) keep a single import. Single-source-of-truth means no
// merge/diff logic on the client — the panel is always a direct mirror.

import type { PlanItem, PlanStatus } from "./types";

export type { PlanItem, PlanStatus } from "./types";

/** One step in the rendered plan tree, with its outline number (`1`, `1.2`). */
export type PlanNode = {
  item: PlanItem;
  number: string;
  children: PlanNode[];
};

/** Completed and cancelled steps no longer hold anything up. */
export function isResolved(status: PlanStatus): boolean {
  return status === "completed" || status === "cancelled";
}

/**
 * Nest each subtask under its parent (`parent_id`), mirroring the server's
 * `walk_tree`: siblings keep plan order — so a subtask the store appended to the
 * end still shows under its parent — and a step whose parent is not in the plan
 * is shown at the top level rather than dropped. This is a view of the snapshot,
 * not a merge: the server stays the single source of truth.
 */
export function buildPlanTree(items: PlanItem[]): PlanNode[] {
  const known = new Set(items.map((item) => item.id));
  const children = new Map<string | null, PlanItem[]>();
  for (const item of items) {
    const parent =
      item.parent_id && known.has(item.parent_id) ? item.parent_id : null;
    const siblings = children.get(parent);
    if (siblings) siblings.push(item);
    else children.set(parent, [item]);
  }
  const seen = new Set<string>();
  const walk = (nodes: PlanItem[], prefix: string): PlanNode[] => {
    const out: PlanNode[] = [];
    for (const item of nodes) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      const number = `${prefix}${out.length + 1}`;
      out.push({
        item,
        number,
        children: walk(children.get(item.id) ?? [], `${number}.`),
      });
    }
    return out;
  };
  return walk(children.get(null) ?? [], "");
}
