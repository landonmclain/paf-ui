"use client";

// Left sidebar: conversations grouped by project + New conversation / project.
// Wired to the backend GET/POST /api/conversations and /api/projects.
// `open=false` collapses the panel.
//
// Grouping: one collapsible section per project (most recently active first,
// then empty projects by name). "Unassigned" sorts the same way (it bumps to the
// top when it holds the newest conversation). It starts collapsed unless it is
// the first section — it holds the unnamed CLI/test lanes, so it must not bury
// the projects. A section
// holding the active conversation is always expanded. Each section header has a
// `+` that creates a conversation already in that project.
//
// Row menu (⋯): Rename (also double-click; Enter/blur commits, Escape cancels),
// Project ▸ (assign / None / New project…), Hide. Hidden lanes are filtered out
// unless "Show hidden" is on; nothing is deleted.

import { useRef, useState } from "react";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  EyeIcon,
  EyeOffIcon,
  FolderIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
} from "lucide-react";

import { VerticalSplit } from "@/components/ui/resizable";
import type { Conversation, ProcessFrame, Project } from "@/lib/paf";
import { laneKey, useRunStore } from "@/lib/paf/runStore";
import { Shimmer } from "@/components/ai-elements/shimmer";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PaneHeader, ProcessList } from "./ProcessesPanel";

const UNASSIGNED = "__unassigned";

type Props = {
  open: boolean;
  conversations: Conversation[];
  projects: Project[];
  activeId: string | null;
  onSelect: (id: string) => void;
  /** Create a conversation, optionally already in a project. */
  onCreate: (project: string | null) => void;
  /** Persist a title change; returns the new title (null = failed). */
  onRename: (id: string, title: string) => Promise<string | null>;
  /** Assign a conversation to a project (null = unassign). */
  onAssign: (id: string, project: string | null) => void;
  onHide: (id: string, hidden: boolean) => void;
  /** Open the New project dialog; `assignTo` gets the new project on success. */
  onNewProject: (assignTo?: string) => void;
  /** Conversation-lane background processes (thread summarizer). */
  processes?: ProcessFrame[];
};

type Group = {
  key: string;
  label: string;
  project: string | null;
  items: Conversation[];
};

/** Project sections plus Unassigned, most recently active first, then empty
 *  ones by name; includes conversations under unknown/archived slugs. */
function groupConversations(
  conversations: Conversation[],
  projects: Project[],
): Group[] {
  const byProject = new Map<string, Conversation[]>();
  const unassigned: Conversation[] = [];
  for (const c of conversations) {
    if (!c.project) unassigned.push(c);
    else byProject.set(c.project, [...(byProject.get(c.project) ?? []), c]);
  }
  const latest = (items: Conversation[]) =>
    Math.max(0, ...items.map((c) => c.updated_at ?? 0));
  const known = new Set(projects.map((p) => p.slug));
  const groups: Group[] = projects.map((p) => ({
    key: p.slug,
    label: p.name,
    project: p.slug,
    items: byProject.get(p.slug) ?? [],
  }));
  // Lanes pointing at a project that is no longer listed (archived) still show.
  for (const [slug, items] of byProject) {
    if (!known.has(slug)) {
      groups.push({ key: slug, label: slug, project: slug, items });
    }
  }
  groups.push({
    key: UNASSIGNED,
    label: "Unassigned",
    project: null,
    items: unassigned,
  });
  // Stable sort: projects arrive name-sorted, so empty ones stay alphabetical,
  // and Unassigned (pushed last) loses ties. It bumps to the top when it holds
  // the most recent conversation, like any project.
  groups.sort((a, b) => latest(b.items) - latest(a.items));
  for (const g of groups) {
    g.items.sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0));
  }
  return groups;
}

/** Compact "time since" for an epoch-seconds timestamp; "" when unknown. */
function ago(epochSeconds: number | null): string {
  if (!epochSeconds || epochSeconds < 1e9) return "";
  const s = Math.max(0, Date.now() / 1000 - epochSeconds);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(epochSeconds * 1000).toLocaleDateString();
}

