// mock-paf.mts
// A tiny scripted stand-in for the paf backend, so the UI can be explored and
// screenshotted without paf. All data is fake. It implements only what the UI
// calls: lanes, projects, history, plan, the chat SSE stream (with a tool-call
// approval), and the background-process feed.
//
// Run: npm run mock   (listens on :8090, the UI's default backend URL)
//      PORT=9000 npm run mock

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

const PORT = Number(process.env.PORT ?? 8090);
/** Pause between streamed frames, in ms. MOCK_SPEED=0.5 halves the delays. */
const SPEED = Number(process.env.MOCK_SPEED ?? 1);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms * SPEED));
const now = () => Math.floor(Date.now() / 1000);

// ---- Fake data -------------------------------------------------------------
const projects = [
  { slug: "release-notes", name: "Release notes", description: "Weekly changelog drafts", archived: false, created_at: "2026-09-01T09:00:00Z" },
  { slug: "site-cleanup", name: "Site cleanup", description: "Tidying build output", archived: false, created_at: "2026-09-03T09:00:00Z" },
];

type Lane = { conversation_id: string; title: string; updated_at: number; project: string | null; hidden: boolean; running: boolean };
const lanes: Lane[] = [
  { conversation_id: "demo-1", title: "Summarize this week's changes", updated_at: now() - 600, project: "release-notes", hidden: false, running: false },
  { conversation_id: "demo-2", title: "Clean up old build output", updated_at: now() - 3600, project: "site-cleanup", hidden: false, running: false },
  { conversation_id: "demo-3", title: "Draft a changelog entry", updated_at: now() - 86400, project: "release-notes", hidden: false, running: false },
  { conversation_id: "demo-4", title: "Explain the retry logic", updated_at: now() - 172800, project: null, hidden: false, running: false },
];

const history: Record<string, unknown[]> = {
  "demo-1": [
    { role: "user", text: "Summarize this week's changes." },
    {
      role: "assistant",
      log: [
        { kind: "thinking", text: "I should list the recent commits, then group them by area." },
        { kind: "tool", stepId: "h-1", toolName: "list_commits", args: { since: "7 days" }, result: "12 commits across 4 areas", status: "done" },
        { kind: "text", text: "This week had **12 commits** across four areas:\n\n- **Chat**: live streaming and approval cards\n- **Sidebar**: conversation list updates across devices\n- **PWA**: installable app shell and push notifications\n- **Fixes**: mobile scrolling and menu visibility" },
      ],
    },
  ],
};

type PlanItem = { id: string; content: string; status: string; active_form?: string };
const plans: Record<string, PlanItem[]> = {};

const pendingApprovals = new Map<string, (decision: "approve" | "deny") => void>();

// ---- HTTP helpers ----------------------------------------------------------
function cors(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
}

function json(res: ServerResponse, body: unknown, status = 200): void {
  cors(res);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString() || "{}");
  } catch {
    return {};
  }
}

const sse = (res: ServerResponse, event: string, data: unknown) =>
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

function sseHeaders(res: ServerResponse): void {
  cors(res);
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
}

/** Stream `text` as small word-sized chunks. */
async function streamWords(res: ServerResponse, event: "text" | "thinking", text: string, delay = 35) {
  for (const w of text.match(/\S+\s*/g) ?? []) {
    sse(res, event, { text: w, tool_name: null, args: null });
    await sleep(delay);
  }
}

// ---- The scripted turn -----------------------------------------------------
async function chat(res: ServerResponse, cid: string, prompt: string): Promise<void> {
  sseHeaders(res);
  const lane = lanes.find((l) => l.conversation_id === cid);
  if (lane) {
    lane.running = true;
    lane.updated_at = now();
    if (lane.title === "New conversation") lane.title = prompt.slice(0, 48);
  }

  sse(res, "prompt", { text: prompt });
  await streamWords(res, "thinking", "The build folder looks stale. I'll check what's in it before removing anything.", 30);

  // 1) A read-only tool runs straight through.
  sse(res, "tool_call", { text: "list_files", tool_name: "list_files", args: { path: "build/" } });
  sse(res, "tool_running", { tool_name: "list_files", step_id: "st-1" });
  await sleep(700);
  sse(res, "tool_result", { text: "14 files, 2.3 MB (oldest: 41 days)", tool_name: "list_files", args: null });

  plans[cid] = [
    { id: "1", content: "Inspect the build folder", status: "completed" },
    { id: "2", content: "Delete stale build output", status: "in_progress", active_form: "Deleting stale build output" },
    { id: "3", content: "Report what was removed", status: "pending" },
  ];
  sse(res, "plan", { items: plans[cid] });
  await sleep(500);

  // 2) A destructive tool waits for the user's decision.
  sse(res, "tool_call", { text: "delete_files", tool_name: "delete_files", args: { path: "build/", recursive: true } });
  sse(res, "tool_running", { tool_name: "delete_files", step_id: "st-2" });
  const approvalId = `ap-${Date.now()}`;
  sse(res, "approval_requested", {
    approval_id: approvalId,
    step_id: "st-2",
    tool_name: "delete_files",
    args: JSON.stringify({ path: "build/", recursive: true }),
    reason: "Deleting files is destructive and needs your approval.",
    preview: { "Would delete": "build/ (14 files, 2.3 MB)", Recoverable: "No" },
    created_at: now(),
    expires_at: now() + 300,
  });

  const decision = await new Promise<"approve" | "deny">((resolve) => {
    pendingApprovals.set(approvalId, resolve);
    res.on("close", () => resolve("deny"));
  });
  pendingApprovals.delete(approvalId);

  const approved = decision === "approve";
  sse(res, "approval_resolved", {
    approval_id: approvalId,
    step_id: "st-2",
    tool_name: "delete_files",
    outcome: approved ? "approved" : "denied",
    actor: "you",
    note: "",
  });

  if (approved) {
    await sleep(600);
    sse(res, "tool_result", { text: "Deleted 14 files (2.3 MB)", tool_name: "delete_files", args: null });
    plans[cid] = plans[cid].map((p) => (p.id === "2" ? { ...p, status: "completed" } : p.id === "3" ? { ...p, status: "in_progress", active_form: "Reporting" } : p));
    sse(res, "plan", { items: plans[cid] });
    await streamWords(res, "text", "Done. I removed the stale `build/` folder: **14 files, 2.3 MB**. The next build will recreate it from scratch.");
  } else {
    sse(res, "tool_error", { step_id: "st-2", error: "Denied by user" });
    await streamWords(res, "text", "Understood, I left `build/` alone. Let me know if you'd like me to archive it instead.");
  }
  plans[cid] = plans[cid].map((p) => ({ ...p, status: p.status === "pending" || p.status === "in_progress" ? "completed" : p.status }));
  sse(res, "plan", { items: plans[cid] });

  if (lane) lane.running = false;
  res.end();
}

