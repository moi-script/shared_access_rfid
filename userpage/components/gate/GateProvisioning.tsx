"use client";

import { useState } from "react";
import { API_BASE } from "@/lib/auth";
import Notice from "@/components/Notice";
import {
  GATE_ROUTES,
  mintGateKey,
  storeGate,
  type GateConfig,
  type GateRouteId,
} from "@/lib/gateTerminal";

interface Gate {
  _id: string;
  name: string;
  type: "person" | "vehicle";
  direction: "entry" | "exit";
  location?: string;
}

export default function GateProvisioning({
  routeId,
  onProvisioned,
}: {
  routeId: GateRouteId;
  onProvisioned: (config: GateConfig) => void;
}) {
  const expected = GATE_ROUTES[routeId];
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function provision(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    // Set once login succeeds. A terminal that only gets this far must not
    // leave a live session cookie behind on a shared, unattended machine.
    let token: string | null = null;
    let sessionClosed = false;
    try {
      const loginRes = await fetch(`${API_BASE}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ username, password }),
      });
      const loginBody = (await loginRes.json().catch(() => null)) as
        | { success: true; data: { accessToken: string; user: { role: string } } }
        | { success: false; message?: string }
        | null;
      if (!loginRes.ok || !loginBody || loginBody.success !== true) {
        throw new Error((loginBody as { message?: string } | null)?.message ?? "Sign-in failed");
      }
      token = loginBody.data.accessToken;
      if (loginBody.data.user.role !== "superadmin") {
        throw new Error("Only a superadmin can set up a gate terminal.");
      }

      const gatesRes = await fetch(`${API_BASE}/gates`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const gatesBody = (await gatesRes.json().catch(() => null)) as
        | { success: true; data: Gate[] }
        | null;
      if (!gatesBody || gatesBody.success !== true) throw new Error("Could not load gates");

      const gate = gatesBody.data.find(
        (g) => g.type === expected.type && g.direction === expected.direction
      );
      if (!gate) {
        throw new Error(
          `No ${expected.type}/${expected.direction} gate exists. Run the seed on the server first.`
        );
      }

      const minted = await mintGateKey(token, gate._id);
      const config: GateConfig = {
        key: minted.key,
        gateId: gate._id,
        name: gate.name,
        type: gate.type,
        direction: gate.direction,
      };
      storeGate(routeId, config);

      // The terminal runs as a device from here; the admin session is not kept.
      await fetch(`${API_BASE}/auth/logout`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        credentials: "include",
      }).catch(() => undefined);
      sessionClosed = true;

      onProvisioned(config);
    } catch (err) {
      setError((err as Error).message);
      // Login can succeed while any later step fails (role check, /gates,
      // no matching gate, or minting) — in every case the browser is already
      // holding a session cookie that must not survive on an unattended gate.
      if (token && !sessionClosed) {
        await fetch(`${API_BASE}/auth/logout`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
          credentials: "include",
        }).catch(() => undefined);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="grid min-h-dvh place-items-center bg-ink p-6">
      <form
        onSubmit={provision}
        className="w-full max-w-sm space-y-4 rounded-2xl bg-white p-8"
      >
        <div>
          <p className="text-[11px] font-600 uppercase tracking-[0.18em] text-ink-soft">
            Gate terminal
          </p>
          <h1 className="font-display text-xl font-700 text-navy">This terminal isn&apos;t set up</h1>
          <p className="mt-1 text-[13px] text-ink-soft">
            A superadmin signs in once to bind this screen to the{" "}
            <strong>{expected.label}</strong> gate. The sign-in is not kept.
          </p>
        </div>

        {error && (
          <Notice compact className="text-[13px] text-ink">
            {error}
          </Notice>
        )}

        <label className="block text-[13px] font-600 text-ink-soft">
          Username
          <input
            required
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="mt-1 w-full rounded-xl border border-line px-3 py-2 text-[14px] text-ink outline-none focus:border-blue"
          />
        </label>
        <label className="block text-[13px] font-600 text-ink-soft">
          Password
          <input
            required
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 w-full rounded-xl border border-line px-3 py-2 text-[14px] text-ink outline-none focus:border-blue"
          />
        </label>
        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-xl bg-navy px-4 py-2.5 text-sm font-600 text-white disabled:opacity-60"
        >
          {busy ? "Setting up…" : "Set up this gate"}
        </button>
      </form>
    </main>
  );
}
