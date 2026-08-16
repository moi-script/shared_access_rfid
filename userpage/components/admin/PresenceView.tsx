"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { apiGetList, apiPost } from "@/lib/auth";
import { fmtDateTime } from "./types";
import Notice from "@/components/Notice";
import SectionHeading from "@/components/SectionHeading";
import { TfiReload, TfiTime } from "react-icons/tfi";

interface PresenceRow {
  _id: string;
  entity_type: "person" | "vehicle";
  name: string | null;
  id_number?: string;
  gate: string;
  since: string;
}

const PAGE_LIMIT = 100;

export default function PresenceView() {
  const router = useRouter();
  const [rows, setRows] = useState<PresenceRow[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [clearing, setClearing] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  // A counter, not a boolean: `clear()` can trigger a `load()` while an
  // earlier `load()` (e.g. from Refresh) is still in flight. Without this, the
  // response that arrives last wins even if it was requested first, and a
  // guard could see a stale roster overwrite a fresh one.
  const requestIdRef = useRef(0);

  const load = useCallback(() => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    // The cache-buster query param defeats the browser's HTTP cache, which was
    // observed to replay a stale (pre-tap) /occupancy response for an
    // identical URL — a roster a guard checks during an evacuation cannot
    // afford to silently show yesterday's answer.
    apiGetList<PresenceRow>(`/occupancy?limit=${PAGE_LIMIT}&_=${Date.now()}`)
      .then((res) => {
        if (requestIdRef.current !== requestId) return;
        setRows(res.items);
        setTotal(res.total);
        setError(null);
        setUpdatedAt(new Date());
      })
      .catch((err: Error & { status?: number }) => {
        if (requestIdRef.current !== requestId) return;
        if (err.status === 401) {
          router.replace("/login");
          return;
        }
        setError(err.message);
      })
      .finally(() => {
        if (requestIdRef.current === requestId) setLoading(false);
      });
  }, [router]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- load() calls setLoading(true) synchronously, which only duplicates the useState(true) initial value on mount; the roster still must be fetched here since nothing server-rendered it first.
  useEffect(load, [load]);

  async function clear(id: string) {
    setClearing(id);
    try {
      await apiPost(`/occupancy/${id}/clear`, {});
    } catch (err) {
      const e = err as Error & { status?: number };
      // A 404 here means the row is already outside (someone else cleared it,
      // or the person tapped out in the meantime) — that is itself a signal
      // the on-screen roster is stale, not just an error to display next to a
      // row that claims otherwise. Falling through to `load()` in `finally`
      // refetches so the row disappears instead of stranding on screen.
      if (e.status !== 401) setError(e.message);
    } finally {
      setClearing(null);
      load();
    }
  }

  return (
    <section className="rounded-2xl border border-line bg-white p-5">
      <div className="flex items-center justify-between">
        <SectionHeading icon={TfiTime}>On campus now</SectionHeading>
        <div className="flex items-center gap-3">
          <span className="text-[12px] text-ink-soft">
            {loading ? "Loading…" : `${total} ${total === 1 ? "entry" : "entries"} on campus`}
          </span>
          <button
            onClick={load}
            disabled={loading}
            className="flex items-center gap-2 rounded-lg border border-line px-3 py-1.5 text-[13px] font-600 text-ink-soft transition hover:border-navy/40 hover:text-navy disabled:opacity-50"
          >
            <TfiReload aria-hidden className="h-3 w-3" />
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>

      <p className="mt-1 text-[13px] text-ink-soft">
        Anyone here has tapped in without tapping out. Clearing a row lets that card enter
        again — use it when someone left without tapping.
      </p>

      {!loading && rows.length < total && (
        <Notice tone="warn" compact className="mt-1 text-[13px] font-600 text-ink">
          Showing {rows.length} of {total} — narrow this down before treating it as complete.
        </Notice>
      )}

      {updatedAt && (
        <p className="mt-1 text-[12px] text-ink-soft">
          Updated {updatedAt.toLocaleTimeString()}
        </p>
      )}

      {error && <Notice className="mt-3 text-[14px] text-ink">{error}</Notice>}
      {loading && <p className="mt-3 text-ink-soft">Loading…</p>}

      {!loading && rows.length > 0 && (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-[14px]">
            <thead>
              <tr className="border-b border-line text-[12px] uppercase tracking-wide text-ink-soft">
                <th className="py-2 font-600">Name</th>
                <th className="py-2 font-600">ID</th>
                <th className="py-2 font-600">Type</th>
                <th className="py-2 font-600">Gate</th>
                <th className="py-2 font-600">Entered at</th>
                <th className="py-2 font-600"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r._id} className="border-b border-line/60 last:border-0">
                  <td className="py-2.5 font-600 text-ink">{r.name ?? "Unknown"}</td>
                  <td className="py-2.5 font-mono text-[13px] text-ink-soft">
                    {r.id_number ?? "—"}
                  </td>
                  <td className="py-2.5 capitalize text-ink-soft">{r.entity_type}</td>
                  <td className="py-2.5 text-ink-soft">{r.gate}</td>
                  <td className="py-2.5 text-ink-soft">{fmtDateTime(r.since)}</td>
                  <td className="py-2.5 text-right">
                    <button
                      onClick={() => clear(r._id)}
                      disabled={clearing === r._id}
                      className="rounded-lg border border-line px-3 py-1 text-[13px] font-600 text-ink-soft transition hover:border-red hover:bg-red/25 hover:text-ink disabled:opacity-50"
                    >
                      {clearing === r._id ? "Clearing…" : "Clear"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!loading && rows.length === 0 && !error && (
        <p className="mt-3 text-[15px] text-ink-soft">Nobody is currently on campus.</p>
      )}
    </section>
  );
}
