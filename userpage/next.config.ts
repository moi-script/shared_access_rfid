import { networkInterfaces } from "node:os";
import type { NextConfig } from "next";

/**
 * Every non-loopback IPv4 address this machine currently holds.
 *
 * Read at config load rather than hardcoded because the address is different
 * on every PC the USB drive is plugged into, and a stale one here fails in a
 * way that looks nothing like a config problem: the gate terminal gets the
 * HTML but is refused /_next/*, so the page renders its skeleton and never
 * hydrates.
 */
function lanAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((iface) => iface && iface.family === "IPv4" && !iface.internal)
    .map((iface) => iface!.address);
}

const nextConfig: NextConfig = {
  // Don't advertise the framework and version to anyone scanning for known
  // Next.js CVEs.
  poweredByHeader: false,

  // `next dev` was initialized on localhost, so by default it blocks requests
  // for /_next/* dev assets that arrive from any other origin. A gate terminal
  // opening http://192.168.1.2:5173 gets the HTML but no bundle — the page
  // renders its skeleton and never hydrates. Development-only setting; the
  // production build serves assets to whatever origin it is deployed under.
  //
  // Resolved from this machine's own interfaces so the gate terminal works on
  // any PC without editing this file. Anything extra (a hostname such as
  // rfid.lab, a second subnet) goes in EXTRA_DEV_ORIGINS, comma-separated.
  allowedDevOrigins: [
    ...lanAddresses(),
    ...(process.env.EXTRA_DEV_ORIGINS ?? "")
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean),
  ],

  // A type error should stop a deploy, not ship. This is the default; it is
  // stated explicitly so nobody "fixes" a red build by turning it off.
  // (Next 16 dropped the sibling `eslint` key — linting is no longer part of
  // `next build`, so run `npm run lint` in CI separately.)
  typescript: { ignoreBuildErrors: false },

  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          // The app is an internal RFID console; there is no reason for a
          // third-party site to frame it, and framing is how a clickjack
          // overlays an invisible admin action on a page the user thinks is
          // something else.
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          // Cross-origin API calls must still carry the Origin header (the API
          // whitelists it), so this cannot be stricter than origin-when-...
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // PhotoCapture uses getUserMedia, so camera stays allowed for this
          // origin; nothing here needs a microphone, geolocation or payments.
          {
            key: "Permissions-Policy",
            value: "camera=(self), microphone=(), geolocation=(), payment=()",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
