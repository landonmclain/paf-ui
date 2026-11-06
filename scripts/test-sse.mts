// test-sse.mts
// Node-native type-stripped test of the paf SSE reader + adapter.
// Run: node --experimental-strip-types test-sse.mts
// Mocks global fetch/Response so streamSse() can be exercised with real
// chunk-boundary-split SSE bytes built from an actual /api/chat capture shape.

import { runTurn, freshTurn } from "../lib/paf/adapter.ts";
import type { Turn, TurnLogEntry } from "../lib/paf/types.ts";

// ---- Build a realistic SSE payload from the paf contract -------------------
const frame = (event: string, obj: unknown): string =>
  `event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`;

const payload =
  frame("thinking", { text: "I need a ", tool_name: null, args: null }) +
  frame("thinking", { text: "calculator.", tool_name: null, args: null }) +
  frame("tool_running", { tool_name: "multiply", step_id: "st-1" }) +
  frame("tool_call", { text: "multiply(6,7)", tool_name: "multiply", args: { a: 6, b: 7 } }) +
  frame("tool_result", { text: "42", tool_name: "multiply", args: 42 }) +
  frame("text", { text: "The answer ", tool_name: null, args: null }) +
  frame("text", { text: "is 42.", tool_name: null, args: null }) +
  frame("task", { id: "consolidate", label: "memory_consolidation", status: "running", detail: "bg" }) +
  frame("error", { detail: "nope" });

// Deliberately split bytes across 3 chunks mid-line and mid-frame to exercise
// the chunk-boundary handling (a common SSE bug).
const CHUNK_SPLITS = [0, 37, 3, 11, 258, 5, 4, 402, 8, 9]; // increasing-ish cut points
let splits = [...CHUNK_SPLITS];
const bytes = new TextEncoder().encode(payload);

function* chunkStream(): Generator<Uint8Array> {
  let start = 0;
  let i = 0;
  while (start < bytes.length) {
    const cut = i < splits.length ? splits[i] : bytes.length;
    const end = Math.min(start + cut, bytes.length);
    if (end <= start) {
      yield bytes.slice(start); // rest
      return;
    }
    yield bytes.slice(start, end);
    start = end;
    i += 1;
  }
}

// ---- Fake fetch/Response ----------------------------------------------------
class FakeBodyReader {
  private gen: Generator<Uint8Array>;
  constructor(gen: Generator<Uint8Array>) {
    this.gen = gen;
  }
  async read(): Promise<{ done: boolean; value?: Uint8Array }> {
    const n = this.gen.next();
    if (n.done) return { done: true };
    return { done: false, value: n.value };
  }
}

class FakeBody {
  private gen: Generator<Uint8Array>;
  constructor(gen: Generator<Uint8Array>) {
    this.gen = gen;
  }
  getReader(): FakeBodyReader {
    return new FakeBodyReader(this.gen);
  }
}

class FakeResponse {
  ok = true;
  status = 200;
  body: FakeBody;
  constructor(gen: Generator<Uint8Array>) {
    this.body = new FakeBody(gen);
  }
  async text(): Promise<string> {
    return "";
  }
}

let heardError: Error | undefined;

