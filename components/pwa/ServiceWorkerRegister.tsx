"use client";

import { useEffect } from "react";

/**
 * Registers /sw.js (installability and push handlers).
 * No-ops where service workers are unavailable (insecure origin, old browser).
 * `updateViaCache: "none"` so a changed sw.js is picked up on the next load.
 */
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (!("serviceWorker" in navigator) || !window.isSecureContext) return;
    navigator.serviceWorker
      .register("/sw.js", { scope: "/", updateViaCache: "none" })
      .catch((err) => console.warn("service worker registration failed", err));
  }, []);
  return null;
}
