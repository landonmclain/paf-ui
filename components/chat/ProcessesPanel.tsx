"use client";

// Right sidebar: the two background-process lanes (agent + conversation) and
// the model-owned Plan checklist, split VERTICALLY so all three are visible at
// once — no tab toggle. Each pane scrolls independently within its own slice of
// the fixed-width column.
//
// The agent lane (memory consolidation + review) is shared per-agent and does
// NOT change on conversation switch; the conversation lane (thread summarizer)
// is per-conversation. Both re-scope when the agent changes.

import { useState } from "react";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";

import { VerticalSplit } from "@/components/ui/resizable";
import { buildPlanTree } from "@/lib/paf";
import type { PlanItem, ProcessFrame } from "@/lib/paf";
import { PlanPanel } from "./PlanPanel";

type Props = {
  open: boolean;
  agentProcesses: ProcessFrame[];
  plan: PlanItem[];
};

function statusBadge(status: string) {
  const s = status.toLowerCase();
  const cls =
    s === "done"
      ? "bg-emerald-500/15 text-emerald-600"
      : s === "skipped"
        ? "bg-amber-500/15 text-amber-600"
        : s === "error"
          ? "bg-destructive/15 text-destructive"
          : s === "running" || s === "processing"
            ? "bg-emerald-500/15 text-emerald-600 animate-pulse"
            : s === "idle"
              ? "bg-muted text-muted-foreground border border-muted-foreground/20"
              : "bg-muted text-muted-foreground";
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${cls}`}
    >
      {s}
    </span>
  );
}

/** A fixed header row for one pane of the split right sidebar. */
export function PaneHeader({ title }: { title: string }) {
  return (
    <div className="flex items-center border-b px-2 py-1.5 text-xs font-medium text-muted-foreground">
      {title}
    </div>
  );
}

/** One lane's process rows (agent or conversation), or an empty-state line. */
export function ProcessList({
  processes,
  empty,
}: {
  processes: ProcessFrame[];
  empty: string;
}) {
  if (processes.length === 0) {
    return <p className="px-1 py-1 text-xs text-muted-foreground">{empty}</p>;
  }
  return (
    <ul className="space-y-1.5">
      {processes.map((p, i) => (
        <ProcessRow key={`${p.id}-${i}`} process={p} />
      ))}
    </ul>
  );
}

/** Compact "time since" for an ISO timestamp; "" when unknown. */
function agoIso(iso: string | null | undefined): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function ProcessRow({ process: p }: { process: ProcessFrame }) {
  const [expanded, setExpanded] = useState(false);
  const active = ["running", "queued", "processing"].includes(p.status);
  const lines = p.lines ?? [];
  // A done row's detail IS its result; on an idle/skipped row the last
  // completed run is what tells you what the job actually did.
  const showLast = !!p.last && !active && p.status !== "done";
  const when = agoIso(p.last_at);

  return (
    <li className="rounded-md border bg-background/60 p-2">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-xs font-medium">{p.label}</span>
        {statusBadge(p.status)}
      </div>
      {p.detail && (
        <p className="mt-1 text-[11px] text-muted-foreground">{p.detail}</p>
      )}
      {showLast && (
        <p className="mt-1 text-[11px] text-muted-foreground">
          <span className="font-medium text-foreground/70">
            last run{when ? ` · ${when}` : ""}:
          </span>{" "}
          {p.last}
        </p>
      )}
      {!active && lines.length > 0 && (
        <>
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            className="mt-1 flex items-center gap-0.5 rounded px-0.5 text-[10px] text-muted-foreground hover:bg-accent/40 hover:text-foreground"
          >
            {expanded ? (
              <ChevronDownIcon className="size-3" />
            ) : (
              <ChevronRightIcon className="size-3" />
            )}
            {lines.length} change{lines.length === 1 ? "" : "s"}
          </button>
          {expanded && (
            <ul className="mt-1 space-y-1 border-l pl-2">
              {lines.map((line, i) => (
                <li
                  key={i}
                  className="text-[10px] leading-4 text-muted-foreground"
                >
                  {line}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {active && typeof p.progress === "number" && p.progress >= 0 && (
        <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full bg-emerald-500"
            style={{ width: `${Math.round(p.progress * 100)}%` }}
          />
        </div>
      )}
    </li>
  );
}

export function ProcessesPanel({ open, agentProcesses, plan }: Props) {
  if (!open) {
    return <aside className="h-full border-l bg-background/50" aria-hidden />;
  }
  const planSteps = buildPlanTree(plan).length;
  return (
    <aside className="flex h-full w-full flex-col border-l bg-background/50">
      {/* Agent processes over plans; drag to resize. */}
      <VerticalSplit
        id="paf-ui-right-split"
        top={
          /* Agent processes — shared per-agent; unchanged on conversation switch. */
          <div className="flex min-h-0 flex-1 flex-col">
            <PaneHeader
              title={`Agent processes${agentProcesses.length > 0 ? ` (${agentProcesses.length})` : ""}`}
            />
            <div className="flex-1 overflow-y-auto p-2">
              <ProcessList
                processes={agentProcesses}
                empty="No agent processes."
              />
            </div>
          </div>
        }
        bottom={
          <div className="flex min-h-0 flex-1 flex-col">
            {/* Count top-level steps; subtasks are tallied on their parent. */}
            <PaneHeader
              title={`Plans${planSteps > 0 ? ` (${planSteps})` : ""}`}
            />
            <div className="flex-1 overflow-y-auto p-2">
              <PlanPanel items={plan} />
            </div>
          </div>
        }
      />
    </aside>
  );
}

export function ProcessesSidebarPlaceholder() {
  return <ProcessesPanel open agentProcesses={[]} plan={[]} />;
}