export function ConversationList({
  open,
  conversations,
  projects,
  activeId,
  onSelect,
  onCreate,
  onRename,
  onAssign,
  onHide,
  onNewProject,
  processes = [],
}: Props) {
  // conversation_id currently being renamed (inline input shown instead of title).
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  // Explicit collapse choices by group key. A section with no choice yet is
  // expanded, except Unassigned, which is collapsed unless it is the first
  // (newest) section.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [showHidden, setShowHidden] = useState(false);

  // Which lanes are currently running (streaming). The selector reduces the
  // store's lanes to a stable "key|key|…" signature so this component only
  // re-renders when a lane *starts/stops* running — NOT on every token/frame a
  // running lane produces (which would re-render the whole sidebar ~100ms).
  // Running lanes get a shimmer so it's obvious they're still live.
  const runningSignature = useRunStore((s) =>
    Object.entries(s.lanes)
      .filter(([, lane]) => lane.running)
      .map(([k]) => k)
      .sort()
      .join("|"),
  );
  const runningSet = new Set(
    runningSignature ? runningSignature.split("|") : [],
  );

  if (!open) {
    return <aside className="h-full border-r bg-background/50" aria-hidden />;
  }

  const hiddenCount = conversations.filter((c) => c.hidden).length;
  const visible = showHidden
    ? conversations
    : conversations.filter((c) => !c.hidden);
  const groups = groupConversations(visible, projects);

  const beginRename = (c: Conversation) => {
    setDraft(c.title ?? "");
    setEditingId(c.conversation_id);
  };

  const commitRename = async (c: Conversation) => {
    const id = c.conversation_id;
    const next = await onRename(id, draft.trim());
    // Optimistically-rendered title is whatever onRename agreed on; close the
    // input regardless (list refresh happens through the parent's state).
    setEditingId(null);
    if (next === null) {
      // Commit failed — reset draft so a stale value doesn't linger if the
      // user re-opens rename.
      setDraft(c.title ?? "");
    }
  };

  const renderRow = (c: Conversation) => {
    // Running on THIS device's stream, or on the server (any device's turn).
    const isRunning =
      runningSet.has(laneKey(c.agent, c.conversation_id)) || !!c.running;
    const title = c.title ?? "New conversation";
    const when = ago(c.updated_at);
    return (
      <div
        key={`${c.agent}:${c.conversation_id}`}
        className={`group relative mb-0.5 block w-full rounded-md px-2 py-1.5 text-left text-xs ${
          c.conversation_id === activeId
            ? "bg-accent text-accent-foreground"
            : "text-foreground hover:bg-accent/50"
        } ${c.hidden ? "opacity-50" : ""}`}
      >
        {editingId === c.conversation_id ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void commitRename(c);
              else if (e.key === "Escape") setEditingId(null);
            }}
            onBlur={() => void commitRename(c)}
            onFocus={(e) => e.target.select()}
            placeholder="Name this conversation…"
            className="w-full rounded-sm border bg-background px-1 py-0.5 text-xs text-foreground outline-none"
          />
        ) : (
          <>
            <button
              type="button"
              onClick={() => onSelect(c.conversation_id)}
              onDoubleClick={() => beginRename(c)}
              className="block w-full pr-5 text-left"
            >
              <span className="flex items-center gap-1.5">
                {/* Live-streaming lanes shimmer their title (same Shimmer as
                    thinking text) so it's obvious the conversation is still
                    running in the background. */}
                {isRunning ? (
                  <Shimmer duration={1.5}>{title}</Shimmer>
                ) : (
                  <span className="block truncate font-medium">{title}</span>
                )}
                {isRunning && (
                  <span
                    className="relative flex h-1.5 w-1.5 shrink-0"
                    title="streaming…"
                  >
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                    <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
                  </span>
                )}
              </span>
              {when && (
                <span className="block truncate text-[10px] opacity-60">
                  {when}
                </span>
              )}
            </button>
            <RowMenu
              conversation={c}
              projects={projects}
              onRename={() => beginRename(c)}
              onAssign={(slug) => onAssign(c.conversation_id, slug)}
              onHide={() => onHide(c.conversation_id, !c.hidden)}
              onNewProject={() => onNewProject(c.conversation_id)}
            />
          </>
        )}
      </div>
    );
  };

  return (
    <aside className="flex h-full w-full flex-col border-r bg-background/50">
      {/* Conversations over conversation-lane processes; drag to resize. */}
      <VerticalSplit
        id="paf-ui-left-split"
        top={
          <>
            <div className="flex gap-1 border-b px-2 py-1.5">
              <button
                type="button"
                onClick={() => onCreate(null)}
                className="flex-1 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-foreground hover:bg-accent/70"
              >
                + New conversation
              </button>
              <button
                type="button"
                onClick={() => onNewProject()}
                title="New project"
                className="rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-accent/60 hover:text-foreground"
              >
                + Project
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-1.5">
              {conversations.length === 0 && projects.length === 0 ? (
                <p className="px-2 py-1 text-xs text-muted-foreground">
                  No conversations yet.
                </p>
              ) : (
                groups.map((g) => {
                  if (g.key === UNASSIGNED && g.items.length === 0) return null;
                  const hasActive = g.items.some(
                    (c) => c.conversation_id === activeId,
                  );
                  const defaultCollapsed =
                    g.key === UNASSIGNED && groups[0].key !== UNASSIGNED;
                  const isCollapsed =
                    (collapsed[g.key] ?? defaultCollapsed) && !hasActive;
                  return (
                    <section key={g.key} className="mb-1">
                      <div className="group/section flex items-center gap-1 rounded-md px-1 py-1 text-[11px] font-medium text-muted-foreground hover:bg-accent/30">
                        <button
                          type="button"
                          onClick={() =>
                            setCollapsed((prev) => ({
                              ...prev,
                              [g.key]: !isCollapsed,
                            }))
                          }
                          className="flex min-w-0 flex-1 items-center gap-1 text-left"
                          aria-expanded={!isCollapsed}
                        >
                          {isCollapsed ? (
                            <ChevronRightIcon className="size-3 shrink-0" />
                          ) : (
                            <ChevronDownIcon className="size-3 shrink-0" />
                          )}
                          <span className="truncate">{g.label}</span>
                          <span className="shrink-0 opacity-60">
                            {g.items.length}
                          </span>
                        </button>
                        <button
                          type="button"
                          onClick={() => onCreate(g.project)}
                          aria-label={`New conversation in ${g.label}`}
                          title={`New conversation in ${g.label}`}
                          className="rounded p-0.5 opacity-0 hover:bg-accent/60 hover:text-foreground focus-visible:opacity-100 group-hover/section:opacity-100"
                        >
                          <PlusIcon className="size-3" />
                        </button>
                      </div>
                      {!isCollapsed &&
                        (g.items.length === 0 ? (
                          <p className="px-6 py-1 text-[11px] text-muted-foreground">
                            No conversations.
                          </p>
                        ) : (
                          <div className="pl-2">{g.items.map(renderRow)}</div>
                        ))}
                    </section>
                  );
                })
              )}
              {hiddenCount > 0 && (
                <button
                  type="button"
                  onClick={() => setShowHidden((v) => !v)}
                  className="mt-1 flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent/30 hover:text-foreground"
                >
                  {showHidden ? (
                    <EyeOffIcon className="size-3" />
                  ) : (
                    <EyeIcon className="size-3" />
                  )}
                  {showHidden ? "Hide hidden" : `Show hidden (${hiddenCount})`}
                </button>
              )}
            </div>
          </>
        }
        bottom={
          <div className="flex min-h-0 flex-1 flex-col">
            <PaneHeader
              title={`Conversation processes${processes.length > 0 ? ` (${processes.length})` : ""}`}
            />
            <div className="flex-1 overflow-y-auto p-2">
              <ProcessList
                processes={processes}
                empty="No conversation processes."
              />
            </div>
          </div>
        }
      />
    </aside>
  );
}

