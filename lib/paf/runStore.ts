// lib/paf/runStore.ts
//
// Per-lane live-turn store (multi-lane live conversations).
//
// The core problem this solves: if PafChat owned its running `turn` in local
// React state, switching lanes (or agents) re-mounts the pane with a
// different `conversationId` and discards the in-flight turn's in-memory state
// (the effect clears `transcript` and rebuilds from settled `getHistory()`,
// losing the still-streaming turn). The backend keeps the SSE socket and the
// turn running (desktop JS stays alive), but the visible lane loses it.
//
// This store moves the live `turn` (and its SSE lifecycle) OUT of the component
// into a Zustand store keyed by `${agent}:${conversationId}`. Components become
// *selectors* over their lane's slice; the store owns one canonical `turn` per
// lane that keeps mutating regardless of which lane is currently rendered.
//
// The server turn is disconnect-tolerant, so the store is the client merging
// substrate: it only consumes SSE frames + history.

import { create } from "zustand";
import type { Turn } from "./types";
import { runTurn, rejoinTurn, freshTurn, type AdapterHooks } from "./adapter";

/** Per-lane live-turn state. Owned by the store, NOT by any component. */
export interface LaneRunState {
  /** The live, mutating turn object (single canonical instance per lane). */
  turn: Turn | null;
  running: boolean;
  /** True when the live SSE socket dropped but the turn is still running
   *  server-side (durable re-attach). Cleared once re-attached. */
  disconnected: boolean;
  error: string | null;
  /** Abort handle for the open SSE reader for this lane. */
  abort: (() => void) | null;
}

interface RunStoreState {
  lanes: Record<string, LaneRunState>;
  /** Get-or-create a lane's state keyed by agent:cid (Zustand-idiomatic;
   *  do not call during render — use the selector below instead). */
  lane: (agent: string, cid: string) => LaneRunState;
  /** Get a lane WITHOUT creating it (returns undefined when absent). */
  peekLane: (agent: string, cid: string) => LaneRunState | undefined;
  setTurn: (agent: string, cid: string, turn: Turn | null) => void;
  setRunning: (agent: string, cid: string, running: boolean) => void;
  setDisconnected: (agent: string, cid: string, disconnected: boolean) => void;
  setError: (agent: string, cid: string, error: string | null) => void;
  setAbort: (agent: string, cid: string, abort: (() => void) | null) => void;
  /** Clear a lane's live turn accumulation (steer boundary). */
  resetTurn: (agent: string, cid: string) => void;
  /** Release a lane (turn ended / cancelled / errored). Never called for a
   *  running lane. */
  detachLane: (agent: string, cid: string) => void;
}

/** Canonical per-lane key. Conversations are namespaced by agent server-side,
 *  so the same `conversationId` under a different agent is a distinct lane. */
export const laneKey = (agent: string, cid: string) => `${agent}:${cid}`;

/** Read a lane for a component. Use this in `useRunStore(selector)` so only the
 *  lane that changed re-renders (the reason Zustand over context). */
export const selectLane =
  (agent: string, cid: string) =>
  (s: RunStoreState): LaneRunState | undefined =>
    s.lanes[laneKey(agent, cid)];

const EMPTY: LaneRunState = {
  turn: null,
  running: false,
  disconnected: false,
  error: null,
  abort: null,
};

