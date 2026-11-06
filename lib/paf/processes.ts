// lib/paf/processes.ts
// ---------------------------------------------------------------------------
// Dedicated, turn-independent background-process feed.
//
// Background / maintenance work (memory consolidation + its review, thread
// summarizer, ...) does NOT ride the turn's `/api/chat` stream anymore — it
// lives on its own long-lived `GET /api/processes/stream` SSE endpoint (see
// the paf docs). This module opens that
// socket once per lane and folds arriving `task:` frames into a coalesced list
// of `ProcessFrame`s, keyed by the stable backend task `id` (a transition
// queued->running->done is one row, not new rows).
//
// Because the endpoint is GET with query params, we use the native browser
// `EventSource` (auto-reconnects on drop) rather than the fetch-stream reader
// used for the POST `/api/chat`.
// ---------------------------------------------------------------------------

import type { ProcessFrame } from "./types";
import { PAF_PROCESSES_URL } from "./config";

export type ProcessesDisconnect = () => void;

/** The payload of a backend ``turn:`` frame (a detached notify turn started). */
export type TurnStartedFrame = {
  run_id?: string;
};

/** Process kinds whose every job is its own sidebar row (never coalesced). */
const PER_JOB_KINDS = ["shell.", "subagent."] as const;

/** Group key for coalescing. Background task ids are ``[<profile>:]{kind}.{cid}.{seq}``
 * (e.g. ``consolidation.demo:paf-abc.3`` or ``thread_summarize.paf-abc.2``), while the
 * always-on idle snapshot uses the stable raw ``{kind}.{cid}`` base with no
 * profile prefix. A live transition must share ONE row with its idle base, so
 * we normalize: strip a leading ``<profile>:`` scope AND a trailing ``.{seq}``.
 * This makes ``consolidation.demo:paf-abc.3`` == ``consolidation.paf-abc`` so
 * queued/running/done coalesce over the idle row instead of duplicating. */
function baseId(id: string): string {
  // Live task ids are ``{kind}.{profile}:{cid}.{seq}`` (e.g. ``consolidation.demo:paf-abc.3``);
  // idle bases are the raw ``{kind}.{cid}``. Drop the ``.{profile}:`` scope so
  // both map to ``{kind}.{cid}``, then drop the trailing ``.{seq}``. Shell
  // processes and subagent tasks are EXCEPTED: each is a distinct per-job row
  // (``shell.{profile}:{cid}.{seq}`` / ``subagent.{profile}:{cid}.{seq}``) with
  // no idle base, so they keep their run seq and never coalesce — otherwise
  // concurrent jobs in one conversation collapse to a single sidebar row.
  const unscoped = id.replace(/^([^.]+)\.[^:]+:/, "$1.");
  if (PER_JOB_KINDS.some((kind) => unscoped.startsWith(kind))) return unscoped;
  return unscoped.replace(/\.\d+$/, "");
}

/** Open the process feed for one lane, folding frames into a coalesced list.
 *
 * Calls `onProcesses` with a fresh array whenever any row changes (queued ->
 * running -> done|error|skipped). `onTurnStarted` fires when the backend emits a
 * ``turn:`` frame — a detached notify turn started on this lane — so the caller
 * can rejoin and stream it. Returns a disconnect function that closes the
 * socket and releases the subscription. Calling disconnect twice is a no-op.
 */
export function subscribeProcesses(opts: {
  conversationId?: string;
  agent: string;
  lane: "agent" | "conversation";
  onProcesses?: (processes: ProcessFrame[]) => void;
  onTurnStarted?: (frame: TurnStartedFrame) => void;
  onError?: (err: Event) => void;
}): ProcessesDisconnect {
  const { conversationId, agent, lane, onProcesses = () => {}, onTurnStarted } = opts;

  const rows = new Map<string, ProcessFrame>();

  const fire = () => onProcesses([...rows.values()]);

  const url = PAF_PROCESSES_URL({
    conversation_id: conversationId,
    agent,
    lane,
  });
  const es = new EventSource(url);

  // `turn:` frames are re-attach signals, not process rows: a detached notify
  // turn started on this lane. Surface them via onTurnStarted so the caller can
  // rejoin and stream the model response.
  es.addEventListener("turn", (ev: MessageEvent<string>) => {
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(ev.data) as Record<string, unknown>;
    } catch {
      return; // malformed frame: ignore, keep the socket alive
    }
    onTurnStarted?.({ run_id: typeof o.run_id === "string" ? o.run_id : undefined });
  });

  es.addEventListener("task", (ev: MessageEvent<string>) => {
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(ev.data) as Record<string, unknown>;
    } catch {
      return; // malformed frame: ignore, keep the socket alive
    }
    const rawLabel = String(o.label ?? o.id ?? "process");
    const label = rawLabel
      .replace(/^task:\s*/i, "")
      .replace(/\s*\([^)]*\)\s*$/, "")
      .trim();
    const id = String(o.id ?? label);
    const key = baseId(id);
    const existing = rows.get(key);
    const incomingStatus = String(o.status ?? existing?.status ?? "pending");
    if (existing) {
      existing.status = incomingStatus;
      if (typeof o.progress === "number") existing.progress = o.progress;
      // Each frame states its own result lines; only idle frames carry the
      // last completed run, so a live frame leaves that as it was.
      if (Array.isArray(o.lines)) existing.lines = o.lines.map(String);
      if (typeof o.last === "string") {
        existing.last = o.last;
        existing.last_at = typeof o.last_at === "string" ? o.last_at : null;
      }
      if (o.detail) {
        existing.detail = String(o.detail);
      } else if (incomingStatus === "running" || incomingStatus === "queued") {
        // Active state carries NO status text. The backend publishes an empty
        // detail on a queued/running frame while the worker has no progress
        // yet; an earlier frame may have left stale text (e.g. a just-skipped
        // "only 4 unsettled turn(s); need >= 5" from the cadence gate) on this
        // coalesced row. Never let that stale detail ride along under an
        // active status — clear it.
        existing.detail = "";
      }
    } else {
      rows.set(key, {
        kind: "process",
        id: key,
        label,
        status: incomingStatus,
        progress: typeof o.progress === "number" ? o.progress : null,
        detail: String(o.detail ?? ""),
        lines: Array.isArray(o.lines) ? o.lines.map(String) : [],
        last: typeof o.last === "string" ? o.last : "",
        last_at: typeof o.last_at === "string" ? o.last_at : null,
      });
    }
    fire();
  });

  es.onerror = (ev: Event) => {
    // EventSource auto-reconnects on a dropped connection. Surface the error
    // (the parent can show a disconnected badge) but keep the socket open.
    opts.onError?.(ev);
  };

  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    es.close();
    rows.clear();
  };
}