// Regression: real backend order is tool_call (no step_id) BEFORE tool_running
// (with step_id) — verify a single deduped tool row + correct chronological log.
async function runDedupScenario(): Promise<void> {
  const dedupPayload =
    frame("tool_call", { text: "read_file(x)", tool_name: "read_file", args: { path: "a.py" } }) +
    frame("tool_running", { tool_name: "read_file", step_id: "st-99" }) +
    frame("tool_result", { text: "...", tool_name: "read_file", args: "FILE CONTENT" }) +
    frame("text", { text: "Done.", tool_name: null, args: null });

  const dedupBytes = new TextEncoder().encode(dedupPayload);
  function* dedupChunks(): Generator<Uint8Array> {
    yield dedupBytes;
  }
  (globalThis as Record<string, unknown>).fetch = async () => new FakeResponse(dedupChunks());

  const { turn } = await runTurn("t-dedup", "read a.py");
  const pass = (name: string, cond: boolean, extra?: string): void => {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? `  [${extra}]` : ""}`);
    if (!cond) process.exitCode = 1;
  };

  console.log("--- dedup: tool_call before tool_running (real backend order) ---");
  pass("single tool row (no duplicate)", turn.tools.length === 1, JSON.stringify(turn.tools));
  pass("row stepId = real st-99", turn.tools[0]?.stepId === "st-99", turn.tools[0]?.stepId);
  pass("row status done", turn.tools[0]?.status === "done");
  const toolEntries = turn.log.filter((e) => e.kind === "tool");
  pass("single tool log entry", toolEntries.length === 1, JSON.stringify(toolEntries));
  const ci = turn.log.findIndex((e) => e.kind === "tool");
  pass(
    "chronological: tool BEFORE final text",
    ci < turn.log.findIndex((e) => e.kind === "text"),
  );
  // The running placeholder should have been promoted (no 'call-' id remains).
  pass("no placeholder call- id in log", !turn.log.some((e) => e.kind === "tool" && e.stepId.startsWith("call-")));
}

// Regression: a thinking block that STARTS right after a tool call must become
// its OWN block (separate parts + log entry), NOT merge back into the pre-tool
// thinking part. Before the fix, appendText keyed the merge off the last
// `parts` entry (which has no tool rows), so a post-tool thinking frame matched
// the PRE-tool thinking part and silently merged into an already-streamed,
// already-collapsed block — "the thinking after a tool doesn't render, recovers
// on the next text block." Now the merge keys off the last `log` entry, which
// does record the intervening tool, forcing a fresh block for the post-tool
// region. This matches the real backend stream (f1713cf turn: ...thinking ->
// run_command -> thinking "The repo is clean..." -> text).
async function runPostToolThinkingScenario(): Promise<void> {
  const payload =
    frame("thinking", { text: "Before the tool, ", tool_name: null, args: null }) +
    frame("thinking", { text: "I check the repo.", tool_name: null, args: null }) +
    frame("tool_running", { tool_name: "run_command", step_id: "st-run" }) +
    frame("tool_call", { text: "git status", tool_name: "run_command", args: { cmd: "git status" } }) +
    frame("tool_result", { text: "clean tree", tool_name: "run_command", args: "clean" }) +
    frame("thinking", { text: "The repo is clean", tool_name: null, args: null }) +
    frame("thinking", { text: ", on feature/m2.", tool_name: null, args: null }) +
    frame("text", { text: "Repo is clean — ", tool_name: null, args: null }) +
    frame("text", { text: "no changes.", tool_name: null, args: null });

  const bytes = new TextEncoder().encode(payload);
  function* chunks(): Generator<Uint8Array> {
    yield bytes;
  }
  (globalThis as Record<string, unknown>).fetch = async () => new FakeResponse(chunks());

  const { turn } = await runTurn("t-posttool", "status?");
  const pass = (name: string, cond: boolean, extra?: string): void => {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? `  [${extra}]` : ""}`);
    if (!cond) process.exitCode = 1;
  };

  console.log("--- post-tool thinking becomes its OWN block ---");
  // parts: [pre-tool thinking, post-tool thinking, text] — 3 distinct blocks.
  pass(
    "3 separate parts (pre-thinking | post-thinking | text)",
    turn.parts.length === 3,
    JSON.stringify(turn.parts.map((p) => `${p.type}:${p.text.length}`)),
  );
  pass(
    "post-tool thinking NOT merged into pre-tool thinking",
    turn.parts[1]?.type === "thinking" && turn.parts[1].text.startsWith("The repo is clean"),
    JSON.stringify(turn.parts.map((p) => p.text)),
  );
  pass(
    "pre-tool thinking keeps only its own text",
    turn.parts[0]?.text === "Before the tool, I check the repo.",
    turn.parts[0]?.text,
  );
  // log must also have the post-tool thinking as its own entry, ordered after tool.
  const thEntries = turn.log.filter((e) => e.kind === "thinking");
  pass(
    "log has two separate thinking entries",
    thEntries.length === 2,
    JSON.stringify(thEntries.map((e) => e.text)),
  );
  const toolIdx = turn.log.findIndex((e) => e.kind === "tool");
  pass(
    "post-tool thinking entry sits AFTER the tool in log",
    thEntries[1] === turn.log.find((e) => e.kind === "thinking" && e.text.includes("repo is clean")) &&
      turn.log.findIndex((e) => e === thEntries[1]) > toolIdx,
  );
}


