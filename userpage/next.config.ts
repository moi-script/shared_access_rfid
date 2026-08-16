import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Don't advertise the framework and version to anyone scanning for known
  // Next.js CVEs.
  poweredByHeader: false,

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