export const useRunStore = create<RunStoreState>((set, get) => ({
  lanes: {},

  // NOTE: `lane()` creates-on-read, which is mutation during render if called
  // from a selector. It's exposed for imperative call sites (start/cancel
  // handlers). In render paths always use `selectLane` and treat absence as
  // "no live turn" — a lane is only materialized once a turn starts.
  lane: (agent, cid) => {
    const k = laneKey(agent, cid);
    const existing = get().lanes[k];
    if (existing) return existing;
    const fresh: LaneRunState = { ...EMPTY };
    set((s) => ({ lanes: { ...s.lanes, [k]: fresh } }));
    return fresh;
  },

  peekLane: (agent, cid) => get().lanes[laneKey(agent, cid)],

  setTurn: (agent, cid, turn) =>
    set((s) => {
      const k = laneKey(agent, cid);
      const cur = s.lanes[k];
      if (!cur) return s; // lane was detached concurrently — ignore
      const lane: LaneRunState = { ...cur, turn };
      return { lanes: { ...s.lanes, [k]: lane } };
    }),

  setRunning: (agent, cid, running) =>
    set((s) => {
      const k = laneKey(agent, cid);
      const cur = s.lanes[k];
      if (!cur) return s;
      const lane: LaneRunState = { ...cur, running };
      return { lanes: { ...s.lanes, [k]: lane } };
    }),

  setDisconnected: (agent, cid, disconnected) =>
    set((s) => {
      const k = laneKey(agent, cid);
      const cur = s.lanes[k];
      if (!cur) return s;
      const lane: LaneRunState = { ...cur, disconnected };
      return { lanes: { ...s.lanes, [k]: lane } };
    }),

  setError: (agent, cid, error) =>
    set((s) => {
      const k = laneKey(agent, cid);
      const cur = s.lanes[k];
      if (!cur) return s;
      const lane: LaneRunState = { ...cur, error };
      return { lanes: { ...s.lanes, [k]: lane } };
    }),

  setAbort: (agent, cid, abort) =>
    set((s) => {
      const k = laneKey(agent, cid);
      const cur = s.lanes[k];
      if (!cur) return s;
      const lane: LaneRunState = { ...cur, abort };
      return { lanes: { ...s.lanes, [k]: lane } };
    }),

  /** Clear a lane's live turn accumulation (used at a steer boundary so the
   *  redirect builds a fresh answer with no backfill of the original). */
  resetTurn: (agent, cid) =>
    set((s) => {
      const k = laneKey(agent, cid);
      const cur = s.lanes[k];
      if (!cur || !cur.turn) return s;
      // Keep a request still waiting for the user on screen across a steer.
      const pending = (cur.turn.approvals ?? []).filter((a) => a.status === "pending");
      const turn: Turn = {
        ...cur.turn,
        parts: [],
        tools: [],
        log: pending.map((approval) => ({ kind: "approval" as const, approval })),
        processes: [],
        rawEvents: [],
        approvals: pending,
        done: false,
      };
      return { lanes: { ...s.lanes, [k]: { ...cur, turn } } };
    }),

  detachLane: (agent, cid) =>
    set((s) => {
      const k = laneKey(agent, cid);
      const cur = s.lanes[k];
      if (!cur) return s;
      // Safety: never detach a lane that is still running — the whole point of
      // this store is that background/away lanes keep streaming.
      if (cur.running) return s;
      const lanes = { ...s.lanes };
      delete lanes[k];
      return { lanes };
    }),
}));

/**
 * Result of `startRun`. `"started"` means a new turn was launched for this lane;
 * `"already-running"` means the lane already has a live turn (no double-run).
 */
export type StartRunResult = "started" | "already-running";

/**
 * Start (or no-op on) a live turn for an agent+conversation lane, with the
 * turn's lifecycle owned by the store, not by any component.
 *
 * Guards against double-run: if the lane is already running (a turn is
 * streaming), this returns `"already-running"` and does NOT open a second
 * /api/chat — there is exactly one live turn per lane.
 *
 * On start it materializes the lane, sets `running=true`, arms an
 * `AbortController` (exposed as `lane.abort` for cancel/teardown), then drives
 * `runTurn`, writing each `onTurn`/`onEnd` snapshot into the store lane so the
 * canonical turn lives here regardless of which lane is rendered. On completion
 * it clears `running` and `abort`.
 *
 * `hooks` are UI-facing callbacks (`onTurn`/`onEnd`) passed through so a
 * component can also react directly (plan-sidebar updates, etc.).
 */
