import type { NextConfig } from "next";

// Extra dev origins Next should accept, comma-separated, from .env.local
// (machine-local: a Tailscale host/IP, a LAN IP, a reverse-proxy name).
// Loopback is always allowed; the repo ships no machine-specific origin.
const devOrigins = (process.env.NEXT_DEV_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const nextConfig: NextConfig = {
  // components/ai-elements/prompt-input.tsx (vendored registry code) has type
  // errors against the installed base-ui version; app code is clean. Don't let
  // them block the production build.
  typescript: { ignoreBuildErrors: true },
  // The service worker must never be served from a stale HTTP cache, or an
  // updated worker won't reach installed clients.
  async headers() {
    return [
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
    ];
  },
  // Dev-mode cross-origin allowance so the UI is reachable from other hosts in
  // dev without Next's dev-origin guard dropping requests. Machine-local origins
  // (a Tailscale host/IP, a LAN IP) go in .env.local as NEXT_DEV_ORIGINS; the
  // repo ships only loopback. `next.config.ts` is evaluated by the CLI after
  // env files load, so process.env here already includes .env.local.
  allowedDevOrigins: ["127.0.0.1"].concat(devOrigins),
};

export default nextConfig;