/** The ⋯ menu on a conversation row: Rename · Project ▸ · Hide/Unhide.
 *
 *  Rename is deferred until the menu has fully closed. On close the menu hands
 *  focus back to its ⋯ trigger; if the rename input mounted first, that focus
 *  return blurs it, the blur commits the unchanged name, and the editor closes
 *  instantly ("rename does nothing"). Which happens first varies by browser
 *  and close-animation timing, so don't race it. */
function RowMenu({
  conversation,
  projects,
  onRename,
  onAssign,
  onHide,
  onNewProject,
}: {
  conversation: Conversation;
  projects: Project[];
  onRename: () => void;
  onAssign: (project: string | null) => void;
  onHide: () => void;
  onNewProject: () => void;
}) {
  const current = conversation.project;
  const renameOnClose = useRef(false);
  return (
    <DropdownMenu
      onOpenChangeComplete={(open) => {
        if (!open && renameOnClose.current) {
          renameOnClose.current = false;
          onRename();
        }
      }}
    >
      <DropdownMenuTrigger
        aria-label={`Actions for ${conversation.title ?? "conversation"}`}
        title="Actions"
        className="absolute right-1 top-1 rounded p-1 text-muted-foreground opacity-100 md:opacity-0 hover:bg-accent/60 hover:text-foreground md:focus-visible:opacity-100 md:group-hover:opacity-100 data-popup-open:opacity-100"
      >
        <MoreHorizontalIcon className="size-3" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuItem
          onClick={() => {
            renameOnClose.current = true;
          }}
        >
          <PencilIcon />
          Rename
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <FolderIcon />
            Project
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-44">
            {projects.map((p) => (
              <DropdownMenuItem key={p.slug} onClick={() => onAssign(p.slug)}>
                <span className="flex-1 truncate">{p.name}</span>
                {p.slug === current && <span aria-label="current">✓</span>}
              </DropdownMenuItem>
            ))}
            <DropdownMenuItem
              onClick={() => onAssign(null)}
              disabled={!current}
            >
              <span className="flex-1">None</span>
              {!current && <span aria-label="current">✓</span>}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onNewProject}>
              <PlusIcon />
              New project…
            </DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={onHide}>
          {conversation.hidden ? <EyeIcon /> : <EyeOffIcon />}
          {conversation.hidden ? "Unhide" : "Hide"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