export async function startRun(
  agent: string,
  cid: string,
  prompt: string,
  hooks: AdapterHooks = {},
  /** Upload ids of images attached to this message. */
  images: string[] = [],
): Promise<StartRunResult> {
  const s = useRunStore.getState();

  if (s.peekLane(agent, cid)?.running) {
    return "already-running";
  }

  // Materialize the lane and mark it running with an initial turn.
  s.lane(agent, cid);
  s.setTurn(agent, cid, freshTurn(cid, prompt));
  s.setError(agent, cid, null);
  s.setRunning(agent, cid, true);

  const controller = new AbortController();
  s.setAbort(agent, cid, () => controller.abort());

  // Coalesce high-frequency onTurn frames into store writes (~100ms), so a
  // background lane streaming tokens doesn't saturate the main thread with a
  // store write (and a subscribed re-render) per frame. This is the multi-lane
  // analogue of the old single-lane flush interval, but owned here so ALL lanes
  // (including hidden ones) throttle the same way. The final onEnd writes the
  // complete turn immediately.
  // The newest snapshot, held in an OBJECT the timer reads when it fires. A
  // plain `let` variable here was inlined by the production minifier into the
  // closure of the onTurn call that scheduled the timer, so the flush wrote
  // THAT (older) snapshot and dropped every frame of the same 100ms window
  // until the next frame. A burst followed by silence (a tool call, then an
  // approval request the turn waits on) stayed stale on screen.
  const latest: { turn?: Turn } = {};
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  const flushToStore = (snapshot: Turn) => {
    s.setTurn(agent, cid, snapshot);
    hooks.onTurn?.(snapshot);
  };
  const scheduleFlush = () => {
    if (flushTimer !== null) return; // already scheduled
    flushTimer = setTimeout(() => {
      flushTimer = null;
      if (latest.turn) flushToStore(latest.turn);
    }, 100);
  };

  let keepAlive = false;
  try {
    await runTurn(
      cid,
      prompt,
      {
        onTurn: (turn) => {
          // Live plan rides `plan` frames; surface immediately (sidebar waits
          // on it), but still throttle the raw turn snapshot.
          if (turn.plan.length > 0) hooks.onPlan?.(turn.plan);
          latest.turn = turn;
          scheduleFlush();
        },
        onEnd: (turn) => {
          if (flushTimer !== null) {
            clearTimeout(flushTimer);
            flushTimer = null;
          }
          flushToStore(turn);
          hooks.onEnd?.(turn);
        },
        onDisconnect: () => {
          // Durable drop: the turn keeps running server-side. Keep the lane
          // alive + flagged disconnected so a visibility re-attach can rejoin.
          keepAlive = true;
          s.setDisconnected(agent, cid, true);
        },
      },
      { agent, signal: controller.signal, images },
    );
  } catch (err) {
    // streamSse rethrows after invoking onError; `runTurn` already marks the
    // turn done+error. Surface it on the lane for the UI.
    // An intentional abort (Stop) is NOT an error — the lane was already
    // settled via onDone, so don't paint "BodyStreamBuffer was aborted".
    if (!controller.signal.aborted) {
      const msg = err instanceof Error ? err.message : String(err);
      s.setError(agent, cid, msg);
    }
  } finally {
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    // A durable drop (keepAlive) keeps the lane running + disconnected so a
    // re-attach can rejoin it; otherwise GC the completed lane.
    if (!keepAlive) {
      s.setRunning(agent, cid, false);
      s.setAbort(agent, cid, null);
      // GC the completed lane. At this point the turn has ended (success, error,
      // or cancel) and `onEnd`/`onError` already handed the final state to
      // subscribers + the component persisted it into its transcript. A completed
      // turn is not rendered from the store (the live branch is gated on
      // `running`), and re-opening a lane lazily re-fetches settled history via
      // getHistory — so retaining it would only let lanes accumulate unbounded.
      // `detachLane` refuses to drop a running lane (should never be the case
      // here), which double-guards against killing a live turn.
      s.detachLane(agent, cid);
    }
  }

  return "started";
}

