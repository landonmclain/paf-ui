// lib/paf/types.ts
// ---------------------------------------------------------------------------
// Types for the paf SSE transport contract.
//
// The backend serializes turn events + background-task frames as SSE
// `event: <kind>` + `data: <json>` lines:
//
//   event: thinking     data: {"text": "...", "tool_name": null, "args": null}
//   event: text         data: {"text": "...", "tool_name": null, "args": null}
//   event: tool_call    data: {"text": "...", "tool_name": "...", "args": {...}}
//   event: tool_result  data: {"text": "...", "tool_name": "...", "args": {...}}
//   event: tool_running data: {"tool_name": "...", "step_id": "..."}
//   event: tool_error   data: {"step_id": "...", "error": "..."}
//   event: task         data: {"id": "...", "label": "...", "status": "...",
//                              "progress": number|null, "detail": "..."}
//   event: error        data: {"detail": "..."}
//   event: approval_requested data: {"approval_id", "step_id", "tool_name", "args",
//                              "reason", "preview", "created_at", "expires_at", ...}
//   event: approval_resolved  data: {"approval_id", "step_id", "tool_name", "outcome",
//                              "actor", "note"}
//
// Approvals: POST /api/approvals/{approval_id} {decision: "approve"|"deny", note?};
//   GET /api/conversations/{id}/approvals -> {"approvals": [...]} (pending, for a
//   client that re-attaches after the approval_requested frame went out).
//
// REST controls: POST /api/steer {conversation_id, content, priority?} ->
//   {"enqueue_id": "..."}; POST /api/cancel {conversation_id} -> {"cancelled": true}.

/** A text/tool token emitted for the running turn. */
export type TurnFrame =
  | { kind: "thinking"; text: string }
  | { kind: "text"; text: string }
  | { kind: "tool_call"; text: string; toolName: string; args: unknown }
  | { kind: "tool_result"; text: string; toolName: string; args: unknown };

/** Tool progress emitted as a tool starts and when it errors. */
export type ToolFrame =
  | { kind: "tool_running"; stepId: string; toolName: string }
  | { kind: "tool_error"; stepId: string; error: string };

/** Background-process frame (memory consolidation etc.), forwards task status. */
export type ProcessFrame = {
  kind: "process";
  id: string;
  label: string;
  status: string;
  progress: number | null;
  detail: string;
  /** Itemized result, one readable line each (e.g. every fact the memory
   *  reviewer archived) — shown expandable under the row. */
  lines?: string[];
  /** The job's last completed run (detail + ISO finish time), carried on idle
   *  rows so a result stays visible after the row returns to idle. */
  last?: string;
  last_at?: string | null;
};

export type PlanStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "cancelled"
  | "blocked";

export type PlanItem = {
  id: string;
  content: string;
  status: PlanStatus;
  active_form?: string;
  parent_id?: string | null;
  depends_on?: string[];
};

export type ErrorFrame = { kind: "error"; detail: string };

/** How an approval request ended (or that it is still waiting). */
export type ApprovalStatus =
  | "pending"
  | "approved"
  | "denied"
  | "timeout"
  | "cancelled"
  | "unattended";

/** A tool call that is waiting for (or got) the user's decision. `stepId` is the
 *  tool call's step id, so the card sits with the tool row it belongs to. */
export type Approval = {
  approvalId: string;
  stepId: string;
  toolName: string;
  /** The call's arguments as JSON text, secrets already scrubbed server-side. */
  args: string;
  /** Why it needs approval (which rule, or what was flagged). */
  reason: string;
  /** What it would do, worked out without running it (e.g. what rm deletes). */
  preview: Record<string, string> | null;
  /** Epoch seconds. */
  createdAt: number;
  expiresAt: number;
  status: ApprovalStatus;
  actor?: string;
  note?: string;
};

export type ApprovalFrame =
  | ({ kind: "approval_requested" } & Omit<Approval, "status" | "actor" | "note">)
  | {
      kind: "approval_resolved";
      approvalId: string;
      stepId: string;
      toolName: string;
      outcome: Exclude<ApprovalStatus, "pending">;
      actor: string;
      note: string;
    };

