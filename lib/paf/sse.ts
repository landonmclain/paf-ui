// lib/paf/sse.ts
// ---------------------------------------------------------------------------
// Minimal SSE reader over a `fetch` streaming POST response.
//
// We deliberately do NOT use the browser `EventSource`: it is GET-only and
// cannot carry a JSON body, whereas paf's /api/chat takes {conversation_id,
// prompt, agent} in the POST body. So we read the response.body as a stream
// and parse SSE `event:` / `data:` frames ourselves.
//
// An SSE frame in the response looks like:
//
//   event: thinking
//   data: {"text": "...", "tool_name": null, "args": null}
//
// Two newlines terminate a frame. `data:` may span multiple lines (concatenated
// with "\n"). Comments (`: ...`) and retry/id lines are ignored. Frames arrive
// split arbitrarily across chunk boundaries, so we accumulate into a line
// buffer.

export type SseCallbacks = {
  onFrame: (event: string, data: string) => void;
  /** Fired once the response body is fully consumed (normal EOF or transport error). */
  onDone?: (error?: Error) => void;
  onError?: (error: Error) => void;
};

/**
 * POST `body` to `url` and stream-parse the SSE response, invoking callbacks per
 * frame. Resolves when the response body is fully read. Throws synchronously
 * only on non-2xx responses (after erroring first so the caller can surface it).
 */
export async function streamSse(
  url: string,
  body: unknown,
  { onFrame, onDone, onError }: SseCallbacks,
  init: RequestInit = {},
): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
    body: JSON.stringify(body),
    ...init,
  });

  if (!res.ok || !res.body) {
    const err = new Error(`paf /api/chat HTTP ${res.status}: ${await safeText(res)}`);
    onError?.(err);
    throw err;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  // Two independent buffers (the original code over-loaded `buffer` for both
  // roles, which silently dropped a final SSE frame whose blank-line
  // terminator arrived at/after EOF — the "final answer never renders live")
  // role A: line-tail pending across chunks (from handleChunk's return)
  let pending = "";
  // role B: accumulated data of the CURRENT frame (flushed on blank line)
  let frameData = "";
  let event = "message"; // default per SSE spec

  /** Emit the current frame (if it has data) and reset the accumulator. */
  const flushFrame = (): void => {
    if (frameData.length > 0) {
      onFrame(event, frameData);
      frameData = "";
    }
    event = "message";
  };

  const handleLine = (line: string): void => {
    if (line === "") {
      // blank line = end of frame; flush the pending frame's data
      flushFrame();
      return;
    }
    if (line.startsWith(":")) return; // comment / keep-alive
    const idx = line.indexOf(":");
    const field = idx === -1 ? line : line.slice(0, idx);
    const value = idx === -1 ? "" : line.slice(idx + 1);
    // SSE strips exactly one leading space from the value
    const val = value.startsWith(" ") ? value.slice(1) : value;
    if (field === "event") event = val;
    else if (field === "data")
      frameData = frameData ? `${frameData}\n${val}` : val; // multi-line data concat "\n"
    // "id"/"retry" unused here
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // feed the chunk -> handleChunk routes complete lines to handleLine and
      // returns the unterminated line-tail to carry into the next chunk.
      pending = handleChunk(decoder.decode(value, { stream: true }), handleLine, pending);
    }
    // Decoder tail + any final unterminated line, and a possibly-unflushed
    // frame whose blank-line terminator landed at/after EOF.
    pending = handleChunk(decoder.decode(), handleLine, pending);
    if (pending) {
      // A final frame's "data:" line arrived but had no trailing newline AND
      // no blank-line terminator before EOF. Treat the remainder as one last
      // line so its event/data is accumulated, then flush it.
      handleLine(pending);
      pending = "";
    }
    flushFrame(); // emit a final frame whose terminator was cut by EOF
    onDone?.();
  } catch (err) {
    // An intentional abort (Stop button / lane teardown) is NOT a stream
    // error: the user asked to stop, so settle cleanly as done and don't
    // surface it. The abort surfaces as a thrown error here ("BodyStreamBuffer
    // was aborted") but the authoritative signal is that the AbortController
    // was actually fired — check that FIRST, since the thrown error's name
    // isn't reliably "AbortError" across fetch implementations.
    if (init.signal?.aborted) {
      onDone?.();
      return;
    }
    const e = err instanceof Error ? err : new Error(String(err));
    if (e.name === "AbortError") {
      // fetch-level abort (request phase) — same intentional-stop semantics.
      onDone?.();
      return;
    }
    onError?.(e);
    onDone?.(e);
  }
}

/**
 * Process a text chunk, splitting on "\n" and routing complete lines to
 * `handleLine`. Returns the leftover partial-line buffer to keep for the next
 * chunk.
 */
function handleChunk(
  text: string,
  handleLine: (line: string) => void,
  pending: string,
): string {
  let remaining = pending + text;
  let nl = remaining.indexOf("\n");
  while (nl !== -1) {
    handleLine(remaining.slice(0, nl));
    remaining = remaining.slice(nl + 1);
    nl = remaining.indexOf("\n");
  }
  return remaining; // keep the unterminated tail for the next chunk
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return "";
  }
}