// Regression: a background
// `task` frame landing MID-THOUGHT is now completely ignored by the turn
// adapter (it rides the dedicated /api/processes/stream feed instead). It must
// NOT split the thinking block AND must NOT create a `process` log entry. This
// is the permanent fix for the "The u" / "ser asks…" split by
// `task:Summarizing thread`: the frame never reaches the turn, so it can never
// act as a boundary. Both parts and log keep ONE merged thinking block.
async function runTaskMidThoughtScenario(): Promise<void> {
  const payload =
    frame("thinking", { text: "The u", tool_name: null, args: null }) +
    frame("task", { id: "sum", label: "Summarizing thread", status: "running", detail: "bg" }) +
    frame("thinking", { text: "ser asks: what is", tool_name: null, args: null }) +
    frame("thinking", { text: " the latest version?", tool_name: null, args: null }) +
    frame("text", { text: "Answer here", tool_name: null, args: null });

  const bytes = new TextEncoder().encode(payload);
  function* chunks(): Generator<Uint8Array> {
    yield bytes;
  }
  (globalThis as Record<string, unknown>).fetch = async () => new FakeResponse(chunks());

  const { turn } = await runTurn("t-midthought", "version?");
  const pass = (name: string, cond: boolean, extra?: string): void => {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? `  [${extra}]` : ""}`);
    if (!cond) process.exitCode = 1;
  };

  console.log("--- task mid-thought is ignored (decoupled feed) ---");
  // parts: [ONE thinking block, text] — the task must not create a second part.
  pass(
    "2 parts (one merged thinking | text)",
    turn.parts.length === 2,
    JSON.stringify(turn.parts.map((p) => `${p.type}:${p.text}`)),
  );
  pass(
    "thinking merged across the task (no split)",
    turn.parts[0]?.type === "thinking" &&
      turn.parts[0].text === "The user asks: what is the latest version?",
    turn.parts[0]?.text,
  );
  // log: ONE thinking entry, and NO `process` entry at all (task frames are
  // skipped, not transcribed into the turn log).
  const thEntries = turn.log.filter((e) => e.kind === "thinking");
  pass(
    "log has ONE thinking entry (in sync with parts)",
    thEntries.length === 1,
    JSON.stringify(thEntries.map((e) => e.text)),
  );
  pass(
    "NO process entry in turn log",
    !turn.log.some((e: TurnLogEntry) => e.kind === "process"),
    JSON.stringify(turn.log.map((l) => l.kind)),
  );
  pass(
    "thinking log text fully joined",
    thEntries[0]?.text === "The user asks: what is the latest version?",
    thEntries[0]?.text,
  );
}

// Approval flow (paf P5): a tool call paused for the user. The request frame
// lands after its tool row and becomes an `approval` log entry plus a pending
// record; the resolved frame settles it by REPLACING the object (memoized rows
// must see a new reference). A duplicate request (e.g. also fetched on rejoin)
// is ignored.
async function runApprovalScenario(): Promise<void> {
  const req = {
    approval_id: "ap-1",
    step_id: "st-rm",
    tool_name: "run_command",
    args: JSON.stringify({ command: "rm -rf build/" }),
    reason: "`rm -rf build/`: deletes files",
    preview: { deletes: "build: 12 files, 3.1 MB" },
    created_at: 1000,
    expires_at: 1600,
    conversation_id: "t-appr",
  };
  const payload =
    frame("tool_running", { tool_name: "run_command", step_id: "st-rm" }) +
    frame("tool_call", { text: "rm -rf build/", tool_name: "run_command", args: { command: "rm -rf build/" } }) +
    frame("approval_requested", req) +
    frame("approval_requested", req) + // duplicate: must not double the card
    frame("approval_resolved", {
      approval_id: "ap-1",
      step_id: "st-rm",
      tool_name: "run_command",
      outcome: "denied",
      actor: "web",
      note: "keep build/",
    }) +
    frame("tool_result", { text: "The user denied this call", tool_name: "run_command", args: null }) +
    frame("text", { text: "OK, I left build/ alone.", tool_name: null, args: null });
  const bytes = new TextEncoder().encode(payload);
  function* chunks(): Generator<Uint8Array> {
    // split mid-frame to exercise the reader too
    yield bytes.slice(0, 97);
    yield bytes.slice(97, 400);
    yield bytes.slice(400);
  }
  (globalThis as Record<string, unknown>).fetch = async () => new FakeResponse(chunks());

  const snapshots: Turn[] = [];
  const { turn } = await runTurn("t-appr", "clean up", { onTurn: (t) => snapshots.push(t) });
  const pass = (name: string, cond: boolean, extra?: string): void => {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? `  [${extra}]` : ""}`);
    if (!cond) process.exitCode = 1;
  };
  console.log("--- approvals: request -> resolve on the live stream ---");
  const approvals = turn.approvals ?? [];
  pass("one approval (duplicate ignored)", approvals.length === 1, JSON.stringify(approvals.map((a) => a.approvalId)));
  const a = approvals[0];
  pass("settled as denied, with actor + note", a?.status === "denied" && a.actor === "web" && a.note === "keep build/");
  pass("carries step id, tool, reason, preview", a?.stepId === "st-rm" && a.toolName === "run_command" && a.reason.includes("deletes files") && a.preview?.deletes === "build: 12 files, 3.1 MB");
  pass("expiry kept (epoch seconds)", a?.expiresAt === 1600);
  const kinds = turn.log.map((e) => e.kind);
  pass("log: tool, then approval card, then text", JSON.stringify(kinds) === JSON.stringify(["tool", "approval", "text"]), JSON.stringify(kinds));
  const entry = turn.log.find((e): e is Extract<TurnLogEntry, { kind: "approval" }> => e.kind === "approval");
  pass("log entry holds the SETTLED approval", entry?.approval.status === "denied");
  const pendingSnap = snapshots.find((t) => (t.approvals ?? [])[0]?.status === "pending");
  const settledSnap = snapshots.find((t) => (t.approvals ?? [])[0]?.status === "denied");
  pass("a pending snapshot was rendered before the decision", pendingSnap !== undefined);
  pass(
    "settle replaced the object (new reference for memoized rows)",
    pendingSnap !== undefined && settledSnap !== undefined && (pendingSnap.approvals ?? [])[0] !== (settledSnap.approvals ?? [])[0],
  );
  pass("freshTurn starts with no approvals", (freshTurn("x", "y").approvals ?? []).length === 0);
}

