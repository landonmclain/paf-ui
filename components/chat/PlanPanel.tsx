"use client";

import { useMemo, useState } from "react";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";

import { buildPlanTree, isResolved } from "@/lib/paf";
import type { PlanItem, PlanNode, PlanStatus } from "@/lib/paf";

type Props = { items: PlanItem[] };

const statusLabel: Record<PlanStatus, string> = {
  pending: "pending",
  in_progress: "active",
  completed: "done",
  cancelled: "cancelled",
  blocked: "blocked",
};

function badgeClass(status: PlanStatus) {
  return status === "completed"
    ? "bg-emerald-500/15 text-emerald-600"
    : status === "in_progress"
      ? "bg-blue-500/15 text-blue-600"
      : status === "blocked"
        ? "bg-amber-500/15 text-amber-600"
        : "bg-muted text-muted-foreground";
}

export function PlanPanel({ items }: Props) {
  const tree = useMemo(() => buildPlanTree(items), [items]);
  const byId = useMemo(
    () => new Map(items.map((item) => [item.id, item])),
    [items],
  );
  // Explicit open/closed choices per parent id; a parent nobody has toggled
  // starts collapsed once it is completed, expanded otherwise.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const toggle = (id: string, isOpen: boolean) =>
    setCollapsed((prev) => ({ ...prev, [id]: isOpen }));

  // Progress counts top-level steps; each parent shows its own subtask tally.
  const completed = tree.filter(
    (node) => node.item.status === "completed",
  ).length;

  return (
    <div className="space-y-2">
      {tree.length > 0 && (
        <p className="px-1 text-[11px] text-muted-foreground">
          {completed}/{tree.length} completed
        </p>
      )}
      {tree.length === 0 ? (
        <p className="px-1 py-1 text-xs text-muted-foreground">
          No plan for this conversation.
        </p>
      ) : (
        <ol className="space-y-1.5">
          {tree.map((node) => (
            <PlanStep
              key={node.item.id}
              node={node}
              depth={0}
              byId={byId}
              collapsed={collapsed}
              onToggle={toggle}
            />
          ))}
        </ol>
      )}
    </div>
  );
}

type StepProps = {
  node: PlanNode;
  depth: number;
  byId: Map<string, PlanItem>;
  collapsed: Record<string, boolean>;
  onToggle: (id: string, isOpen: boolean) => void;
};

function PlanStep({ node, depth, byId, collapsed, onToggle }: StepProps) {
  const { item, children } = node;
  const isOpen = !(collapsed[item.id] ?? item.status === "completed");
  const doneChildren = children.filter(
    (child) => child.item.status === "completed",
  ).length;
  const waitsOn = (item.depends_on ?? [])
    .map((id) => byId.get(id))
    .filter((dep): dep is PlanItem => !!dep && !isResolved(dep.status));
  // Subtasks stay compact: a status line only when it says something the badge
  // does not (a top-level step always gets one).
  const showStatus =
    depth === 0 || (item.status !== "pending" && item.status !== "completed");

  return (
    <li
      className={
        depth === 0 ? "rounded-md border bg-background/60 p-2" : "py-0.5"
      }
    >
      <div className="flex items-start gap-2">
        <span
          className={`mt-0.5 flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full px-1 text-[10px] font-semibold ${badgeClass(item.status)}`}
        >
          {item.status === "completed" ? "✓" : node.number}
        </span>
        <span
          className={`min-w-0 flex-1 text-xs leading-5 ${
            item.status === "cancelled"
              ? "text-muted-foreground line-through"
              : ""
          }`}
        >
          {item.content}
        </span>
        {children.length > 0 && (
          <button
            type="button"
            onClick={() => onToggle(item.id, isOpen)}
            aria-expanded={isOpen}
            aria-label={`${isOpen ? "Hide" : "Show"} subtasks of ${item.content}`}
            className="mt-0.5 flex shrink-0 items-center gap-0.5 rounded px-1 text-[10px] text-muted-foreground hover:bg-accent/40 hover:text-foreground"
          >
            {doneChildren}/{children.length}
            {isOpen ? (
              <ChevronDownIcon className="size-3" />
            ) : (
              <ChevronRightIcon className="size-3" />
            )}
          </button>
        )}
      </div>
      {showStatus &&
        (item.status === "in_progress" && item.active_form ? (
          <div className="mt-1 pl-6 text-[10px] text-blue-600">
            {item.active_form}
          </div>
        ) : (
          <div className="mt-1 pl-6 text-[10px] uppercase tracking-wide text-muted-foreground">
            {statusLabel[item.status]}
          </div>
        ))}
      {waitsOn.length > 0 && (
        <div className="mt-0.5 pl-6 text-[10px] text-amber-600">
          waits on: {waitsOn.map((dep) => dep.content).join(", ")}
        </div>
      )}
      {children.length > 0 && isOpen && (
        <ol className="mt-1.5 ml-2 space-y-0.5 border-l pl-2">
          {children.map((child) => (
            <PlanStep
              key={child.item.id}
              node={child}
              depth={depth + 1}
              byId={byId}
              collapsed={collapsed}
              onToggle={onToggle}
            />
          ))}
        </ol>
      )}
    </li>
  );
}
