"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import BrandPanel from "./BrandPanel";
import NcstMark from "./NcstMark";
import RfidGlyph from "./RfidGlyph";
import Notice from "./Notice";
import { API_BASE, logout, redirectForRole, storeAuth, type AuthUser } from "@/lib/auth";
import { MEMBER_PORTAL_ENABLED, isStaffSide } from "@/lib/permissions";

type NoticeKind = "error" | "success";

export default function LoginExperience() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [remember, setRemember] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [noticeKind, setNoticeKind] = useState<NoticeKind>("error");

  // Palette blues. The illustration is coral, but the UI is palette-locked, and
  // the palette's warms cannot carry white button text or small links. Steps
  // differ by contrast requirement: coral-700 (blue) fills under white text,
  // coral-800 (light blue) is the hover step and small-text colour.
  const accent = {
    bg: "bg-coral-700",
    hover: "hover:bg-coral-800",
    text: "text-coral-800",
    soft: "bg-coral-soft",
  };

  function showNotice(kind: NoticeKind, message: string) {
    setNoticeKind(kind);
    setNotice(message);
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setNotice(null);
    if (!username.trim() || !password) {
      showNotice("error", "Please enter your username and password.");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch(`${API_BASE}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include", // receive the httpOnly refresh cookie
        body: JSON.stringify({ username: username.trim(), password }),
      });

      const body = (await res.json().catch(() => null)) as
        | { success: true; data: { accessToken: string; user: AuthUser } }
        | { success: false; code?: string; message?: string }
        | null;

      if (!res.ok || !body || body.success !== true) {
        const failure = body as { code?: string; message?: string } | null;
        const message =
          failure?.code === "INVALID_CREDENTIALS"
            ? "Incorrect username or password."
            : failure?.message ?? "Sign in failed. Please try again.";
        showNotice("error", message);
        return;
      }

      const { accessToken, user } = body.data;

      // The member portal is disconnected, so a student or staff sign-in has
      // nowhere to land. Refuse before storing anything, and drop the refresh
      // cookie the server just set — a session nobody can use is a session
      // worth not keeping. See MEMBER_PORTAL_ENABLED.
      if (!MEMBER_PORTAL_ENABLED && !isStaffSide(user.role)) {
        await logout();
        showNotice(
          "error",
          "Student and staff accounts don’t use the web portal yet. Tap your RFID card at the gate reader instead.",
        );
        return;
      }

      storeAuth(accessToken, user, remember);
      showNotice("success", `Signed in as “${user.username}”. Redirecting…`);
      router.push(redirectForRole(user.role, user.mustChangePassword));
    } catch {
      // The deployed build talks to a hosted API, so naming localhost here
      // would send a real user chasing a service that was never theirs to run.
      showNotice(
        "error",
        process.env.NODE_ENV === "production"
          ? "Cannot reach the server. Check your connection and try again."
          : `Cannot reach the server at ${API_BASE}. Make sure the backend is running.`,
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="grid min-h-dvh lg:grid-cols-[1.05fr_1fr] xl:grid-cols-[1.15fr_1fr]">
      <BrandPanel />

      {/* ---- Right: the form ---- */}
      <main className="relative flex flex-col justify-center bg-white px-6 py-10 sm:px-10 lg:px-14 xl:px-20">
        {/* mobile brand row (brand panel is hidden < lg) */}
        <div className="reveal mb-8 flex items-center gap-3 lg:hidden">
          <NcstMark className="h-10 w-10" />
          <div className="leading-tight">
            <p className="font-display text-base font-700 tracking-tight text-ink">
              NCST
            </p>
            {/* Tighter tracking than the 0.2em of the old "RFID Access", and
                for a sharper reason than the panel's: this row is the narrow
                phone layout, where the full name has to clear a 320px screen. */}
            <p className="text-[10px] font-500 uppercase tracking-[0.12em] text-ink-soft">
              Centralized RFID System
            </p>
          </div>
        </div>

        <div className="mx-auto w-full max-w-md">
          <header className="reveal [animation-delay:0.1s]">
            <p className={`text-[12px] font-600 uppercase tracking-[0.2em] ${accent.text}`}>
              RFID System
            </p>
            <h2 className="mt-2 font-display text-3xl font-700 leading-tight tracking-tight text-ink">
              Sign in to your account
            </h2>
            <p className="mt-2 text-[15px] text-ink-soft">
              Enter your credentials to continue.
            </p>
          </header>

          <form onSubmit={handleSubmit} className="reveal mt-7 [animation-delay:0.24s]">
            {/* username */}
            <label className="mb-1.5 block text-[13px] font-500 text-ink-soft" htmlFor="username">
              Username
            </label>
            <input
              id="username"
              name="username"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="Student number, staff or admin username"
              className="mb-4 w-full rounded-2xl border border-line bg-white px-4 py-3 text-[15px] text-ink outline-none transition placeholder:text-ink-soft/50 focus:border-coral focus:ring-4 focus:ring-coral/20"
            />

            {/* password */}
            <div className="mb-1.5 flex items-center justify-between">
              <label className="text-[13px] font-500 text-ink-soft" htmlFor="password">
                Password
              </label>
              <a href="#" className={`text-[13px] font-600 ${accent.text} hover:underline`}>
                Forgot?
              </a>
            </div>
            <div className="relative mb-4">
              <input
                id="password"
                name="password"
                type={showPassword ? "text" : "password"}
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full rounded-2xl border border-line bg-white px-4 py-3 pr-12 text-[15px] text-ink outline-none transition placeholder:text-ink-soft/50 focus:border-coral focus:ring-4 focus:ring-coral/20"
              />
              <button
                type="button"
                onClick={() => setShowPassword((s) => !s)}
                aria-label={showPassword ? "Hide password" : "Show password"}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-2 text-ink-soft transition hover:bg-paper hover:text-ink"
              >
                {showPassword ? <EyeOff /> : <Eye />}
              </button>
            </div>

            {/* remember */}
            <label className="mb-5 flex cursor-pointer select-none items-center gap-2.5 text-[14px] text-ink-soft">
              <input
                type="checkbox"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
                className="h-4 w-4 rounded border-line text-coral-700 accent-coral-700"
              />
              Keep me signed in on this device
            </label>

            {notice && (
              <Notice
                tone={noticeKind === "success" ? "info" : "error"}
                compact
                className="mb-4 text-[13px] text-ink"
              >
                {notice}
              </Notice>
            )}

            <button
              type="submit"
              disabled={submitting}
              className={`flex w-full items-center justify-center gap-2 rounded-2xl px-4 py-3.5 text-[15px] font-600 text-white transition-all disabled:opacity-70 ${accent.bg} ${accent.hover}`}
            >
              {submitting ? (
                <>
                  <Spinner /> Verifying…
                </>
              ) : (
                <>Sign in</>
              )}
            </button>
          </form>

          {/* RFID tap hint — students & staff carry cards */}
          <div className="reveal mt-6 flex items-center gap-3 rounded-2xl border border-dashed border-coral/35 bg-coral-soft px-4 py-3.5 [animation-delay:0.3s]">
            {/* RfidGlyph, not NcstMark: this tile means "tap your card", and the
                seal is an unreadable blob at 24px anyway. */}
            <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-navy text-gold">
              <RfidGlyph className="h-6 w-6" />
            </div>
            <p className="text-[13px] leading-snug text-ink-soft">
              On campus? Just{" "}
              <span className="font-600 text-ink">tap your RFID card</span> on
              the gate reader — no password needed.
            </p>
          </div>

          <p className="reveal mt-8 text-center text-[12px] text-ink-soft [animation-delay:0.34s]">
            © {new Date().getFullYear()} National College of Science and
            Technology · RFID System
          </p>
        </div>
      </main>
    </div>
  );
}

/* ---- inline icons ---- */
function Eye() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}
function EyeOff() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9.9 4.24A9.1 9.1 0 0 1 12 4c6.5 0 10 7 10 7a13.2 13.2 0 0 1-2.16 2.94M6.6 6.6A13.3 13.3 0 0 0 2 11s3.5 7 10 7a9 9 0 0 0 4.4-1.1" />
      <path d="M14.12 14.12A3 3 0 1 1 9.88 9.88M3 3l18 18" />
    </svg>
  );
}
function Spinner() {
  return (
    <svg className="animate-spin" width="18" height="18" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" opacity="0.25" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}
