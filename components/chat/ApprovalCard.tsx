"use client";

// components/chat/ApprovalCard.tsx
// ---------------------------------------------------------------------------
// An inline card for a tool call that is waiting for the user's approval
// (paf's approval flow: the turn is paused on this one call server-side).
//
// Shows what would run (the tool and its arguments, secrets scrubbed by the
// server), why it needs approval, a preview of the effect when the server
// could work one out (e.g. what `rm -rf build/` would delete), and the time
// left before the request is denied on its own. Approve / Deny POST to
// /api/approvals/{id}; the card flips to its final state when the server's
// `approval_resolved` frame arrives (the server, not the click, is the truth:
// another device, a timeout, or a stop may settle it first).

import { useEffect, useState } from "react";
import { CheckIcon, ShieldAlertIcon, XIcon } from "lucide-react";

import {
  Confirmation,
  ConfirmationAccepted,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationRejected,
  ConfirmationRequest,
  ConfirmationTitle,
} from "@/components/ai-elements/confirmation";
import { Textarea } from "@/components/ui/textarea";
import { decideApproval } from "@/lib/paf/api";
import type { Approval } from "@/lib/paf/types";

/** Arguments as `key: value` lines when they are a JSON object. */
export function argLines(args: string): string[] {
  try {
    const data = JSON.parse(args) as unknown;
    if (data && typeof data === "object" && !Array.isArray(data)) {
      return Object.entries(data as Record<string, unknown>).map(
        ([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`,
      );
    }
    return [JSON.stringify(data)];
  } catch {
    return [args];
  }
}

/** "9:41" left until `expiresAt` (epoch seconds); "0:00" once past. */
export function timeLeft(expiresAt: number, now: number = Date.now()): string {
  const s = Math.max(0, Math.round(expiresAt - now / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** What the settled card says, for each way a request can end. */
export function outcomeText(a: Approval): string {
  const by = a.actor && !["system", "web"].includes(a.actor) ? ` (${a.actor})` : "";
  switch (a.status) {
    case "approved":
      return `Approved${by}. ${a.toolName} ran.`;
    case "denied":
      return `Denied${by}. ${a.toolName} was not run.${a.note ? ` Note: “${a.note}”` : ""}`;
    case "timeout":
      return `No answer in time, so ${a.toolName} was not run.`;
    case "cancelled":
      return `Cancelled: the turn was stopped. ${a.toolName} was not run.`;
    case "unattended":
      return `${a.toolName} needed approval and was not run.`;
    default:
      return "";
  }
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

export function ApprovalCard({ approval }: { approval: Approval }) {
  const pending = approval.status === "pending";
  const now = useNow(pending);
  const [note, setNote] = useState("");
  const [sending, setSending] = useState<"approve" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const decide = async (decision: "approve" | "deny") => {
    setSending(decision);
    setError(null);
    const res = await decideApproval(approval.approvalId, decision, note.trim() || undefined);
    if (!res.ok) {
      setError(res.error);
      setSending(null);
    }
    // On success keep "sending" until the server's approval_resolved frame
    // settles the card (it is authoritative).
  };

  const lines = argLines(approval.args);
  const expired = pending && approval.expiresAt * 1000 <= now;

  return (
    <Confirmation
      approval={
        pending
          ? { id: approval.approvalId }
          : { id: approval.approvalId, approved: approval.status === "approved" }
      }
      state={pending ? "approval-requested" : "approval-responded"}
      className={pending ? "border-amber-500/60" : undefined}
    >
      <ConfirmationTitle className="flex items-center gap-2 font-medium">
        <ShieldAlertIcon className="size-4 text-amber-500" />
        {pending ? "Approval needed" : "Approval"}
        <span className="font-mono text-xs">{approval.toolName}</span>
        {pending && (
          <span className="ml-auto text-xs tabular-nums text-muted-foreground">
            {expired ? "expiring…" : `expires in ${timeLeft(approval.expiresAt, now)}`}
          </span>
        )}
      </ConfirmationTitle>

      <ConfirmationRequest>
        <div className="flex flex-col gap-2 text-sm">
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-muted px-2 py-1.5 font-mono text-xs">
            {lines.join("\n")}
          </pre>
          {approval.reason && (
            <p className="text-muted-foreground">
              <span className="font-medium text-foreground">Why: </span>
              {approval.reason}
            </p>
          )}
          {approval.preview && Object.keys(approval.preview).length > 0 && (
            <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-xs">
              {Object.entries(approval.preview).map(([k, v]) => (
                <div key={k} className="contents">
                  <dt
                    className={
                      k === "warning"
                        ? "font-medium text-amber-600 dark:text-amber-400"
                        : "text-muted-foreground"
                    }
                  >
                    {k}
                  </dt>
                  <dd
                    className={
                      k === "warning" ? "text-amber-600 dark:text-amber-400" : undefined
                    }
                  >
                    {v}
                  </dd>
                </div>
              ))}
            </dl>
          )}
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Optional note to the agent (e.g. why you are denying, or what to do instead)"
            className="min-h-14 text-sm"
            disabled={sending !== null}
          />
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
      </ConfirmationRequest>

      <ConfirmationActions>
        <ConfirmationAction
          variant="outline"
          onClick={() => decide("deny")}
          disabled={sending !== null}
        >
          <XIcon className="size-4" />
          {sending === "deny" ? "Denying…" : "Deny"}
        </ConfirmationAction>
        <ConfirmationAction onClick={() => decide("approve")} disabled={sending !== null}>
          <CheckIcon className="size-4" />
          {sending === "approve" ? "Approving…" : "Approve"}
        </ConfirmationAction>
      </ConfirmationActions>

      <ConfirmationAccepted>
        <p className="flex items-center gap-1.5 text-sm text-emerald-600 dark:text-emerald-400">
          <CheckIcon className="size-4" />
          {outcomeText(approval)}
        </p>
      </ConfirmationAccepted>
      <ConfirmationRejected>
        <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <XIcon className="size-4" />
          {outcomeText(approval)}
        </p>
      </ConfirmationRejected>
    </Confirmation>
  );
}
