// lib/paf/api.ts
// ---------------------------------------------------------------------------
// REST controls + liveness for the paf SSE transport.

import { approvalUrl, conversationApprovalsUrl, PAF_CANCEL_URL, PAF_CONVERSATIONS_URL, PAF_HEALTH_URL, PAF_PROJECTS_URL, PAF_STEER_URL, PAF_UPLOADS_URL, conversationHistoryUrl, conversationPlanUrl, conversationRenameUrl, projectUrl } from "./config";
import type { Approval, ControlResult, PlanItem } from "./types";

export type Conversation = {
  conversation_id: string;
  /** Which agent/profile this lane belongs to — backend namespaces every lane
   *  by `{agent}:{conversation_id}`. Kept non-optional so a lane is never
   *  de-namespaced in the UI (two agents may share conversation_ids). */
  agent: string;
  title: string | null;
  /** Epoch seconds of last activity. */
  updated_at: number | null;
  /** Assigned project slug, or null (unassigned). */
  project: string | null;
  /** Hidden from the default sidebar view (nothing is deleted). */
  hidden: boolean;
  /** A turn is in flight on the server right now (started from ANY device). */
  running?: boolean;
};

/** A registered project. `slug` is permanent; `name`/`description` can change. */
export type Project = {
  slug: string;
  name: string;
  description: string;
  archived: boolean;
  created_at: string;
};

/** GET /api/conversations — the given agent's lanes, newest first, or `null` on
 *  any failure. The backend scopes by the requested agent, so lanes from
 *  different profiles never mix here.
 *  Never throws. Use this (not `listConversations`) when an empty result must be
 *  told apart from a failed request — e.g. a background refresh, which must not
 *  blank the sidebar when the network blips. */
