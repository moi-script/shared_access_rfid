"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  apiPost,
  getStoredUser,
  getToken,
  logout,
  redirectForRole,
  updateStoredUser,
  type AuthUser,
} from "@/lib/auth";
import Notice from "@/components/Notice";
import NcstMark from "@/components/NcstMark";

const inputCls =
  "w-full rounded-xl border border-line bg-white px-3 py-2 text-[14px] text-ink outline-none focus:border-blue focus:ring-4 focus:ring-blue/12";

export default function ChangePasswordForm() {
  const router = useRouter();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Same guard the admin/dashboard pages already use: no stored token means
  // this is a logged-out visitor, who gets redirected instead of a form that
  // can only ever 401 on submit. Read directly during render (like
  // PersonProfile's isSuperadmin check) rather than mirrored into state, so
  // the effect below only ever performs the redirect side effect and never
  // calls setState itself.
  const authed = Boolean(getToken() && getStoredUser());

  useEffect(() => {
    if (!authed) {
      router.replace("/login");
    }
  }, [authed, router]);

  async function signOut() {
    await logout();
    router.replace("/login");
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    // Checked here as well as by the input pattern, because a mismatch is the
    // one error the server cannot see: it only ever receives one new password.
    if (next !== confirm) {
      setError("The new passwords do not match.");
      return;
    }
    setSaving(true);
    try {
      await apiPost("/auth/change-password", {
        currentPassword: current,
        newPassword: next,
      });
      updateStoredUser({ mustChangePassword: false });
      const user = getStoredUser() as AuthUser | null;
      router.replace(user ? redirectForRole(user.role, false) : "/login");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  if (!authed) return null;

  return (
    <main className="grid min-h-dvh place-items-center bg-paper px-6 py-10">
      <form
        onSubmit={submit}
        className="w-full max-w-md space-y-4 rounded-2xl border border-line bg-white p-8"
      >
        <div className="flex items-center gap-3">
          <NcstMark className="h-10 w-10" />
          <div className="leading-tight">
            <h1 className="font-display text-lg font-700 tracking-tight text-ink">
              Change your password
            </h1>
            <p className="text-[13px] text-ink-soft">
              Choose a password only you know before continuing.
            </p>
          </div>
        </div>

        {error && (
          <Notice compact className="text-[13px] text-ink">
            {error}
          </Notice>
        )}

        <label className="block text-[13px] font-600 text-ink-soft">
          Current password
          <input
            required
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            className={`mt-1 ${inputCls}`}
          />
        </label>

        <label className="block text-[13px] font-600 text-ink-soft">
          New password
          <input
            required
            type="password"
            minLength={8}
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            placeholder="Min. 8 characters"
            className={`mt-1 ${inputCls}`}
          />
        </label>

        <label className="block text-[13px] font-600 text-ink-soft">
          Confirm new password
          <input
            required
            type="password"
            minLength={8}
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            className={`mt-1 ${inputCls}`}
          />
        </label>

        <button
          type="submit"
          disabled={saving}
          className="w-full rounded-xl bg-navy px-4 py-2.5 text-sm font-600 text-white hover:bg-navy/90 disabled:opacity-60"
        >
          {saving ? "Saving…" : "Change password"}
        </button>

        <button
          type="button"
          onClick={signOut}
          className="w-full rounded-xl border border-line bg-white px-4 py-2.5 text-sm font-600 text-ink-soft hover:text-ink"
        >
          Sign out
        </button>
      </form>
    </main>
  );
}
