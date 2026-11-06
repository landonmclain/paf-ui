"use client";

// PafChat — the paf-ui chat client.
//
// Client Component. Drives one paf conversation lane through lib/paf and
// renders the live turn with the vendored AI Elements components:
//   - Conversation (StickToBottom scroll) + ConversationContent
//   - Message / MessageContent / MessageResponse (Streamdown markdown)
//   - Reasoning (collapsible thinking, auto-adapts while streaming)
//   - Tool rows (collapsible, status badge running/done/error) keyed by step_id
//   - PromptInput (form) + PromptInputTextarea + PromptInputSubmit (auto send/stop)
//
// State model: a `transcript` of entries. The last assistant entry carries the
// live `Turn`, refreshed on every SSE frame via the adapter's onTurn hook.

import { memo, useCallback, useEffect, useRef, useState } from "react";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
  useTouchScroll,
} from "@/components/ai-elements/conversation";
import { useStickToBottomContext } from "use-stick-to-bottom";
import {
  Message,
  MessageBranch,
  MessageBranchContent,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";
import { WrenchIcon } from "lucide-react";
import { ApprovalCard } from "@/components/chat/ApprovalCard";
import { Suggestion, Suggestions } from "@/components/ai-elements/suggestion";
import { Source, Sources, SourcesContent, SourcesTrigger } from "@/components/ai-elements/sources";
import {
  PromptInput,
  PromptInputSubmit,
  PromptInputTextarea,
} from "@/components/ai-elements/prompt-input";
import type { Approval, ChatImage, RawEvent, Turn, ToolRecord, PlanItem } from "@/lib/paf";
import {
  cancel,
  checkHealth,
  getHistory,
  getPlan,
  steer,
  uploadImageUrl,
} from "@/lib/paf";
import {
  AttachImageButton,
  ImageAttachments,
  PendingUploads,
} from "@/components/chat/ImageAttachments";
import { selectLane, rejoinRun, startRun, useRunStore } from "@/lib/paf/runStore";
import { subscribeProcesses } from "@/lib/paf";

const DEFAULT_CONVERSATION_ID = "paf-ui-e1"; // fallback lane for the starter
const MAX_IMAGE_BYTES = 20 * 1024 * 1024; // matches the backend's upload limit

/** Images attached to a user message, served back from the upload store. */
function UserImages({ images }: { images: ChatImage[] }) {
  return (
    <div className="mb-2 flex flex-wrap gap-2">
      {images.map((img) => (
        <a
          key={img.id}
          href={uploadImageUrl(img.id)}
          target="_blank"
          rel="noreferrer"
          title={img.name}
        >
          {/* Served by paf-sse; next/image would need its host configured. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={uploadImageUrl(img.id)}
            alt={img.name}
            className="max-h-48 max-w-full rounded-md border object-contain"
          />
        </a>
      ))}
    </div>
  );
}

type Entry =
  | { id: string; role: "user"; text: string; images?: ChatImage[] }
  | { id: string; role: "assistant"; turn: Turn };

/** Structured prior-turn log from the backend history endpoint — same shape as
 *  the live TurnLogEntry, but assistant-only and already finished. */
type HistoryLog = Array<
  | { kind: "thinking"; text: string }
  | { kind: "text"; text: string }
  | {
      kind: "tool";
      stepId: string;
      toolName: string;
      args?: unknown;
      result?: unknown;
      error?: string;
      status: "running" | "done" | "error";
    }
>;

/** Turn tool args (backend sends them as a JSON string) into a clean
 * `key: value, key: value` one-liner without JSON backslash escaping. */
function humanizeArgs(args: unknown): string {
  if (args === undefined || args === null) return "";
  let obj: unknown = args;
  if (typeof args === "string") {
    try {
      obj = JSON.parse(args);
    } catch {
      return args; // not JSON — show as-is
    }
  }
  if (Array.isArray(obj)) return obj.map(String).join(", ");
  if (typeof obj === "object") {
    return Object.entries(obj as Record<string, unknown>)
      .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
      .join(", ");
  }
  return String(obj);
}

const MAX_TOOL_SUMMARY = 90;

/** Preview cap for the expanded tool-result body: large results (read_note /
 *  read_file can return many KB) are shown truncated with a size hint, not
 *  dumped in full. Small results pass through whole. */
const MAX_RESULT_PREVIEW = 2000;

/** Render a tool result as a truncated preview: the complete value for small
 *  payloads, else the head + an ellipsis + a `(N chars, M lines)` size hint so
 *  we never blow up the expanded body with a giant dump. */
function truncateResult(value: string): string {
  if (value.length <= MAX_RESULT_PREVIEW) return value;
  return `${value.slice(0, MAX_RESULT_PREVIEW)}\n\n… [truncated — ${value.length.toLocaleString()} chars, ${value.split("\n").length.toLocaleString()} lines]`;
}

/** A tool rendered as a thinking-style collapsible block: wrench icon + name +
 * one-line humanized params on the trigger; result in the expandable body. */
function ToolBlock({ tool, approval }: { tool: ToolRecord; approval?: Approval }) {
  const params = humanizeArgs(tool.args);
  const clipped = params.length > MAX_TOOL_SUMMARY
    ? `${params.slice(0, MAX_TOOL_SUMMARY)}…`
    : params;
  const resultText =
    tool.result == null
      ? undefined
      : typeof tool.result === "string"
        ? tool.result
        : JSON.stringify(tool.result, null, 2);
  return (
    <Reasoning isStreaming={tool.status === "running"}>
      <ReasoningTrigger>
        <WrenchIcon className="size-4" />
        <span className="font-mono text-xs">{tool.toolName}</span>
        {params && (
          <span className="truncate font-mono text-xs text-muted-foreground">
            ({clipped})
          </span>
        )}
        <span className="ml-auto text-xs text-muted-foreground">
          {approval?.status === "pending"
            ? "awaiting approval"
            : approval && approval.status !== "approved"
              ? "not run"
              : tool.status === "running"
                ? "running…"
                : tool.status === "error"
                  ? "failed"
                  : "done"}
        </span>
      </ReasoningTrigger>
      <ReasoningContent>
        {tool.error
          ? tool.error
          : resultText !== undefined
            ? truncateResult(resultText)
            : params || "(no result)"}
      </ReasoningContent>
    </Reasoning>
  );
}

/** Event names whose payload is just a stream token (thinking/text stream one
 *  frame per token). We keep the event type but suppress the payload so the
 *  feed/status doesn't flash every token of "thinking this / thinking is …". */
const TOKEN_EVENTS = new Set(["thinking", "text"]);

type GroupedEvent = {
  event: string;
  count: number;
  /** ms offset of the first frame in the group. */
  at: number;
  /** Payload snippet — only kept for non-token events (tool/task/error…). */
  data: string;
};

/** Coalesce consecutive same-event frames into one group. Streaming token
 *  events collapse to a single ``thinking`` / ``text`` line (no per-token text);
 *  meaningful events keep a short payload snippet. */
function coalesceEvents(events: RawEvent[]): GroupedEvent[] {
  const out: GroupedEvent[] = [];
  for (const e of events) {
    const prev = out[out.length - 1];
    if (prev && prev.event === e.event) {
      prev.count += 1;
      continue;
    }
    out.push({
      event: e.event,
      count: 1,
      at: e.at,
      data: TOKEN_EVENTS.has(e.event) ? "" : snippet(e.data).slice(0, 60),
    });
  }
  return out;
}

/** A compact status bar: overall state (live event / done) + elapsed, with a
 * toggle that expands the full raw SSE event feed underneath. */
function StatusBar({
  active,
  running,
  showRaw,
  setShowRaw,
}: {
  active: Turn | null;
  running: boolean;
  showRaw: boolean;
  setShowRaw: (v: boolean) => void;
}) {
  const groups = active ? coalesceEvents(active.rawEvents) : [];
  // Last coalesced group that is an *active-stream* event (model/tool delivery),
  // ignoring background `task` frames (memory consolidation, maintenance) which
  // belong to a future "background processes" sidebar, not the current-event line.
  const lastGroup =
    [...groups].reverse().find((g) => g.event !== "task") ?? null;
  const done = active?.done ?? false;

  // Tick once a second so the elapsed display stays live without calling
  // Date.now() during render (react-hooks/purity).
  const [now, setNow] = useState(() =>
    Math.round((Date.now() - (active?.startedAt ?? Date.now())) / 1000),
  );
  useEffect(() => {
    if (!running && done) return;
    const id = window.setInterval(
      () => setNow(Math.round((Date.now() - (active?.startedAt ?? Date.now())) / 1000)),
      1000,
    );
    return () => window.clearInterval(id);
  }, [running, done, active?.startedAt]);

  const elapsed = Math.max(0, now);

  return (
    <div>
      <div className="mb-1 flex h-5 items-center gap-2 px-1 text-xs text-muted-foreground">
        {running ? (
          <span className="flex items-center gap-1.5 font-medium text-foreground">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
            {lastGroup
              ? `${lastGroup.event}${lastGroup.count > 1 ? ` ×${lastGroup.count}` : ""}${lastGroup.data ? ` · ${lastGroup.data}` : ""}`
              : "connecting…"}
          </span>
        ) : (
          <span className="flex items-center gap-1.5 font-medium text-foreground">
            <span
              className={
                done || active
                  ? "h-1.5 w-1.5 rounded-full bg-emerald-500"
                  : "h-1.5 w-1.5 rounded-full bg-muted-foreground"
              }
            />
            {done ? "done" : active ? "idle" : "ready"}
          </span>
        )}
        {active && <span className="tabular-nums text-muted-foreground">{elapsed}s</span>}
        <button
          type="button"
          onClick={() => setShowRaw(!showRaw)}
          className="ml-auto rounded px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          title="Toggle raw event feed"
        >
          {showRaw ? "hide events" : `${active?.rawEvents.length ?? 0} events`}
        </button>
      </div>
      {showRaw && <RawEventFeed groups={groups} />}
    </div>
  );
}

/** A tiny human-readable snippet of a raw event payload for the status line. */
function snippet(data: string): string {
  const s = data.trim();
  if (!s) return "";
  try {
    const o = JSON.parse(s);
    if (typeof o === "object" && o !== null) {
      const text = o.text ?? o.detail ?? o.tool_name ?? o.label ?? o.status;
      if (text) return String(text).slice(0, 60);
    }
  } catch {
    // not JSON — use as-is
  }
  return s.slice(0, 60);
}

/** A raw terminal-style feed of the event stream. Streaming token events
 *  (thinking/text) collapse to one line each so it doesn't flash every token. */
function RawEventFeed({ groups }: { groups: GroupedEvent[] }) {
  const bottomRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = bottomRef.current;
    if (el) el.scrollIntoView({ block: "nearest" });
  }, [groups.length]);

  return (
    <div className="max-h-40 overflow-y-auto rounded-md border bg-background/60 p-2 font-mono text-[11px] leading-5">
      {groups.length === 0 && <div className="text-muted-foreground">no events yet</div>}
      {groups.map((g, i) => (
        <div key={i} className="flex gap-2 whitespace-pre-wrap break-all">
          <span className="shrink-0 text-muted-foreground">
            {(g.at / 1000).toFixed(2)}
          </span>
          <span className="shrink-0 font-semibold text-foreground">
            {g.event}
            {g.count > 1 && <span className="text-muted-foreground"> ×{g.count}</span>}
          </span>
          {g.data && <span className="text-muted-foreground">{g.data}</span>}
        </div>
      ))}
      <div ref={bottomRef} />
    </div>
  );
}


/** A static, already-finished Turn restored from history. Maps the backend's
 *  structured log (thinking / tool / text) straight onto TurnLogEntry so prior
 *  turns render the full timeline — thinking blocks, tool rows, final answer. */
function historyTurn(log: HistoryLog): Turn {
  const turnLog: Turn["log"] = (log as Array<{
    kind: string;
    text?: string;
    toolName?: string;
    args?: unknown;
    result?: unknown;
    error?: string;
    status?: string;
    stepId?: string;
  }>)
    .filter(
      (e) => e.kind === "thinking" || e.kind === "text" || e.kind === "tool",
    )
    .map((e) => {
      if (e.kind === "thinking" || e.kind === "text") {
        return { kind: e.kind as "thinking" | "text", text: e.text ?? "" };
      }
      return {
        kind: "tool" as const,
        stepId: e.stepId ?? "",
        toolName: e.toolName ?? "",
        status: (e.status === "error" ? "error" : e.status === "running" ? "running" : "done") as
          | "running"
          | "done"
          | "error",
        args: e.args,
        result: e.result,
        error: e.error,
      };
    });
  return {
    conversationId: DEFAULT_CONVERSATION_ID,
    userPrompt: "",
    parts: [],
    tools: [],
    log: turnLog,
    processes: [],
    plan: [],
    rawEvents: [],
    startedAt: 0,
    done: true,
  };
}

/** Settled history (server-authoritative) -> transcript entries. */
function entriesFromHistory(msgs: Awaited<ReturnType<typeof getHistory>>): Entry[] {
  return msgs.map((m, i) => {
    const base = { id: `h-${m.role}-${i}-${Date.now()}` };
    return m.role === "user"
      ? { ...base, role: "user" as const, text: m.text, images: m.images }
      : {
          ...base,
          role: "assistant" as const,
          turn: historyTurn(m.log as HistoryLog),
        };
  });
}


/** The assistant turn: renders the chronological log (thinking / tool / text /
 * task) in arrival order, not grouped by type. Both
 * thinking and tool calls are the same uniform `Reasoning` block (icon on the
 * trigger, detail expandable); text and task chips follow.
 *
 * Memoized: across SSE frames only the LIVE turn's `turn` reference changes, so
 * past turns short-circuit here — the whole transcript no longer re-parses /
 * re-renders on every token frame (the stream-freeze fix). */
const AssistantTurn = memo(function AssistantTurn({ turn }: { turn: Turn }) {
  // A tool row shows "awaiting approval" / "not run" from its approval, matched
  // by step id (the tool call id on both sides).
  const approvalByStep = new Map((turn.approvals ?? []).map((a) => [a.stepId, a]));
  return (
    <Message from="assistant">
      {turn.log.map((entry, i) => {
        switch (entry.kind) {
          case "thinking": {
            // Streaming only while this chunk is the active tail (no later
            // event of any kind — including answer text — and turn not done).
            // Once text/tool follows, it stops shimmering, records its own
            // duration, and auto-collapses.
            const laterAny = turn.log.slice(i + 1).length > 0;
            const isStreaming = !turn.done && !laterAny;
            return (
              <Reasoning isStreaming={isStreaming} key={i}>
                <ReasoningTrigger />
                <ReasoningContent>{entry.text}</ReasoningContent>
              </Reasoning>
            );
          }
          case "text": {
            // Stream the answer tail through Streamdown so markdown (bold /
            // code / links) shows live while it streams in. Thinking/tools
            // stay plain (see reasoning.tsx) which removed the original
            // freeze source; the answer block re-parses each flush but is the
            // user-facing prose where styled rendering matters.
            return (
              <MessageContent key={i} className="break-words">
                <MessageResponse
                  linkSafety={{ enabled: false }}
                  components={{
                    a: ({
                      href,
                      children,
                      // eslint-disable-next-line @typescript-eslint/no-unused-vars
                      node: _node,
                      ...rest
                    }: React.ComponentProps<"a"> & { node?: unknown }) => (
                      <a
                        href={href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-medium text-primary underline underline-offset-2"
                        {...rest}
                      >
                        {children}
                      </a>
                    ),
                  }}
                >
                  {entry.text}
                </MessageResponse>
              </MessageContent>
            );
          }
          case "tool":
            return (
              <ToolBlock
                key={entry.stepId}
                tool={entry}
                approval={approvalByStep.get(entry.stepId)}
              />
            );
          case "approval":
            return <ApprovalCard key={entry.approval.approvalId} approval={entry.approval} />;
          case "process":
            // Background processes no longer render inline in the transcript —
            // they live in the right sidebar Processes panel (Task 5).
            return null;
        }
      })}
      {turn.sources && turn.sources.length > 0 && (
        <Sources>
          <SourcesTrigger count={turn.sources.length} />
          <SourcesContent>
            {turn.sources.map((s) => (
              <Source href={s.href} key={s.href} title={s.title} />
            ))}
          </SourcesContent>
        </Sources>
      )}
      {turn.error && <p className="text-sm text-destructive">{turn.error}</p>}
    </Message>
  );
});

/** Scroll the conversation to the bottom after a user submit. Lives inside
 *  <Conversation> so it can read the scroll context; fires on each submitNonce
 *  bump. On touch (no StickToBottom provider) it scrolls the plain container
 *  ref directly; on desktop it uses the StickToBottom context. */
function AutoScrollToLatest({ nonce }: { nonce: number }) {
  const touchScroll = useTouchScroll();
  if (touchScroll) {
    return <TouchAutoScroll nonce={nonce} />;
  }
  return <StickToBottomAutoScroll nonce={nonce} />;
}

function TouchAutoScroll({ nonce }: { nonce: number }) {
  const touchScroll = useTouchScroll();
  useEffect(() => {
    if (nonce > 0 && touchScroll?.current) {
      touchScroll.current.scrollTop = touchScroll.current.scrollHeight;
    }
  }, [nonce, touchScroll]);
  return null;
}

function StickToBottomAutoScroll({ nonce }: { nonce: number }) {
  // Only rendered on desktop, where the StickToBottom provider exists.
  const { scrollToBottom } = useStickToBottomContext();
  useEffect(() => {
    if (nonce > 0) {
      scrollToBottom({ animation: "smooth" });
    }
    // Fire only on submit (nonce). Deliberately NOT depending on isAtBottom:
    // the library flips it when you scroll up to escape the follow lock — if
    // it were a dep, every scroll-up would re-fire this effect and yank the
    // view back down (it kept scrolling to the bottom while the user scrolled up).
  }, [nonce, scrollToBottom]);
  return null;
}

type PafChatProps = {
  conversationId?: string | null;
  /** Agent (profile) driving this conversation. The backend namespaces every
   *  lane by `{agent}:{conversation_id}`, so chat/steer/history must all be
   *  scoped to the same agent or a lane resolves to nothing. */
  agent: string;
  /** Called with the best-known client-side plan reconstructed from planning tools. */
  onPlan?: (plan: PlanItem[]) => void;
};

export default function PafChat({ conversationId, agent, onPlan }: PafChatProps) {
  const conversationIdRef = useRef(conversationId ?? DEFAULT_CONVERSATION_ID);
  conversationIdRef.current = conversationId ?? DEFAULT_CONVERSATION_ID;
  // Keep the latest onPlan in a ref so the memoized runTurn callback
  // (empty deps) can fire it without re-binding.
  const onPlanRef = useRef(onPlan);
  useEffect(() => {
    onPlanRef.current = onPlan;
  }, [onPlan]);
  const [transcript, setTranscript] = useState<Entry[]>([]);
  // The question of a turn started on ANOTHER device (or before a refresh) that
  // we attached to mid-flight: shown above the live turn, and folded into the
  // transcript with the settled answer. Null when the turn is our own.
  const [remotePrompt, setRemotePrompt] = useState<
    { text: string; images?: ChatImage[] } | null
  >(null);
  const remotePromptRef = useRef(remotePrompt);
  useEffect(() => {
    remotePromptRef.current = remotePrompt;
  });
  const [submitNonce, setSubmitNonce] = useState(0);
  const [backendUp, setBackendUp] = useState<boolean | null>(null);
  const [showRaw, setShowRaw] = useState(false);
  // Composer: uploads for the attached images, and the last attach/send error.
  const [pendingUploads] = useState(() => new PendingUploads());
  const [composerError, setComposerError] = useState<string | null>(null);

  // --- Per-lane live-turn store --------------------------------------------
  // The live turn for THIS lane is owned by the shared runStore (keyed
  // agent:cid), not by this component's local state. That way switching
  // conversations/agents never discards a streaming turn — the store keeps
  // accumulating frames for every running lane, and a returning pane simply
  // re-reads its lane's canonical turn. Only the lane's slice is subscribed,
  // so frames from other background lanes never re-render this component.
  const cid = conversationId ?? DEFAULT_CONVERSATION_ID;
  const storeLane = useRunStore(selectLane(agent, cid));
  const liveTurn: Turn | null | undefined = storeLane?.turn;
  const running = storeLane?.running ?? false;
  const activeTurn = liveTurn ?? (transcript
    .map((e) => (e.role === "assistant" ? e.turn : null))
    .filter(Boolean)
    .pop() as Turn | null);

  // Coalescing of high-frequency onTurn frames into store writes is handled in
  // `startRun` (runStore), throttled to ~100ms PER LANE — so all lanes,
  // including background ones, stream without saturating the main thread. The
  // old component-level flush refs are gone; nothing local re-renders on token
  // cadence anymore, the store slice does.

  const SUGGESTIONS = [
    "What can you do?",
    "Summarize the paf architecture",
    "Use a tool to check something",
  ];

  // Liveness probe on mount + every 15s.
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const up = await checkHealth();
      if (alive) setBackendUp(up);
    };
    void tick();
    const id = setInterval(tick, 15_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  // Restore the prior conversation on resume (server-authoritative history).
  // Re-runs when the active conversation changes (sidebar switch): clears the
  // transcript, then builds it from [{role,text}]. A live turn already running
  // (e.g. after a reload mid-stream) is left untouched for that same lane.
  useEffect(() => {
    let alive = true;
    const cid = conversationIdRef.current;
    // Switching lanes: start clean for the newly active conversation.
    setTranscript([]);
    setRemotePrompt(null);
    // Nothing selected yet (the list is still loading): don't read the
    // fallback lane — the read creates a backend session for it.
    if (!conversationId) return;
    void (async () => {
      // Load the authoritative plan from the server (durable across turns /
      // reloads — no client re-derivation). Idempotent; cleared on its own
      // if the conversation has no plan.
      const plan = await getPlan(cid, agent);
      if (alive) onPlanRef.current?.(plan);
      const msgs = await getHistory(cid, agent);
      if (!alive || msgs.length === 0) return;
      setTranscript((prev) => {
        if (prev.length > 0) return prev; // a live turn is already rendered
        return entriesFromHistory(msgs);
      });
    })();
    return () => {
      alive = false;
    };
  }, [conversationId]);

  const handleSubmit = useCallback(
    async (text: string, images: ChatImage[] = []) => {
      const trimmed = text.trim();
      if ((!trimmed && images.length === 0) || running) return;

      // Show the user's prompt immediately; the assistant's live turn renders
      // from the store lane (which startRun populates + keeps mutating), so a
      // lane switch never discards it.
      const userEntry: Entry = {
        id: `u-${Date.now()}`,
        role: "user",
        text: trimmed,
        ...(images.length ? { images } : {}),
      };
      setTranscript((prev) => [...prev, userEntry]);
      setSubmitNonce((n) => n + 1); // jump the conversation to the new prompt

      const imageIds = images.map((img) => img.id);
      await startRun(agent, cid, trimmed, {
        onPlan: (plan) => {
          // Scope the live plan to THIS lane: a background conversation's plan
          // frames must not overwrite the sidebar while the user is viewing a
          // different conversation (the cross-threaded-plan bug). The restore
          // effect re-fetches the active lane's plan on switch, so skipping a
          // background lane's frames here loses nothing.
          if (conversationIdRef.current !== cid) return;
          if (plan.length > 0) onPlanRef.current?.(plan);
        },
        onEnd: (settled) => {
          // This lane finished while the user is now viewing a DIFFERENT
          // conversation: don't append its answer to the wrong transcript (the
          // cross-threaded-answer bug). The completed turn isn't lost — it's
          // reloaded from getHistory when the user returns to this lane.
          if (conversationIdRef.current !== cid) return;
          // Persist the completed turn into the settled transcript so it
          // renders even once the store lane's `running` flips false (the live
          // branch below is gated on `running`, so without this the answer
          // would vanish at the moment of completion).
          setTranscript((prev) => [
            ...prev,
            { id: `a-${Date.now()}`, role: "assistant", turn: settled },
          ]);
          // Reconcile the sidebar to server truth on turn end: the store is
          // the single source, so whatever plan it holds (a brand-new one just
          // written, a kept completed one, or a cleared one) is what the panel
          // shows. This also restores a stored plan that a plan-less turn would
          // otherwise have left looking empty.
          void getPlan(cid, agent).then((p) => onPlanRef.current?.(p));
        },
      }, imageIds);
    },
    [running, agent, cid],
  );

  const handleCancel = useCallback(async () => {
    await cancel(cid, agent);
    // Abort the local reader too so the turn settles immediately (the server
    // cancel also ends the stream, which flips the store lane to running=false
    // via startRun's finally).
    storeLane?.abort?.();
  }, [cid, agent, storeLane]);

  /** Steer the running turn (Session.enqueue, priority asap): injects the
   *  message mid-turn so the model redirects after its current step. The
   *  steered text is shown optimistically as a user bubble; the redirect
   *  streaming into the SAME live store turn after we reset its accumulation,
   *  so there's no backfill of the original answer (the "duplicate while
   *  responding" bug) and no lost pre-redirect frames. */
  const handleSteer = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || !running) return;
      const res = await steer(cid, trimmed, {
        priority: "asap",
        agent,
      });
      if (res.ok) {
        // Reset the live turn's accumulation so the redirect builds a fresh
        // answer — no original-answer backfill into the same bubble.
        useRunStore.getState().resetTurn(agent, cid);
        setTranscript((prev) => [
          ...prev,
          { id: `s-${Date.now()}`, role: "user", text: trimmed },
        ]);
        setSubmitNonce((n) => n + 1);
      }
    },
    [running, agent, cid],
  );

  const handleSuggestionClick = useCallback(
    (suggestion: string) => {
      if (running) return;
      void handleSubmit(suggestion);
    },
    [handleSubmit, running],
  );

  /** Durable re-attach: rejoin any in-flight turn for the focused
   *  conversation. The backend rejoin mode attaches to a running turn (live
   *  tail) or returns an empty stream (no turn — history renders it). No-op
   *  when the lane is already live. Called on initial load (refresh) and when
   *  the tab becomes visible again (mobile background -> foreground). */
  const selected = conversationId != null;
  const tryRejoin = useCallback(() => {
    if (!selected) return; // no lane selected yet: nothing to rejoin
    // A lane with a live socket is already streaming. A DROPPED lane (running +
    // disconnected: the app was backgrounded) must be rejoined.
    const lane = useRunStore.getState().peekLane(agent, cid);
    if (lane?.running && !lane.disconnected) return;
    const wasDisconnected = !!lane?.disconnected;
    void rejoinRun(agent, cid, {
      onPlan: (plan) => {
        if (conversationIdRef.current !== cid) return;
        if (plan.length > 0) onPlanRef.current?.(plan);
      },
      onPrompt: (p) => {
        if (conversationIdRef.current !== cid) return;
        // Our OWN turn re-attached after a dropped socket: its question is already
        // in the transcript. Decided by whether this lane was ours (running +
        // disconnected), never by comparing text: the same message sent twice is
        // legitimate and must still appear.
        if (wasDisconnected) return;
        setRemotePrompt({ text: p.text, images: p.images });
      },
      onEnd: (settled) => {
        if (conversationIdRef.current !== cid) return;
        const asked = remotePromptRef.current;
        setRemotePrompt(null);
        setTranscript((prev) => [
          ...prev,
          ...(asked
            ? [
                {
                  id: `u-${Date.now()}`,
                  role: "user" as const,
                  text: asked.text,
                  images: asked.images,
                },
              ]
            : []),
          { id: `a-${Date.now()}`, role: "assistant", turn: settled },
        ]);
        void getPlan(cid, agent).then((p) => onPlanRef.current?.(p));
      },
    }).then(async (result) => {
      if (result === "idle") setRemotePrompt(null);
      // The turn finished while we were away: nothing is left to rejoin, and the
      // partial view was released, so pull the settled answer from server history.
      if (result !== "idle" || !wasDisconnected) return;
      const msgs = await getHistory(cid, agent);
      if (conversationIdRef.current !== cid || msgs.length === 0) return;
      setTranscript(entriesFromHistory(msgs));
      void getPlan(cid, agent).then((p) => onPlanRef.current?.(p));
    });
  }, [agent, cid, selected]);

  // While the socket is dropped but the turn is still running server-side, keep
  // trying to re-attach (every 4s, only when visible): the first attempt after
  // un-backgrounding often fails because the phone's network is still waking up.
  const dropped = running && !!storeLane?.disconnected;
  useEffect(() => {
    if (!dropped) return;
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") tryRejoin();
    }, 4000);
    return () => window.clearInterval(id);
  }, [dropped, tryRejoin]);

  // Rejoin the focused conversation's in-flight turn. Runs on mount AND whenever
  // the active conversation resolves/changes. On first load conversationId may
  // be undefined, so cid is the DEFAULT until the sidebar restores the real one
  // — a refresh must rejoin the actually-open conversation, not the default
  // lane, which is why this is keyed on tryRejoin/[agent, cid] rather than once.
  useEffect(() => {
    tryRejoin();
  }, [tryRejoin]);

  // Notify re-attach: the backend emits a `turn:` frame on the
  // conversation process feed when a detached notify turn starts. Rejoin it so
  // the completion response streams live instead of only appearing after a
  // refresh. tryRejoin no-ops when the lane is already live (a user turn is
  // streaming), and the rejoin's onEnd appends the settled turn to the
  // transcript so it stays visible once streaming stops.
  useEffect(() => {
    if (!selected) return;
    const disconnect = subscribeProcesses({
      conversationId: cid,
      agent,
      lane: "conversation",
      onTurnStarted: () => tryRejoin(),
    });
    return () => disconnect();
  }, [agent, cid, selected, tryRejoin]);

  // On becoming visible again (mobile background -> foreground): rejoin the
  // focused lane, whose SSE socket likely dropped while the tab was suspended.
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === "visible") tryRejoin();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [tryRejoin]);

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <Conversation>
        <AutoScrollToLatest nonce={submitNonce} />
        <ConversationContent>
          {transcript.length === 0 && !liveTurn ? (
            <ConversationEmptyState
              title="paf chat"
              description="Ask a conversation something. Tool calls render as live rows."
            />
          ) : (
            <>
              {transcript.map((entry) =>
                entry.role === "user" ? (
                  <Message from="user" key={entry.id}>
                    <MessageContent className="whitespace-pre-wrap break-words">
                      {entry.images?.length ? (
                        <UserImages images={entry.images} />
                      ) : null}
                      {entry.text}
                    </MessageContent>
                  </Message>
                ) : (
                  <MessageBranch defaultBranch={0} key={entry.id}>
                    <MessageBranchContent>
                      <AssistantTurn turn={entry.turn} />
                    </MessageBranchContent>
                  </MessageBranch>
                ),
              )}
            </>
          )}
          {/* The live turn for this lane, owned by the run store. Rendered on
              top of the settled transcript so a still-streaming turn shows even
              after switching away and back — the store kept accumulating frames
              while this pane was showing another lane. Gated on `running` so a
              completed turn (already persisted into transcript via onEnd /
              getHistory) isn't double-rendered. */}
          {/* A lane whose socket dropped but whose turn is still running
              server-side (durable re-attach) shows a reconnecting hint; the
              visibility handler reopens the SSE. The stop button still works
              (running stays true) so the user can cancel the server turn. */}
          {running && storeLane?.disconnected && (
            <div className="flex items-center gap-2 px-1 py-1 text-xs text-amber-600">
              <span>still running server-side · reconnecting…</span>
              <button
                type="button"
                onClick={() => tryRejoin()}
                className="rounded border border-amber-600/40 px-1.5 py-0.5 font-medium hover:bg-amber-600/10"
              >
                Reconnect now
              </button>
            </div>
          )}
          {running && remotePrompt && (
            <Message from="user">
              <MessageContent className="whitespace-pre-wrap break-words">
                {remotePrompt.images?.length ? (
                  <UserImages images={remotePrompt.images} />
                ) : null}
                {remotePrompt.text}
              </MessageContent>
            </Message>
          )}
          {running && liveTurn && (
            <MessageBranch defaultBranch={0} key={`live-${liveTurn.startedAt}`}>
              <MessageBranchContent>
                <AssistantTurn turn={liveTurn} />
              </MessageBranchContent>
            </MessageBranch>
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <div className="border-t bg-background p-3">
        {transcript.length === 0 && (
          <Suggestions className="mx-auto w-full max-w-3xl pb-3">
            {SUGGESTIONS.map((s) => (
              <Suggestion
                key={s}
                suggestion={s}
                onClick={handleSuggestionClick}
              />
            ))}
          </Suggestions>
        )}
        <StatusBar
          active={activeTurn}
          running={running}
          showRaw={showRaw}
          setShowRaw={setShowRaw}
        />
        <div className="mb-1 flex items-center justify-between gap-2 px-1 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span
              className={
                backendUp === null
                  ? "h-1.5 w-1.5 rounded-full bg-muted-foreground"
                  : backendUp
                    ? "h-1.5 w-1.5 rounded-full bg-emerald-500"
                    : "h-1.5 w-1.5 rounded-full bg-red-500"
              }
            />
            {backendUp === null
              ? "checking backend…"
              : backendUp
                ? "paf-sse connected"
                : "paf-sse unreachable"}
          </span>
          <span className="flex items-center gap-2">
            <span className="truncate">agent · {agent}</span>
          </span>
        </div>
        <PromptInput
          accept="image/*"
          multiple
          maxFileSize={MAX_IMAGE_BYTES}
          onError={(err) => setComposerError(err.message)}
          onSubmit={async (msg, event) => {
            // PromptInput has already emptied the textarea; on a throw it
            // keeps the attachments, so put the text back too.
            const keepDraft = (error: string) => {
              const area = (event.target as HTMLFormElement).elements.namedItem(
                "message",
              );
              if (area instanceof HTMLTextAreaElement) area.value = msg.text;
              setComposerError(error);
              throw new Error(error);
            };
            if (running) {
              if (pendingUploads.count > 0) {
                keepDraft(
                  "Images can't be added to a running turn — send them once it finishes.",
                );
              }
              void handleSteer(msg.text);
              return;
            }
            let images: ChatImage[];
            try {
              images = (await pendingUploads.collect()).map(
                ({ id, name, width, height }) => ({ id, name, width, height }),
              );
            } catch (err) {
              return keepDraft(`Image upload failed: ${(err as Error).message}`);
            }
            setComposerError(null);
            void handleSubmit(msg.text, images);
          }}
          className="mt-2"
        >
          <ImageAttachments agent={agent} pending={pendingUploads} />
          {/* Textarea fills the input box; the send/stop button is pinned
              top-right (absolute within the relative InputGroup), so it reads
              as a return/stop affordance at the top of the box rather than
              bottom-left in a footer row. */}
          <PromptInputTextarea
            placeholder={
              running ? "Steer the running turn… (asap)" : "Message paf…"
            }
            className="pr-20"
            autoFocus
          />
          <AttachImageButton
            disabled={running}
            className="absolute right-11 top-2 z-10"
          />
          <PromptInputSubmit
            status={running ? "streaming" : undefined}
            onStop={handleCancel}
            className="absolute right-2 top-2 z-10"
          />
        </PromptInput>
        {composerError ? (
          <p className="mt-1 px-1 text-xs text-destructive">{composerError}</p>
        ) : null}
      </div>
    </div>
  );
}
