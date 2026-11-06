// lib/paf/config.ts
// ---------------------------------------------------------------------------
// Backend base URL for the paf SSE transport (the paf server, default :8090).
// Override in .env.local with NEXT_PUBLIC_PAF_BASE_URL when the backend runs on
// another host / port (e.g. when the page is loaded from a different device,
// where localhost:8090 would not be the backend):
//
//   NEXT_PUBLIC_PAF_BASE_URL=http://<backend-host>:8090

export const PAF_BASE_URL: string =
  (typeof process !== "undefined" && process.env.NEXT_PUBLIC_PAF_BASE_URL) ||
  "http://localhost:8090";

export const PAF_HEALTH_URL = `${PAF_BASE_URL}/api/health`;
export const PAF_CHAT_URL = `${PAF_BASE_URL}/api/chat`;
export const PAF_STEER_URL = `${PAF_BASE_URL}/api/steer`;
export const PAF_CANCEL_URL = `${PAF_BASE_URL}/api/cancel`;
/** Image uploads: POST raw bytes here; GET `${PAF_UPLOADS_URL}/{id}` serves it. */
export const PAF_UPLOADS_URL = `${PAF_BASE_URL}/api/uploads`;
export const uploadImageUrl = (id: string) =>
  `${PAF_UPLOADS_URL}/${encodeURIComponent(id)}`;

/**
 * Ops transport — a SEPARATE tiny paf service (default :8091) that can restart
 * the SSE server (`POST /api/restart`). It's a separate process so the SSE
 * bounce never takes down the thing that answered the restart request.
 * Authorized by a bearer token set in NEXT_PUBLIC_PAF_OPS_TOKEN. NEXT_PUBLIC_
 * values are inlined into the client bundle, so only use this on a trusted
 * network.
 */
export const PAF_OPS_URL: string =
  (typeof process !== "undefined" && process.env.NEXT_PUBLIC_PAF_OPS_URL) ||
  "http://localhost:8091";
export const PAF_OPS_RESTART_URL = `${PAF_OPS_URL}/api/restart`;
export const PAF_OPS_TOKEN: string =
  (typeof process !== "undefined" &&
    process.env.NEXT_PUBLIC_PAF_OPS_TOKEN) ||
  "";
/** GET/POST /api/conversations — list lanes / create a new conversation. */
export const PAF_CONVERSATIONS_URL = `${PAF_BASE_URL}/api/conversations`;

/**
 * The active agent (profile) the UI drives. This is the single source of truth
 * for which agent's lanes the sidebar lists and which profile new/messaged
 * conversations belong to — the backend namespaces every lane by
 * `{agent}:{conversation_id}`, and each list/create/history call is scoped to
 * this agent.
 */
export const PAF_AGENT: string =
  (typeof process !== "undefined" &&
    process.env.NEXT_PUBLIC_PAF_AGENT) ||
  "demo_assistant";

/**
 * The selectable agents (profiles) the UI can drive, in display order. Each
 * name maps to a backend agent spec. The backend namespaces every lane by
 * `{agent}:{conversation_id}`, so switching the selected agent re-scopes the
 * whole UI (chat, sidebar lanes, processes, plan) to that agent's lanes. A
 * single SSE server serves all agents — the selector just changes which agent
 * id the UI sends on each request.
 */
export const PAF_AGENTS: string[] = ["demo_assistant", "assistant", "secure_assistant"];

/** GET /api/conversations/{id}/history — prior turns for the UI on resume. */
export const conversationHistoryUrl = (conversationId: string) =>
  `${PAF_BASE_URL}/api/conversations/${encodeURIComponent(conversationId)}/history`;
/** GET /api/conversations/{id}/plan — authoritative plan snapshot (source of
 *  truth via the server's FilePlanStore). Loaded on conversation switch /
 *  turn-settle / page refresh. */
/** POST {decision: "approve"|"deny", note?} decides one pending tool call. */
export const approvalUrl = (approvalId: string) =>
  `${PAF_BASE_URL}/api/approvals/${encodeURIComponent(approvalId)}`;
/** GET pending approval requests for a conversation's running turn. */
export const conversationApprovalsUrl = (conversationId: string) =>
  `${PAF_BASE_URL}/api/conversations/${encodeURIComponent(conversationId)}/approvals`;
export const conversationPlanUrl = (conversationId: string) =>
  `${PAF_BASE_URL}/api/conversations/${encodeURIComponent(conversationId)}/plan`;
/** GET /api/processes/stream — dedicated turn-independent background-process
 *  feed. Lane-aware: `lane=agent` streams the shared per-agent lane (memory
 *  consolidation + review, no conversation_id); `lane=conversation` streams one
 *  conversation's lane (thread summarizer, conversation_id required). Opens
 *  once per lane; Process frames never ride the turn's /api/chat stream. */
export const PAF_PROCESSES_URL = (params: {
  agent: string;
  lane: "agent" | "conversation";
  conversation_id?: string;
}) => {
  const q = new URLSearchParams();
  q.set("agent", params.agent);
  q.set("lane", params.lane);
  if (params.conversation_id) q.set("conversation_id", params.conversation_id);
  return `${PAF_BASE_URL}/api/processes/stream?${q.toString()}`;
};
/** GET/POST /api/projects — the user's project registry (global, not per-agent). */
export const PAF_PROJECTS_URL = `${PAF_BASE_URL}/api/projects`;
/** PATCH /api/projects/{slug} — edit or (un)archive a project. */
export const projectUrl = (slug: string) =>
  `${PAF_PROJECTS_URL}/${encodeURIComponent(slug)}`;
/** PATCH /api/conversations/{id} — rename / assign project / hide a conversation. */
export const conversationRenameUrl = (conversationId: string) =>
  `${PAF_BASE_URL}/api/conversations/${encodeURIComponent(conversationId)}`;