// Re-attach mid-wait: the approval_requested frame went out before we
// subscribed, so the adapter fetches pending approvals over REST and shows them.
async function runRejoinPendingScenario(): Promise<void> {
  const seenUrls: string[] = [];
  const pendingWire = {
    approval_id: "ap-9",
    step_id: "st-w",
    tool_name: "write_file",
    args: JSON.stringify({ path: "notes.txt" }),
    reason: "gating policy",
    preview: null,
    created_at: 1,
    expires_at: 601,
    conversation_id: "t-rejoin",
  };
  // A stream that stays open briefly (the turn is still waiting server-side).
  class SlowReader {
    private sent = false;
    async read(): Promise<{ done: boolean; value?: Uint8Array }> {
      await new Promise((r) => setTimeout(r, 30));
      if (this.sent) return { done: true };
      this.sent = true;
      return {
        done: false,
        value: new TextEncoder().encode(frame("tool_running", { tool_name: "write_file", step_id: "st-w" })),
      };
    }
  }
  (globalThis as Record<string, unknown>).fetch = async (url: string) => {
    seenUrls.push(String(url));
    if (String(url).includes("/approvals")) {
      return { ok: true, status: 200, json: async () => ({ approvals: [pendingWire] }) };
    }
    return { ok: true, status: 200, body: { getReader: () => new SlowReader() }, text: async () => "" };
  };
  const { turn } = await runTurn("t-rejoin", "", {}, { rejoin: true, agent: "demo_assistant" });
  const pass = (name: string, cond: boolean, extra?: string): void => {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? `  [${extra}]` : ""}`);
    if (!cond) process.exitCode = 1;
  };
  console.log("--- approvals: re-attach shows what is already pending ---");
  pass("fetched the pending list for this lane", seenUrls.some((u) => u.includes("/api/conversations/t-rejoin/approvals?agent=demo_assistant")), JSON.stringify(seenUrls));
  const a = (turn.approvals ?? [])[0];
  pass("pending approval shown after re-attach", a?.approvalId === "ap-9" && a.status === "pending");
  pass("as a card in the log", turn.log.some((e) => e.kind === "approval"));
}

async function main(): Promise<void> {
  (globalThis as Record<string, unknown>).fetch = async (_url: string, _init: unknown) =>
    new FakeResponse(chunkStream());

  let live: Turn | null = null;
  let ended: Turn | null = null;
  const result = await runTurn(
    "t1",
    "6*7?",
    {
      onTurn: (t) => {
        live = t;
        if (t.error) heardError = new Error(t.error);
      },
      onEnd: (t) => {
        ended = t;
      },
    },
    { agent: "demo_assistant" },
  );

  const t = result.turn;
  const pass = (name: string, cond: boolean, extra?: string): void => {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? `  [${extra}]` : ""}`);
    if (!cond) process.exitCode = 1;
  };

  console.log("--- userPrompt/done/error ---");
  pass("userPrompt set", t.userPrompt === "6*7?");
  pass("done=true after EOF", t.done === true);
  // NB: test payload intentionally ends with an `error` frame, so turn.error is
  // expected to be set — this asserts error-frame mapping, not a clean turn.
  pass(
    "error frame mapped to turn.error",
    t.error === "nope",
    JSON.stringify({ tErr: t.error }),
  );

  console.log("--- parts (thinking coalesced, text coalesced) ---");
  pass("parts length 2", t.parts.length === 2, JSON.stringify(t.parts.map((p) => p.type)));
  pass(
    "thinking coalesced to single part",
    t.parts[0]?.type === "thinking" && t.parts[0].text === "I need a calculator.",
    t.parts[0]?.text,
  );
  pass(
    "text coalesced to single part",
    t.parts[1]?.type === "text" && t.parts[1].text === "The answer is 42.",
    t.parts[1]?.text,
  );

  console.log("--- tools ---");
  pass("1 tool row", t.tools.length === 1, JSON.stringify(t.tools));
  const tool = t.tools[0]!;
  pass("tool stepId st-1", tool.stepId === "st-1");
  pass("tool status done", tool.status === "done");
  pass("tool result 42", tool.result === 42);
  pass("tool args {a:6,b:7}", JSON.stringify(tool.args) === JSON.stringify({ a: 6, b: 7 }));

  console.log("--- tasks decoupled ---");
  // A `task:` frame on /api/chat is now IGNORED by the turn adapter (background
  // work rides the dedicated /api/processes/stream feed instead). It must NOT
  // populate turn.processes. (The turn still errors here only because the test
  // payload deliberately ends with an error frame.)
  pass(
    "task frame did NOT populate turn.processes",
    t.processes.length === 0,
    JSON.stringify(t.processes),
  );

  console.log("--- error frame mapping ---");
  // error detail came through? NOTE: the task frame precedes error; the adapter
  // sets turn.error on the error frame, and done=true.
  pass(
    "turn.error set from error frame",
    t.error === "nope" || (ended?.error === "nope" && heardError === undefined),
    JSON.stringify({ tErr: t.error, endErr: ended?.error }),
  );

  console.log("--- freshTurn helper ---");
  const f = freshTurn("t2", "hi");
  pass("freshTurn resets state", f.parts.length === 0 && f.tools.length === 0 && !f.done);

  await runDedupScenario();
  await runPostToolThinkingScenario();
  await runTaskMidThoughtScenario();
  await runApprovalScenario();
  await runRejoinPendingScenario();

  console.log("\nDONE" + (process.exitCode ? "  (had failures)" : "  (all pass)"));
}

main().catch((e) => {
  console.error("TEST CRASH", e);
  process.exitCode = 1;
});
