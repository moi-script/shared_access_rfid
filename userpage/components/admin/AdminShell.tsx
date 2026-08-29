"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import NcstMark from "@/components/NcstMark";
import Notice from "@/components/Notice";
import StudentsDirectory from "@/components/StudentsDirectory";
import PersonProfile from "@/components/PersonProfile";
import OverviewView from "./OverviewView";
import ParkingView from "./ParkingView";
import VehiclesView from "./VehiclesView";
import PresenceView from "./PresenceView";
import RecordsView from "./RecordsView";
import RegisterView from "./RegisterView";
import AccountsView from "./AccountsView";
import type { AdminDashboard } from "./types";
import { apiGet, logout, type AuthUser } from "@/lib/auth";
import { NAV_BY_ROLE, VIEW_ICONS, defaultViewFor, type AdminView } from "@/lib/permissions";
import { TfiPowerOff } from "react-icons/tfi";

export default function AdminShell({ user }: { user: AuthUser }) {
  const router = useRouter();
  const [data, setData] = useState<AdminDashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<AdminView | null>(defaultViewFor(user.role));
  const [selected, setSelected] = useState<{ id: string; name: string } | null>(null);

  const nav = NAV_BY_ROLE[user.role];

  useEffect(() => {
    apiGet<AdminDashboard>("/dashboard")
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

  function go(v: AdminView) {
    setSelected(null);
    setView(v);
  }

  return (
    <main className="min-h-dvh bg-paper">
      <header className="border-b border-line bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <NcstMark className="h-9 w-9" />
            <div className="leading-tight">
              <p className="font-display text-base font-700 tracking-tight text-navy">
                NCST Centralized RFID System
              </p>
              <p className="text-[11px] font-500 uppercase tracking-[0.18em] text-ink-soft">
                {user.role === "superadmin" ? "Administration" : "Registrar"}
              </p>
            </div>
          </div>
          <button
            onClick={handleLogout}
            className="flex items-center gap-2 rounded-xl border border-line bg-white px-4 py-2 text-sm font-600 text-ink-soft transition hover:border-red hover:bg-red/25 hover:text-ink"
          >
            <TfiPowerOff aria-hidden className="h-3.5 w-3.5" />
            Sign out
          </button>
        </div>

        <nav className="mx-auto flex max-w-6xl gap-1 px-6">
          {nav.map((item) => {
            const Icon = VIEW_ICONS[item.id];
            return (
              <button
                key={item.id}
                onClick={() => go(item.id)}
                aria-current={view === item.id ? "page" : undefined}
                className={
                  view === item.id
                    ? "flex items-center gap-2 border-b-2 border-navy px-4 py-3 text-sm font-600 text-navy"
                    : "flex items-center gap-2 border-b-2 border-transparent px-4 py-3 text-sm font-500 text-ink-soft transition hover:text-navy"
                }
              >
                <Icon aria-hidden className="h-3.5 w-3.5" />
                {item.label}
              </button>
            );
          })}
        </nav>
      </header>

      <div className="mx-auto max-w-6xl space-y-4 px-6 py-8">
        {error && (
          <Notice className="text-sm text-ink-soft">
            Couldn&apos;t load dashboard data: {error}
          </Notice>
        )}
        {loading && <p className="text-ink-soft">Loading…</p>}

        {!loading && view === "overview" && data && <OverviewView data={data} />}
        {!loading && view === "parking" && data && <ParkingView data={data} />}
        {!loading && view === "vehicles" && <VehiclesView />}
        {!loading && view === "presence" && <PresenceView />}
        {!loading && view === "records" && <RecordsView />}
        {!loading && view === "directory" &&
          (selected ? (
            <PersonProfile
              personId={selected.id}
              name={selected.name}
              onBack={() => setSelected(null)}
            />
          ) : (
            <StudentsDirectory onView={(id, name) => setSelected({ id, name })} />
          ))}
        {!loading && view === "register" && <RegisterView />}
        {!loading && view === "accounts" && <AccountsView />}
      </div>
    </main>
  );
}
