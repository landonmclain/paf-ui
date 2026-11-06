// lib/paf/push.ts
// ---------------------------------------------------------------------------
// Web Push client for the paf backend (/api/push/*).
//
// The backend owns VAPID + sending; this is the thin browser side: ask for
// permission, subscribe via the service worker (public/sw.js), and register the
// subscription with paf. All functions are safe to call anywhere — they never
// throw; failures come back as `{ ok: false, error }`.

import { PAF_BASE_URL } from "./config";

const PUSH_URL = `${PAF_BASE_URL}/api/push`;

export type PushSupport =
  /** Can subscribe right now. */
  | "supported"
  /** iOS Safari tab: push only works once added to the Home Screen. */
  | "needs-install"
  /** No service worker / Push API (old browser, or insecure origin). */
  | "unsupported";

export type PushStatus = {
  support: PushSupport;
  permission: NotificationPermission | "unsupported";
  /** This device has a live push subscription. */
  subscribed: boolean;
};

type Result = { ok: true } | { ok: false; error: string };

const isIos = () =>
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  // iPadOS reports as Mac with touch.
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

const isStandalone = () =>
  window.matchMedia("(display-mode: standalone)").matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true;

export function pushSupport(): PushSupport {
  if (typeof window === "undefined") return "unsupported";
  const apis =
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window;
  if (apis && window.isSecureContext) return "supported";
  // iOS only exposes the Push API to an installed web app.
  if (isIos() && !isStandalone() && window.isSecureContext) {
    return "needs-install";
  }
  return "unsupported";
}

function urlBase64ToUint8Array(b64: string): Uint8Array<ArrayBuffer> {
  const padded = (b64 + "=".repeat((4 - (b64.length % 4)) % 4))
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const raw = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function getRegistration(): Promise<ServiceWorkerRegistration | null> {
  try {
    return await navigator.serviceWorker.ready;
  } catch {
    return null;
  }
}

async function post(path: string, body: unknown): Promise<Response | null> {
  try {
    return await fetch(`${PUSH_URL}/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return null;
  }
}

// --- presence ---------------------------------------------------------------
// While the page is visible (and, on desktop, focused) it tells paf which
// conversation it is showing, so paf doesn't push to a device that is already
// looking at the answer. Reports expire server-side after ~30s, so an app that is
// backgrounded, locked or killed drops out on its own. A device that isn't
// subscribed to push has nothing to report.

let presenceEndpoint: string | null | undefined; // undefined = not looked up yet

async function currentEndpoint(): Promise<string | null> {
  if (presenceEndpoint !== undefined) return presenceEndpoint;
  if (pushSupport() !== "supported") return (presenceEndpoint = null);
  const reg = await getRegistration();
  const sub = (await reg?.pushManager.getSubscription()) ?? null;
  return (presenceEndpoint = sub?.endpoint ?? null);
}

/** Is the user actually looking at this page? Visible; on desktop also focused
 *  (a visible but unfocused window may be on a second monitor). Touch devices
 *  can't be visible without being the foreground app. */
export function isWatching(): boolean {
  if (document.visibilityState !== "visible") return false;
  const touch = window.matchMedia("(pointer: coarse)").matches;
  return touch || document.hasFocus();
}

/** Tell paf this device is (or stopped) watching a conversation. Best effort. */
export async function reportPresence(
  agent: string,
  cid: string,
  watching: boolean,
  opts: { keepalive?: boolean } = {},
): Promise<void> {
  try {
    const endpoint = await currentEndpoint();
    if (!endpoint) return;
    const res = await fetch(`${PUSH_URL}/presence`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint, agent, cid, watching }),
      keepalive: opts.keepalive ?? false,
    });
    // The server doesn't know this subscription (store wiped / endpoint rotated):
    // forget the cached endpoint; the next getPushStatus re-registers it.
    if (res.status === 404) presenceEndpoint = undefined;
  } catch {
    /* presence is best effort */
  }
}

/** Current permission + whether this device is subscribed. If it is, the
 *  subscription is re-registered with paf (idempotent) so a wiped server store
 *  or a rotated endpoint heals itself on the next app open. */
export async function getPushStatus(): Promise<PushStatus> {
  const support = pushSupport();
  if (support !== "supported") {
    return { support, permission: "unsupported", subscribed: false };
  }
  const permission = Notification.permission;
  const reg = await getRegistration();
  const sub = (await reg?.pushManager.getSubscription()) ?? null;
  if (sub && permission === "granted") {
    void post("subscribe", { subscription: sub.toJSON() });
  }
  return { support, permission, subscribed: !!sub };
}

/** Ask permission (must run inside a user gesture — call this first, before any
 *  await), subscribe, and register with paf. */
export async function enablePush(): Promise<Result> {
  if (pushSupport() !== "supported") {
    return { ok: false, error: "Push isn't available in this browser." };
  }
  // First await in the handler: iOS only honors the prompt from a tap.
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    return {
      ok: false,
      error:
        permission === "denied"
          ? "Notifications are blocked — enable them in Settings."
          : "Permission wasn't granted.",
    };
  }

  let publicKey: string;
  try {
    const res = await fetch(`${PUSH_URL}/vapid-public-key`, {
      cache: "no-store",
    });
    if (!res.ok) {
      return {
        ok: false,
        error:
          res.status === 503
            ? "Push isn't configured on the server."
            : `Server error (${res.status}).`,
      };
    }
    publicKey = ((await res.json()) as { public_key: string }).public_key;
  } catch {
    return { ok: false, error: "Can't reach the server." };
  }

  const reg = await getRegistration();
  if (!reg) return { ok: false, error: "Service worker isn't ready." };

  try {
    // A subscription made under a different VAPID key can't be reused.
    const existing = await reg.pushManager.getSubscription();
    await existing?.unsubscribe();
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
    presenceEndpoint = undefined;
    const res = await post("subscribe", { subscription: sub.toJSON() });
    if (!res?.ok) {
      await sub.unsubscribe(); // keep browser and server consistent
      return { ok: false, error: "Server rejected the subscription." };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Subscribe failed.",
    };
  }
}

export async function disablePush(): Promise<Result> {
  presenceEndpoint = undefined;
  const reg = await getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (sub) {
    await post("unsubscribe", { endpoint: sub.endpoint });
    await sub.unsubscribe().catch(() => false);
  }
  return { ok: true };
}

/** Ask paf to push a test notification to THIS device only. */
export async function sendTestPush(): Promise<Result> {
  const reg = await getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return { ok: false, error: "This device isn't subscribed." };
  const res = await post("test", { endpoint: sub.endpoint });
  if (!res) return { ok: false, error: "Can't reach the server." };
  if (res.status === 404) {
    // Server forgot us; re-register and let the user retry.
    void post("subscribe", { subscription: sub.toJSON() });
    return { ok: false, error: "Server didn't know this device — try again." };
  }
  const body = (await res.json().catch(() => null)) as {
    outcome?: string;
  } | null;
  if (!res.ok || body?.outcome !== "sent") {
    return {
      ok: false,
      error:
        body?.outcome === "gone"
          ? "Subscription expired — toggle notifications off and on."
          : "The push service rejected the test.",
    };
  }
  return { ok: true };
}