/** Full-snapshot plan update. The server pushes the
 *  ENTIRE items array on each mutation, so the panel is a direct mirror of
 *  server truth with zero client merge logic. */
export type PlanFrame = { kind: "plan"; items: PlanItem[] };

/**
 * A recoverable transport/parse glitch (nothing fatal). Logged and skipped so
 * the turn keeps streaming — a malformed payload must never kill the answer.
 */
export type WarnFrame = { kind: "warn"; detail: string };

/** Every frame the client can receive from /api/chat, as a discriminated union. */
/** The question a turn is answering. Sent first on a re-attach (another device, a
 *  refresh), which never saw it: history only gains the user message once the turn
 *  settles. */
export type PromptFrame = {
  kind: "prompt";
  text: string;
  images?: { id: string; name: string; width?: number; height?: number }[];
};

export type PafFrame =
  | TurnFrame
  | PromptFrame
  | ToolFrame
  | ProcessFrame
  | PlanFrame
  | ErrorFrame
  | WarnFrame
  | ApprovalFrame;

/** A single tool execution tracked by step_id (renders as a collapsible row). */
export type ToolRecord = {
  stepId: string;
  toolName: string;
  status: "running" | "done" | "error";
  args?: unknown;
  result?: unknown;
  error?: string;
};

/** A stable entry in the chronological turn log. */
export type TurnLogEntry =
  | { kind: "thinking"; text: string }
  | { kind: "text"; text: string }
  | {
      kind: "tool";
      stepId: string;
      toolName: string;
    } & ToolRecord
  | { kind: "process"; process: ProcessFrame }
  | { kind: "approval"; approval: Approval };

/** One raw SSE event captured verbatim (for the live event/status feed). */
export type RawEvent = {
  /** SSE `event:` name, e.g. thinking, text, tool_call, tool_running, task,
   *  error… plus synthetic `chat.start` / `chat.done` / `chat.error`. */
  event: string;
  /** Raw `data:` payload string, as received (json, not yet parsed). */
  data: string;
  /** Monotonic ms offset from the start of this turn (for elapsed display). */
  at: number;
};

/** One assistant turn, the renderable unit for Message / Reasoning / tool rows. */
export type Turn = {
  conversationId: string;
  userPrompt: string;
  /** Assistant answer tokens (thinking + final text interleaved). */
  parts: Array<{ type: "thinking" | "text"; text: string }>;
  /** Tools in execution order, keyed by step_id. */
  tools: ToolRecord[];
  /** Chronological event log (thinking/text/tool/task), in arrival order. */
  log: TurnLogEntry[];
  /** Background-process updates received while this turn was streaming
   *  (named "process" so plan tasks never collide with background
   *  processes). */
  processes: ProcessFrame[];
  /** The authoritative plan (server truth, via /plan + live `plan` SSE
   *  frames). Empty array when the conversation has no plan. */
  plan: PlanItem[];
  /** Raw SSE events, verbatim, in arrival order (live event/status feed). */
  rawEvents: RawEvent[];
  /** Approval requests in this turn (pending and settled), in arrival order.
   *  Optional: turns restored from history carry none. */
  approvals?: Approval[];
  /** Epoch ms when the turn started streaming (for elapsed display). */
  startedAt: number;
  /** Optional cited sources (from tool results), rendered as Sources. */
  sources?: { href: string; title: string }[];
  /** Set when the lane server-side had an error frame or the stream aborted. */
  error?: string;
  /** Set when the live SSE socket dropped but the turn is still running
   *  server-side (durable turns: disconnect != cancel). Cleared on re-attach. */
  disconnected?: boolean;
  done: boolean;
};

/** Clean success/error from a REST control call. */
export type ControlResult =
  | { ok: true; enqueueId?: string }
  | { ok: false; error: string };

export const PAF_DEFAULT_AGENT = "demo_assistant";