export async function fetchConversations(
  agent: string,
): Promise<Conversation[] | null> {
  try {
    const res = await fetch(
      `${PAF_CONVERSATIONS_URL}${
        agent ? `?agent=${encodeURIComponent(agent)}` : ""
      }`,
      { cache: "no-store" },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { conversations?: Conversation[] };
    return data.conversations ?? [];
  } catch {
    return null;
  }
}

/** Like `fetchConversations`, but a failure reads as an empty list. */
export async function listConversations(
  agent: string,
): Promise<Conversation[]> {
  return (await fetchConversations(agent)) ?? [];
}

/** POST /api/conversations — mint a fresh lane id for "New conversation",
 *  scoped to the given agent and, optionally, assigned to a project. */
export async function createConversation(
  agent: string,
  project?: string | null,
): Promise<string | null> {
  try {
    const q = new URLSearchParams();
    if (agent) q.set("agent", agent);
    if (project) q.set("project", project);
    const qs = q.toString();
    const res = await fetch(`${PAF_CONVERSATIONS_URL}${qs ? `?${qs}` : ""}`, {
      method: "POST",
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { conversation_id?: string };
    return data.conversation_id ?? null;
  } catch {
    return null;
  }
}

/** Fields a PATCH /api/conversations/{id} can change; absent keys are left alone. */
export type ConversationPatch = {
  /** Non-empty sets the title; "" clears it back to the derived one. */
  title?: string;
  /** Project slug to assign, or null to unassign. */
  project?: string | null;
  hidden?: boolean;
};

/** PATCH /api/conversations/{id} — update a conversation's title / project /
 *  hidden flag, durably, scoped to the given agent. Returns the saved fields,
 *  or null on failure. Never throws. */
export async function updateConversation(
  conversationId: string,
  patch: ConversationPatch,
  agent: string,
): Promise<Pick<Conversation, "title" | "project" | "hidden"> | null> {
  try {
    const res = await fetch(
      `${conversationRenameUrl(conversationId)}${
        agent ? `?agent=${encodeURIComponent(agent)}` : ""
      }`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      title?: string | null;
      project?: string | null;
      hidden?: boolean;
    };
    return {
      title: data.title ?? null,
      project: data.project ?? null,
      hidden: data.hidden ?? false,
    };
  } catch {
    return null;
  }
}

/** Set (or clear, with empty string) a conversation's user-facing title.
 *  Returns the new title on success, null on a clear or failure. Never throws. */
export async function renameConversation(
  conversationId: string,
  title: string,
  agent: string,
): Promise<string | null> {
  const saved = await updateConversation(conversationId, { title }, agent);
  return saved?.title ?? null;
}

/** GET /api/projects — registered (non-archived) projects. Never throws. */
export async function listProjects(): Promise<Project[]> {
  try {
    const res = await fetch(PAF_PROJECTS_URL, { cache: "no-store" });
    if (!res.ok) return [];
    const data = (await res.json()) as { projects?: Project[] };
    return data.projects ?? [];
  } catch {
    return [];
  }
}

/** POST /api/projects — register a project. Returns it, or an error message
 *  (e.g. a name that collides with an existing slug). Never throws. */
export async function createProject(
  name: string,
  description: string,
): Promise<{ ok: true; project: Project } | { ok: false; error: string }> {
  try {
    const res = await fetch(PAF_PROJECTS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, description }),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { detail?: string };
      return { ok: false, error: data.detail ?? `HTTP ${res.status}` };
    }
    return { ok: true, project: (await res.json()) as Project };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** PATCH /api/projects/{slug} — edit name/description or (un)archive.
 *  Returns the updated project, or null on failure. Never throws. */
export async function updateProject(
  slug: string,
  patch: Partial<Pick<Project, "name" | "description" | "archived">>,
): Promise<Project | null> {
  try {
    const res = await fetch(projectUrl(slug), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) return null;
    return (await res.json()) as Project;
  } catch {
    return null;
  }
}

/**
 * Inject a message into a running conversation (Session.enqueue). Returns the
 * enqueue id on success, or a structured error.
 */
export async function steer(
  conversationId: string,
  content: string,
  opts: { agent?: string; priority?: string } = {},
): Promise<ControlResult> {
  try {
    const res = await fetch(PAF_STEER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversation_id: conversationId,
        ...(opts.agent ? { agent: opts.agent } : {}),
        content,
        ...(opts.priority ? { priority: opts.priority } : {}),
      }),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = (await res.json()) as { enqueue_id?: string };
    return { ok: true, enqueueId: data.enqueue_id };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Stop the running turn on a conversation (Session.cancel), scoped to the
 *  given agent so the lane resolves in the namespace it lives under. */
export async function cancel(
  conversationId: string,
  agent?: string,
): Promise<ControlResult> {
  try {
    const res = await fetch(PAF_CANCEL_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversation_id: conversationId,
        ...(agent ? { agent } : {}),
      }),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Approve or deny a pending tool call. A 404 means it is no longer pending
 *  (another client decided it, it timed out, or the turn stopped). */
export async function decideApproval(
  approvalId: string,
  decision: "approve" | "deny",
  note?: string,
): Promise<ControlResult> {
  try {
    const res = await fetch(approvalUrl(approvalId), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision, ...(note ? { note } : {}) }),
    });
    if (res.status === 404 || res.status === 409) {
      return { ok: false, error: "Already decided, expired, or the turn stopped." };
    }
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Approval requests the conversation's running turn is waiting on. Used when
 *  re-attaching mid-turn (the request frame went out before we subscribed).
 *  Never throws; a failure reads as none pending. */
export async function getPendingApprovals(
  conversationId: string,
  agent?: string,
): Promise<Approval[]> {
  try {
    const res = await fetch(
      `${conversationApprovalsUrl(conversationId)}${
        agent ? `?agent=${encodeURIComponent(agent)}` : ""
      }`,
      { cache: "no-store" },
    );
    if (!res.ok) return [];
    const data = (await res.json()) as { approvals?: Record<string, unknown>[] };
    return (data.approvals ?? []).map(approvalFromWire);
  } catch {
    return [];
  }
}

/** The server's snake_case approval payload -> an `Approval` (pending). */
export function approvalFromWire(o: Record<string, unknown>): Approval {
  const preview =
    o.preview && typeof o.preview === "object"
      ? Object.fromEntries(
          Object.entries(o.preview as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
        )
      : null;
  return {
    approvalId: String(o.approval_id ?? ""),
    stepId: String(o.step_id ?? ""),
    toolName: String(o.tool_name ?? "tool"),
    args: typeof o.args === "string" ? o.args : JSON.stringify(o.args ?? {}),
    reason: String(o.reason ?? ""),
    preview,
    createdAt: Number(o.created_at ?? 0),
    expiresAt: Number(o.expires_at ?? 0),
    status: "pending",
  };
}

/**
 * Liveness probe for the backend (boot check / status pill).
 * `false` means unreachable; does not throw.
 */
export async function checkHealth(): Promise<boolean> {
  try {
    const res = await fetch(PAF_HEALTH_URL, { cache: "no-store" });
    return res.ok;
  } catch {
    return false;
  }
}

/** A prior turn as returned by the history endpoint. User turns carry the raw
 *  prompt text; assistant turns carry a structured `log` (thinking / tool /
 *  text entries, mirroring the live turn's TurnLogEntry) so the restored
 *  timeline renders thinking blocks and tool rows, not just the final answer. */
/** An image attached to a user message (an upload id plus display info). */
export type ChatImage = {
  id: string;
  name: string;
  width?: number;
  height?: number;
};

export type HistoryMessage =
  | { role: "user"; text: string; images?: ChatImage[] }
  | {
      role: "assistant";
      log: Array<
        | { kind: "thinking"; text: string }
        | { kind: "text"; text: string }
        | {
            kind: "tool";
            stepId: string;
            toolName: string;
            args?: unknown;
            result?: unknown;
            error?: string;
            status: string;
          }
      >;
    };

/**
 * Fetch the prior turns for a conversation (GET /api/conversations/{id}/history)
 * so the UI can restore the transcript on resume. Backend scopes by
 * {profile}:{conversation_id} with the DEFAULT_AGENT profile unless given an
 * explicit agent. Never throws — returns [] on any failure.
 */
export async function getHistory(
  conversationId: string,
  agent?: string,
): Promise<HistoryMessage[]> {
  try {
    const url = `${conversationHistoryUrl(conversationId)}${
      agent ? `?agent=${encodeURIComponent(agent)}` : ""
    }`;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return [];
    const data = (await res.json()) as { messages?: HistoryMessage[] };
    return data.messages ?? [];
  } catch {
    return [];
  }
}

/**
 * Fetch the authoritative plan for a conversation (GET /api/conversations/{id}/plan).
 * Reads the server's FilePlanStore — the single source of truth — so the
 * sidebar reflects durable state (multi-turn persistence, reload/restart)
 * with real ids/statuses. Loaded on conversation switch, turn-settle and page
 * refresh; live mid-turn ticks ride the `plan` SSE frames instead.
 * Never throws — returns [] on any failure.
 */
export async function getPlan(
  conversationId: string,
  agent?: string,
): Promise<PlanItem[]> {
  try {
    const url = `${conversationPlanUrl(conversationId)}${
      agent ? `?agent=${encodeURIComponent(agent)}` : ""
    }`;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return [];
    const data = (await res.json()) as { items?: PlanItem[] };
    return data.items ?? [];
  } catch {
    return [];
  }
}

/** An uploaded image's record (POST /api/uploads, GET .../meta). `status` is
 *  the vision-model description: describing → ready | error, or none when the
 *  agent has no vision model. */
export type UploadInfo = ChatImage & {
  width: number;
  height: number;
  media_type: string;
  status: "describing" | "ready" | "error" | "none";
  description: string | null;
  error: string | null;
};

/** Upload an image (raw bytes) for `agent`; the backend saves it and starts
 *  describing it. Throws with the server's message on rejection. */
export async function uploadImage(
  file: Blob,
  name: string,
  agent: string,
): Promise<UploadInfo> {
  const q = new URLSearchParams({ agent, name });
  const res = await fetch(`${PAF_UPLOADS_URL}?${q}`, {
    method: "POST",
    headers: { "Content-Type": file.type || "application/octet-stream" },
    body: file,
  });
  if (!res.ok) {
    let detail = `upload failed (${res.status})`;
    try {
      const body = (await res.json()) as { detail?: string };
      if (body.detail) detail = body.detail;
    } catch {
      /* keep the status-only message */
    }
    throw new Error(detail);
  }
  return (await res.json()) as UploadInfo;
}

/** Current record for an upload (to follow its description status). */
export async function getUpload(
  id: string,
  agent: string,
): Promise<UploadInfo | null> {
  try {
    const res = await fetch(
      `${PAF_UPLOADS_URL}/${encodeURIComponent(id)}/meta?agent=${encodeURIComponent(agent)}`,
      { cache: "no-store" },
    );
    return res.ok ? ((await res.json()) as UploadInfo) : null;
  } catch {
    return null;
  }
}
