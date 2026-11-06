"use client";

// Restart SSE server button — posts to the paf ops transport, which restarts
// the SSE server. The ops service is a SEPARATE
// process so the SSE bounce doesn't take down the restart itself. Shows a
// transient status (Restarting / Done / Error). Wired with the bearer token
// from NEXT_PUBLIC_PAF_OPS_TOKEN.

import { useRef, useState } from "react";
import { RotateCw } from "lucide-react";
import { PAF_OPS_RESTART_URL, PAF_OPS_TOKEN } from "@/lib/paf/config";

type RestartState =
  | { kind: "idle" }
  | { kind: "restarting" }
  | { kind: "done" }
  | { kind: "error"; msg: string }
  | { kind: "unauthorized" };

const WAIT_MS = 4000; // brief "restarting" feel before settling

export function RestartButton() {
  const [state, setState] = useState<RestartState>({ kind: "idle" });
  const busyRef = useRef(false);

  const onClick = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setState({ kind: "restarting" });
    try {
      const res = await fetch(PAF_OPS_RESTART_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${PAF_OPS_TOKEN}`,
        },
      });
      if (res.status === 401) {
        setState({ kind: "unauthorized" });
      } else if (res.ok) {
        setState({ kind: "done" });
      } else {
        const body = await res.json().catch(() => null);
        setState({
          kind: "error",
          msg: body?.detail?.toString?.() ?? `HTTP ${res.status}`,
        });
      }
    } catch {
      setState({ kind: "error", msg: "unreachable" });
    }
    // Hold the "restarting/done" so the user sees a transition, then idle.
    window.setTimeout(() => {
      busyRef.current = false;
      setState((s) => (s.kind === "done" ? { kind: "idle" } : s));
    }, WAIT_MS);
  };

  const busy = state.kind === "restarting";
  const label =
    state.kind === "restarting"
      ? "Restarting…"
      : state.kind === "done"
        ? "Restarted"
        : "Restart SSE";

  return (
    <div
      className="flex items-center gap-1"
      title="Restart the paf SSE server"
      // Mouse-leave only dismisses an error. It must never touch an in-flight
      // restart (that reset the spinner whenever the pointer moved away).
      onMouseLeave={() =>
        setState((s) =>
          s.kind === "error" || s.kind === "unauthorized" ? { kind: "idle" } : s,
        )
      }
    >
      <button
        type="button"
        onClick={() => void onClick()}
        disabled={busy}
        aria-label="Restart SSE server"
        className={`flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium transition-colors ${
          state.kind === "error" || state.kind === "unauthorized"
            ? "text-red-500 hover:bg-destructive/10"
            : state.kind === "done"
              ? "text-emerald-500 hover:bg-accent"
              : "text-muted-foreground hover:bg-accent hover:text-foreground"
        } disabled:cursor-not-allowed disabled:opacity-60`}
      >
        <RotateCw className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} />
        {label}
      </button>
      {(state.kind === "error" || state.kind === "unauthorized") && (
        <span className="text-[10px] text-red-500">
          {state.kind === "unauthorized" ? "no token" : state.msg}
        </span>
      )}
    </div>
  );
}