/**
 * Rejoin an in-flight turn on an agent+conversation lane (refresh/visibility
 * re-attach). Opens a rejoin /api/chat: if a turn is running server-side, its
 * live tail renders into the lane; if none is running, the stream is empty and
 * the lane is released (settled history is authoritative). No-op when the lane
 * is already live. Returns "rejoined" when attached, "idle" when nothing was
 * running, "already-running" when skipped.
 */
export type RejoinResult = "rejoined" | "idle" | "already-running";

export async function rejoinRun(
  agent: string,
  cid: string,
  hooks: AdapterHooks = {},
): Promise<RejoinResult> {
  const s = useRunStore.getState();
  const existing = s.peekLane(agent, cid);
  // A lane whose socket dropped stays `running` (the turn is still going on the
  // server) but `disconnected`: that one MUST be rejoinable, or a backgrounded
  // app can never re-attach. Only a lane with a live socket is "already running".
  if (existing?.running && !existing.disconnected) return "already-running";
  // Kill the dead reader of the dropped stream before replacing it.
  existing?.abort?.();

  // Materialize the lane and open a REJOIN SSE (attach to the in-flight turn if
  // one is running, else empty). A dropped lane keeps its partial turn on screen
  // until the new tail's first frame replaces it, rather than flashing empty.
  s.lane(agent, cid);
  if (!existing?.disconnected) s.setTurn(agent, cid, freshTurn(cid, ""));
  s.setError(agent, cid, null);
  s.setRunning(agent, cid, true);
  s.setDisconnected(agent, cid, false);

  const controller = new AbortController();
  s.setAbort(agent, cid, () => controller.abort());

  // Coalesce live rejoin frames into the store lane (~100ms), mirroring
  // startRun — WITHOUT this onTurn flush the accumulated turn never reaches the
  // lane and the re-attached stream renders nothing (the refresh gap).
  // The newest snapshot, held in an OBJECT the timer reads when it fires. A
  // plain `let` variable here was inlined by the production minifier into the
  // closure of the onTurn call that scheduled the timer, so the flush wrote
  // THAT (older) snapshot and dropped every frame of the same 100ms window
  // until the next frame. A burst followed by silence (a tool call, then an
  // approval request the turn waits on) stayed stale on screen.
  const latest: { turn?: Turn } = {};
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  const flushToStore = (snapshot: Turn) => {
    s.setTurn(agent, cid, snapshot);
    hooks.onTurn?.(snapshot);
  };
  const scheduleFlush = () => {
    if (flushTimer !== null) return; // already scheduled
    flushTimer = setTimeout(() => {
      flushTimer = null;
      if (latest.turn) flushToStore(latest.turn);
    }, 100);
  };

  // Guard onEnd so an empty rejoin (no running turn) doesn't persist a blank
  // assistant turn — settled history is authoritative for that case.
  const guardedHooks: AdapterHooks = {
    ...hooks,
    onTurn: (turn) => {
      latest.turn = turn;
      scheduleFlush();
    },
    onEnd: (turn) => {
      if (flushTimer !== null) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      if (
        turn.done &&
        !turn.error &&
        turn.parts.length === 0 &&
        turn.tools.length === 0
      ) {
        return; // empty rejoin: nothing running, history renders the lane
      }
      flushToStore(turn);
      hooks.onEnd?.(turn);
    },
    onDisconnect: () => {
      s.setDisconnected(agent, cid, true);
    },
  };

  let keepAlive = false;
  try {
    const { turn } = await rejoinTurn(cid, guardedHooks, {
      agent,
      signal: controller.signal,
    });
    if (turn.disconnected && !turn.done) {
      keepAlive = true;
      return "rejoined";
    }
    return turn.done && !turn.error && turn.parts.length === 0 && turn.tools.length === 0
      ? "idle"
      : "rejoined";
  } catch (err) {
    if (!controller.signal.aborted) {
      s.setError(agent, cid, err instanceof Error ? err.message : String(err));
    }
    return "rejoined";
  } finally {
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (!keepAlive) {
      s.setRunning(agent, cid, false);
      s.setAbort(agent, cid, null);
      s.detachLane(agent, cid);
    }
  }
}