// ---- Background-process feed ----------------------------------------------
async function processes(res: ServerResponse, lane: string, cid: string): Promise<void> {
  sseHeaders(res);
  const id = lane === "agent" ? "consolidation.demo" : `thread_summarize.${cid}`;
  const label = lane === "agent" ? "Memory consolidation" : "Thread summary";
  sse(res, "task", { id, label, status: "idle", progress: null, detail: "", last: "Merged 3 notes, archived 2", last_at: new Date().toISOString() });
  await sleep(4000);
  sse(res, "task", { id: `${id}.1`, label, status: "running", progress: 0.4, detail: "" });
  await sleep(3000);
  sse(res, "task", { id: `${id}.1`, label, status: "done", progress: 1, detail: "Merged 3 notes, archived 2", lines: ["Merged: 'retry policy' + 'backoff notes'", "Archived: 'old TODO list'", "Archived: 'draft agenda'"] });
  const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 15000);
  res.on("close", () => clearInterval(keepAlive));
}

// ---- Router ---------------------------------------------------------------
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const path = url.pathname;
  if (req.method === "OPTIONS") {
    cors(res);
    res.writeHead(204).end();
    return;
  }

  try {
    if (path === "/api/health") return json(res, { ok: true });

    if (path === "/api/projects" && req.method === "GET") return json(res, { projects });

    if (path === "/api/conversations") {
      if (req.method === "POST") {
        const id = `demo-${Date.now()}`;
        lanes.unshift({ conversation_id: id, title: "New conversation", updated_at: now(), project: url.searchParams.get("project"), hidden: false, running: false });
        return json(res, { conversation_id: id });
      }
      const agent = url.searchParams.get("agent") ?? "demo_assistant";
      return json(res, { conversations: lanes.filter((l) => !l.hidden).map((l) => ({ ...l, agent })) });
    }

    const conv = path.match(/^\/api\/conversations\/([^/]+)(?:\/(history|plan|approvals))?$/);
    if (conv) {
      const [, cid, sub] = conv;
      if (sub === "history") return json(res, { messages: history[cid] ?? [] });
      if (sub === "plan") return json(res, { items: plans[cid] ?? [] });
      if (sub === "approvals") return json(res, { approvals: [] });
      if (req.method === "PATCH") {
        const patch = await readBody(req);
        const lane = lanes.find((l) => l.conversation_id === cid);
        if (lane) Object.assign(lane, patch);
        return json(res, { title: lane?.title ?? null, project: lane?.project ?? null, hidden: lane?.hidden ?? false });
      }
    }

    if (path === "/api/chat" && req.method === "POST") {
      const b = await readBody(req);
      const cid = String(b.conversation_id ?? "demo-1");
      if (b.rejoin) {
        sseHeaders(res);
        res.end();
        return;
      }
      return chat(res, cid, String(b.prompt ?? ""));
    }

    const approval = path.match(/^\/api\/approvals\/([^/]+)$/);
    if (approval && req.method === "POST") {
      const resolve = pendingApprovals.get(approval[1]);
      if (!resolve) return json(res, { detail: "not pending" }, 404);
      resolve((await readBody(req)).decision === "approve" ? "approve" : "deny");
      return json(res, { ok: true });
    }

    if (path === "/api/cancel") return json(res, { cancelled: true });
    if (path === "/api/steer") return json(res, { enqueue_id: "mock" });
    if (path === "/api/processes/stream") {
      return processes(res, url.searchParams.get("lane") ?? "agent", url.searchParams.get("conversation_id") ?? "demo-1");
    }

    json(res, { detail: "not implemented in the mock" }, 404);
  } catch (err) {
    json(res, { detail: String(err) }, 500);
  }
});

server.listen(PORT, () => {
  console.log(`mock paf backend on http://localhost:${PORT} (all data is fake)`);
});
