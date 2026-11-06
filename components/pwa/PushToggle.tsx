"use client";

// Header bell: enable / disable Web Push on this device and send a test.
//
// paf pushes a notification when detached background work settles;
// this is the per-device opt-in. On iOS push only exists inside the installed
// Home Screen app, so a Safari tab gets install instructions instead.

import { useCallback, useEffect, useState } from "react";
import { Bell, BellOff, BellRing } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  disablePush,
  enablePush,
  getPushStatus,
  sendTestPush,
  type PushStatus,
} from "@/lib/paf/push";

type Note = { kind: "ok" | "error"; text: string } | null;

export function PushToggle() {
  const [status, setStatus] = useState<PushStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>(null);

  const refresh = useCallback(async () => {
    setStatus(await getPushStatus());
  }, []);

  useEffect(() => {
    let alive = true;
    void getPushStatus().then((s) => {
      if (alive) setStatus(s);
    });
    return () => {
      alive = false;
    };
  }, []);

  const run = async (
    action: () => Promise<{ ok: boolean; error?: string }>,
    okText: string,
  ) => {
    setBusy(true);
    setNote(null);
    const res = await action();
    setNote(
      res.ok
        ? { kind: "ok", text: okText }
        : { kind: "error", text: res.error ?? "Something went wrong." },
    );
    await refresh();
    setBusy(false);
  };

  const subscribed = status?.subscribed ?? false;
  const denied = status?.permission === "denied";
  const Icon = subscribed ? BellRing : denied ? BellOff : Bell;

  return (
    <Popover onOpenChange={(open) => open && void refresh()}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="Notifications"
            title="Notifications"
          />
        }
      >
        <Icon
          className={`size-4 ${subscribed ? "text-emerald-500" : ""}`}
        />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72">
        <PopoverHeader>
          <PopoverTitle>Notifications</PopoverTitle>
          <PopoverDescription>
            {status === null
              ? "Checking…"
              : status.support === "needs-install"
                ? "On iPhone, add paf to your Home Screen first: tap Share, then Add to Home Screen, and open it from there."
                : status.support === "unsupported"
                  ? "This browser can't receive push notifications."
                  : denied
                    ? "Notifications are blocked for paf — allow them in the system settings, then come back."
                    : subscribed
                      ? "On. You'll be notified when background work finishes, even with the app closed."
                      : "Get notified when background work finishes, even with the app closed."}
          </PopoverDescription>
        </PopoverHeader>

        {status?.support === "supported" && !denied && (
          <div className="flex gap-2">
            {subscribed ? (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void run(sendTestPush, "Test sent — check your notifications.")
                  }
                >
                  Send test
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void run(disablePush, "Notifications off.")}
                >
                  Turn off
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                disabled={busy}
                onClick={() => void run(enablePush, "Notifications on.")}
              >
                Enable notifications
              </Button>
            )}
          </div>
        )}

        {note && (
          <p
            className={`text-xs ${
              note.kind === "error" ? "text-red-500" : "text-emerald-500"
            }`}
            role="status"
          >
            {note.text}
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}
