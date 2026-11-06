// lib/paf/adapter.ts
// ---------------------------------------------------------------------------
// Folds the raw paf SSE frames into a renderable `Turn` model for the chat UI.
//
// The transport /api/chat emits an unbounded stream of `event:` frames. This
// adapter maps each frame onto the live Turn: appending answer parts and
// creating/updating tool rows (keyed by step_id). Background/maintenance
// `task:` frames do NOT ride /api/chat — they flow on the dedicated
// /api/processes/stream feed (lib/paf/processes.ts), so they can never
// interleave into (and tear) a thinking/text block. It hands the final Turn
// to a callback when the lane closes.

import { streamSse } from "./sse";
import { PAF_CHAT_URL } from "./config";
import { approvalFromWire, getPendingApprovals } from "./api";
import type {
  Approval,
  PafFrame,
  PlanItem,
  PromptFrame,
  Turn,
  TurnLogEntry,
} from "./types";

export type RunControl = {
  /** Clear the accumulated in-flight turn (used at a steer boundary). */
  reset?: () => void;
};

export type AdapterHooks = {
  /** Called after every frame with the in-progress turn (for live rendering). */
  onTurn?: (turn: Turn) => void;
  /** Called once, when the lane EOFs / ends (either naturally or with an error). */
  onEnd?: (turn: Turn) => void;
  /** Called when the turn produces plan data (regardless of throttling). */
  onPlan?: (plan: PlanItem[]) => void;
  /** A re-attach to a turn this client did not start: the question it answers
   *  (first frame of a rejoin). */
  onPrompt?: (prompt: Pick<PromptFrame, "text" | "images">) => void;
  /** Called when the live SSE socket drops but the turn is still running
   *  server-side (durable turns: disconnect != cancel). The turn is NOT
   *  settled; a re-attach can rejoin it. */
  onDisconnect?: (turn: Turn) => void;
};

export type RunResult = { turn: Turn };

/**
 * Run one paf turn and fold SSE frames into a `Turn`.
 *
 * The stream stays open past the final text event to carry post-turn `task:`
 * frames; it only ends on server EOF. Resolution therefore reflects stream end,
 * not "answer complete" — the UI should keep rendering while `turn.done` is
 * false.
 */
