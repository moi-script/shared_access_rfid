"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import NcstMark from "@/components/NcstMark";
import ProfileView, { InfoBanner, type PersonOverview } from "@/components/ProfileView";
import { apiGet, getStoredUser, getToken, logout, type AuthUser } from "@/lib/auth";
import { MEMBER_PORTAL_ENABLED, isStaffSide } from "@/lib/permissions";

export default function DashboardPage() {
  const router = useRouter();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [data, setData] = useState<PersonOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const stored = getStoredUser();
    if (!getToken() || !stored) {
      router.replace("/login");
      return;
    }
    // Typed straight into the address bar, or reached from a session that
    // predates the flag. Ahead of the mustChangePassword check on purpose:
    // /change-password would only send a member back here afterwards.
    if (!MEMBER_PORTAL_ENABLED && !isStaffSide(stored.role)) {
      void logout().then(() => router.replace("/login"));
      return;
    }
    if (stored.mustChangePassword) {
      router.replace("/change-password");
      return;
    }
    if (isStaffSide(stored.role)) {
      router.replace("/admin");
      return;
    }
    setUser(stored);

    apiGet<PersonOverview>("/dashboard")
      .then(setData)
      .catch((err: Error & { status?: number }) => {
        if (err.status === 401) {
          router.replace("/login");
          return;
        }
        setError(err.message);
      })
      .finally(() => setLoading(false));
  }, [router]);

  async function handleLogout() {
    await logout();
    router.replace("/login");
  }

  if (loading) {
    return (
      <main className="grid min-h-dvh place-items-center bg-paper text-ink-soft">
        Loading your dashboard…
      </main>
    );
  }

  const kindLabel =
    data?.person?.type === "student"
      ? "Student"
      : data?.person?.type === "staff"
        ? "Staff"
        : "Member";

  return (
    <main className="min-h-dvh bg-paper">
      <header className="border-b border-line bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <NcstMark className="h-9 w-9" />
            <div className="leading-tight">
              <p className="font-display text-base font-700 tracking-tight text-navy">NCST RFID</p>
              <p className="text-[11px] font-500 uppercase tracking-[0.18em] text-ink-soft">
                {kindLabel} Portal
              </p>
            </div>
          </div>
          <button
            onClick={handleLogout}
            className="rounded-xl border border-line bg-white px-4 py-2 text-sm font-600 text-ink-soft transition hover:border-red hover:bg-red/25 hover:text-ink"
          >
            Sign out
          </button>
        </div>
      </header>

      <div className="mx-auto max-w-5xl space-y-4 px-6 py-8">
        {error && <InfoBanner>Couldn&apos;t load dashboard data: {error}</InfoBanner>}
        {data ? (
          <ProfileView data={data} />
        ) : (
          !error && <p className="text-ink-soft">No profile for {user?.username}.</p>
        )}
      </div>
    </main>
  );
}