export async function runTurn(
  conversationId: string,
  prompt: string,
  hooks: AdapterHooks = {},
  opts: {
    agent?: string;
    control?: RunControl;
    signal?: AbortSignal;
    rejoin?: boolean;
    /** Upload ids of images attached to this message (POST /api/uploads). */
    images?: string[];
  } = {},
): Promise<RunResult> {
  const rejoin = opts.rejoin ?? false;
  const turn: Turn = {
    conversationId,
    userPrompt: rejoin ? "" : prompt,
    parts: [],
    tools: [],
    log: [],
    processes: [],
    plan: [],
    rawEvents: [],
    approvals: [],
    startedAt: Date.now(),
    done: false,
  };

  /** Drop the pre-steer accumulation so the next onTurn only carries the
   *  redirect (used by the UI at a steer boundary to avoid backfilling old
   *  content into a fresh assistant bubble). */
  const reset = (): void => {
    turn.parts = [];
    turn.tools = [];
    turn.processes = [];
    turn.rawEvents = [];
    // A request still waiting for the user must stay on screen across a steer.
    const pending = (turn.approvals ?? []).filter((a) => a.status === "pending");
    turn.approvals = pending;
    turn.log = pending.map((approval) => ({ kind: "approval" as const, approval }));
  };
  if (opts.control) opts.control.reset = reset;

  const fire = (): void =>
    hooks.onTurn?.({
      ...turn,
      tools: [...turn.tools],
      parts: [...turn.parts],
      log: [...turn.log],
      // `turn.processes` no longer carries data: background/maintenance work
      // was decoupled from /api/chat onto the dedicated
      // /api/processes/stream feed (lib/paf/processes.ts). Kept as an empty
      // array for type stability; the ProcessesPanel binds to the feed instead.
      processes: [...turn.processes],
      approvals: [...(turn.approvals ?? [])],
    });

  // Set when the SSE reader drops mid-stream (a non-abort transport error).
  // The turn is still running server-side, so we must NOT settle it as done
  // (onDone fires right after onError on the drop path) — a re-attach rejoins.
  let streamDropped = false;

  /** Append a thinking/text token to both `parts` and the chronological `log`.
   *
   *  The merge decision keys off the last *content* `log` entry. Three cases:
   *
   *  1. Same content kind immediately before (no tool in between) → merge into
   *     the same block. (Defensive: we still skip any stray non-content entries
   *     so a future frame type could never tear a block mid-token.)
   *  2. A TOOL sits between the last same-kind content and this token → open a
   *     NEW block. `parts` has no tool rows, so keying off the last `parts`
   *     entry would merge post-tool thinking back into the pre-tool block (the
   *     "thinking after a tool doesn't render" bug). The tool
   *     is a real content boundary.
   *  3. No prior content → open a block.
   */
  const appendText = (kind: "thinking" | "text", text: string): void => {
    if (!text) return;
    // The last non-process log entry = the last real content boundary.
    let le: TurnLogEntry | undefined;
    for (let i = turn.log.length - 1; i >= 0; i--) {
      if (turn.log[i].kind !== "process") {
        le = turn.log[i];
        break;
      }
    }
    if (le && le.kind === kind) {
      // Same content kind immediately before (no tool in between) → continuation
      // of the same logical block. Append to the last *same-kind* log entry
      // (walking past any trailing invisible `process` frames), and to the last
      // same-kind `parts` entry — so parts and log stay in sync.
      let logLast: Extract<TurnLogEntry, { kind: "thinking" | "text" }> | undefined;
      for (let i = turn.log.length - 1; i >= 0; i--) {
        const e = turn.log[i];
        if (e.kind === "thinking" || e.kind === "text") {
          if (e.kind === kind) logLast = e;
          break; // nearest thinking/text entry
        }
      }
      if (logLast) {
        logLast.text += text;
      } else {
        turn.log.push({ kind, text });
      }
      const partsLast = turn.parts[turn.parts.length - 1];
      if (partsLast && partsLast.type === kind) {
        partsLast.text += text;
      } else {
        turn.parts.push({ type: kind, text });
      }
    } else {
      // Different content kind before, or a tool boundary, or nothing → open a
      // NEW block in both parts and log.
      turn.log.push({ kind, text });
      turn.parts.push({ type: kind, text });
    }
  };

  /** Find the chronological tool entry for a stepId/tool (start one if absent). */
  const logTool = (
    stepId: string,
    toolName: string,
  ): Extract<TurnLogEntry, { kind: "tool" }> => {
    let entry = turn.log.find(
      (e): e is Extract<TurnLogEntry, { kind: "tool" }> =>
        e.kind === "tool" && e.stepId === stepId,
    );
    if (!entry) {
      entry = { kind: "tool", stepId, toolName, status: "running" };
      turn.log.push(entry);
    } else {
      entry.toolName = toolName; // keep display name fresh
    }
    return entry;
  };

  /** Add a pending approval (once: a re-attach may also fetch it over REST). */
  const addApproval = (approval: Approval): void => {
    const list = (turn.approvals ??= []);
    if (list.some((a) => a.approvalId === approval.approvalId)) return;
    list.push(approval);
    turn.log.push({ kind: "approval", approval });
  };

  /** Settle an approval. Replaced (not mutated) so memoized rows re-render. */
  const settleApproval = (
    approvalId: string,
    patch: Pick<Approval, "status" | "actor" | "note">,
  ): void => {
    const list = turn.approvals ?? [];
    const i = list.findIndex((a) => a.approvalId === approvalId);
    if (i === -1) return; // never saw the request (e.g. settled before we attached)
    const next: Approval = { ...list[i], ...patch };
    list[i] = next;
    const j = turn.log.findIndex(
      (e) => e.kind === "approval" && e.approval.approvalId === approvalId,
    );
    if (j !== -1) turn.log[j] = { kind: "approval", approval: next };
  };

  const apply = (frame: PafFrame): void => {
    switch (frame.kind) {
      case "approval_requested": {
        const { kind: _kind, ...rest } = frame;
        void _kind;
        addApproval({ ...rest, status: "pending" });
        break;
      }
      case "approval_resolved": {
        settleApproval(frame.approvalId, {
          status: frame.outcome,
          actor: frame.actor || undefined,
          note: frame.note || undefined,
        });
        break;
      }
      case "prompt": {
        hooks.onPrompt?.({ text: frame.text, images: frame.images });
        break;
      }
      case "thinking":
      case "text": {
        appendText(frame.kind, frame.text ?? "");
        break;
      }
      case "tool_call": {
        // A tool invocation opens a running row (or marks re-entry by step).
        const existing = turn.tools.find(
          (t) => t.toolName === frame.toolName && t.status === "running",
        );
        let stepId = existing?.stepId;
        if (existing) {
          existing.args = frame.args ?? existing.args;
          stepId = existing.stepId;
        } else {
          stepId = `call-${turn.tools.length}`;
          turn.tools.push({
            stepId,
            toolName: frame.toolName,
            status: "running",
            args: frame.args ?? undefined,
          });
        }
        const entry = logTool(stepId, frame.toolName ?? "tool");
        if (frame.args !== undefined) entry.args = frame.args;
        break;
      }
      case "tool_result": {
        const row = turn.tools.find(
          (t) => t.toolName === frame.toolName && t.status === "running",
        );
        if (row) {
          row.status = "done";
          row.result = frame.text;
          const entry = logTool(row.stepId, row.toolName);
          entry.status = "done";
          entry.result = row.result;
        }
        break;
      }
      case "tool_running": {
        // step_id is authoritative. paf emits tool_call (no step_id) BEFORE
        // tool_running (with step_id) for the same invocation, so the tool_call
        // branch may have already created a `call-N` placeholder row + log entry.
        // Re-key that placeholder onto the real step_id (both row AND log entry)
        // so later tool_result/tool_error updates land on ONE chronological row.
        let oldStepId: string | undefined;
        let row = turn.tools.find((t) => t.stepId === frame.stepId);
        if (!row) {
          const placeholder = turn.tools.find(
            (t) => t.toolName === frame.toolName && t.status === "running",
          );
          if (placeholder && placeholder.stepId.startsWith("call-")) {
            row = placeholder;
            oldStepId = placeholder.stepId;
            row.stepId = frame.stepId; // promote row to the real id
            // Re-key the matching chronological log entry in place (keeps its
            // position in the event log; no duplicate created below).
            const orphan = turn.log.find(
              (e): e is Extract<TurnLogEntry, { kind: "tool" }> =>
                e.kind === "tool" && e.stepId === oldStepId,
            );
            if (orphan) orphan.stepId = frame.stepId;
          }
        }
        if (!row) {
          row = { stepId: frame.stepId, toolName: frame.toolName, status: "running" };
          turn.tools.push(row);
        } else {
          row.toolName = frame.toolName;
          row.status = "running";
        }
        logTool(frame.stepId, frame.toolName ?? "tool");
        break;
      }
      case "tool_error": {
        const row = turn.tools.find((t) => t.stepId === frame.stepId);
        if (row) {
          row.status = "error";
          row.error = frame.error;
          const entry = logTool(row.stepId, row.toolName);
          entry.status = "error";
          entry.error = row.error;
        }
        break;
      }
      case "process": {
        turn.processes.push(frame);
        break;
      }
      case "plan": {
        // Server pushes the FULL snapshot per mutation — direct mirror, no merge.
        turn.plan = frame.items;
        break;
      }
      case "warn": {
        // Non-fatal transport/parse glitch: log it and keep streaming the turn.
        // A malformed payload must never kill the rest of the answer.
        console.warn("[paf] skipping malformed frame:", frame.detail);
        break;
      }
      case "error": {
        turn.error = frame.detail;
        turn.done = true;
        break;
      }
    }
  };

  const parse = (event: string, data: string): PafFrame => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      // Recoverable: don't kill the turn over one glitchy frame. Surface it as
      // a warning + keep streaming (the next frame carries the real content).
      return { kind: "warn", detail: `bad frame payload: ${data.slice(0, 80)}` };
    }
    const o = parsed as Record<string, unknown>;
    switch (event) {
      case "thinking":
      case "text":
        return { kind: event, text: String(o.text ?? "") } as PafFrame;
      case "tool_call":
      case "tool_result":
        return {
          kind: event,
          text: String(o.text ?? ""),
          toolName: String(o.tool_name ?? "tool"),
          args: o.args ?? undefined,
        } as PafFrame;
      case "tool_running":
        return {
          kind: "tool_running",
          stepId: String(o.step_id ?? ""),
          toolName: String(o.tool_name ?? "tool"),
        } as PafFrame;
      case "tool_error":
        return {
          kind: "tool_error",
          stepId: String(o.step_id ?? ""),
          error: String(o.error ?? "tool error"),
        } as PafFrame;
      case "plan": {
        const items = Array.isArray(o.items) ? (o.items as PlanItem[]) : [];
        return { kind: "plan", items };
      }
      case "approval_requested": {
        const { status: _status, ...rest } = approvalFromWire(o);
        void _status;
        return { kind: "approval_requested", ...rest };
      }
      case "approval_resolved":
        return {
          kind: "approval_resolved",
          approvalId: String(o.approval_id ?? ""),
          stepId: String(o.step_id ?? ""),
          toolName: String(o.tool_name ?? "tool"),
          outcome: String(o.outcome ?? "denied") as Exclude<Approval["status"], "pending">,
          actor: String(o.actor ?? ""),
          note: String(o.note ?? ""),
        };
      case "prompt":
        return {
          kind: "prompt",
          text: String(o.text ?? ""),
          images: Array.isArray(o.images)
            ? (o.images as NonNullable<PromptFrame["images"]>)
            : undefined,
        };
      case "error":
        return { kind: "error", detail: String(o.detail ?? "server error") } as PafFrame;
      default:
        return { kind: "warn", detail: `unhandled event: ${event}` };
    }
  };

  // Re-attaching mid-turn: an approval request may already be waiting, and its
  // frame went out before we subscribed. Fetch what is pending and show it.
  if (rejoin) {
    void getPendingApprovals(conversationId, opts.agent).then((pending) => {
      if (pending.length === 0 || turn.done) return;
      for (const approval of pending) addApproval(approval);
      fire();
    });
  }

  try {
    await streamSse(
      PAF_CHAT_URL,
      rejoin
        ? {
            conversation_id: conversationId,
            rejoin: true,
            ...(opts.agent ? { agent: opts.agent } : {}),
          }
        : {
            conversation_id: conversationId,
            prompt,
            ...(opts.agent ? { agent: opts.agent } : {}),
            ...(opts.images?.length ? { images: opts.images } : {}),
          },
      {
        onFrame: (event, data) => {
          turn.rawEvents.push({ event, data, at: Date.now() - turn.startedAt });
          apply(parse(event, data));
          fire();
        },
        onError: (err) => {
          // An intentional abort (Stop) is not an error — settle as done so
          // the turn doesn't surface "BodyStreamBuffer was aborted" etc.
          if (opts.signal?.aborted || err.name === "AbortError") {
            turn.done = true;
            turn.rawEvents.push({
              event: "chat.done",
              data: "{}",
              at: Date.now() - turn.startedAt,
            });
            fire();
            return;
          }
          // Durable turns: an unexpected socket drop is NOT an error — the turn
          // keeps running server-side (disconnect != cancel). Flag the lane
          // disconnected and let a re-attach rejoin; do NOT settle as error.
          streamDropped = true;
          turn.disconnected = true;
          turn.rawEvents.push({
            event: "chat.disconnected",
            data: JSON.stringify({ detail: err.message }),
            at: Date.now() - turn.startedAt,
          });
          fire();
          hooks.onDisconnect?.({
            ...turn,
            tools: [...turn.tools],
            parts: [...turn.parts],
          });
        },
        onDone: () => {
          // A dropped-but-running stream was already handled as a disconnect in
          // onError; the turn is still running server-side — do NOT settle it.
          if (streamDropped) return;
          turn.done = true;
          turn.rawEvents.push({
            event: "chat.done",
            data: "{}",
            at: Date.now() - turn.startedAt,
          });
          fire();
          // Guarantee a settled `done` paint even if the final SSE frame's
          // render pass was coalesced with (or lost to) the closing of the
          // stream — e.g. when a post-answer background task frame (memory
          // consolidation) lands as the stream's last frame and the final
          // answer text was committed but not yet painted. One more fire on
          // the next frame forces the complete turn to render before settling.
          requestAnimationFrame(() => requestAnimationFrame(fire));
          hooks.onEnd?.({ ...turn, tools: [...turn.tools], parts: [...turn.parts] });
        },
      },
      opts.signal ? { signal: opts.signal } : {},
    );
  } catch (err) {
    // A thrown error here means the request itself was rejected (non-2xx /
    // fetch failure) — a genuine error, NOT a durable mid-stream disconnect
    // (those are handled in onError and do not rethrow). Ensure done.
    // An intentional abort leaves the turn settled-as-done by onDone; don't
    // overwrite that with a bogus error.
    if (opts.signal?.aborted || (err instanceof Error && err.name === "AbortError")) {
      if (!turn.done) turn.done = true;
      hooks.onEnd?.({ ...turn, tools: [...turn.tools], parts: [...turn.parts] });
      return { turn };
    }
    streamDropped = false;
    turn.disconnected = false;
    if (!turn.done) turn.done = true;
    if (!turn.error) turn.error = err instanceof Error ? err.message : String(err);
    hooks.onEnd?.({ ...turn, tools: [...turn.tools], parts: [...turn.parts] });
  }

  return { turn };
}

/** Rejoin an in-flight turn on a conversation (refresh/visibility re-attach).
 *  Sends ``rejoin: true`` to /api/chat: attaches to the running turn's live
 *  tail if one is running, else returns an empty stream (history authoritative). */
export async function rejoinTurn(
  conversationId: string,
  hooks: AdapterHooks = {},
  opts: { agent?: string; signal?: AbortSignal } = {},
): Promise<RunResult> {
  return runTurn(conversationId, "", hooks, { ...opts, rejoin: true });
}

/** Rebuild a clean Turn for a subsequent user message on the same conversation. */
export function freshTurn(conversationId: string, prompt: string): Turn {
  return {
    conversationId,
    userPrompt: prompt,
    parts: [],
    tools: [],
    log: [],
    processes: [],
    plan: [],
    rawEvents: [],
    approvals: [],
    startedAt: Date.now(),
    done: false,
  };
}
