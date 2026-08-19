"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { API_BASE, apiGet, getToken } from "@/lib/auth";
import { subscribeLive, type LiveStatus } from "@/lib/liveStream";
import { reasonText } from "@/lib/reasonText";
import Notice from "@/components/Notice";
import { TfiReload } from "react-icons/tfi";

interface RecordRow {
  id: string;
  scan_time: string;
  direction: "entry" | "exit";
  access_result: "granted" | "denied";
  reason: string | null;
  gate: { id: string; name: string } | null;
  entity_type: "person" | "vehicle";
  subject: { full_name?: string; id_number?: string; plate_number?: string } | null;
  rfid_uid: string;
}

interface GateOption {
  _id: string;
  name: string;
}

interface Pagination {
  total: number;
  page: number;
  limit: number;
  pages: number;
}

const PAGE_LIMIT = 50;

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function RecordsView() {
  const router = useRouter();
  const [rows, setRows] = useState<RecordRow[]>([]);
  const [pagination, setPagination] = useState<Pagination>({
    total: 0,
    page: 1,
    limit: PAGE_LIMIT,
    pages: 1,
  });
  const [truncated, setTruncated] = useState(false);
  const [gates, setGates] = useState<GateOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [gateId, setGateId] = useState("");
  const [direction, setDirection] = useState("");
  const [accessResult, setAccessResult] = useState("");
  const [page, setPage] = useState(1);

  const [streamStatus, setStreamStatus] = useState<LiveStatus>("connecting");
  // Taps that arrived while auto-refresh was paused. Counted rather than
  // applied, so the reader decides when the table moves under them.
  const [heldBack, setHeldBack] = useState(0);

  // A counter, not a boolean: a filter change (or Refresh) can fire a new
  // request while an earlier one is still in flight. Without this, a
  // first-requested/last-arriving reply overwrites fresher data — the same
  // defect an earlier review found in PresenceView.
  const gen = useRef(0);

  // The gate filter is a convenience dropdown, not the data this screen
  // exists to show — its failure shouldn't block the log itself.
  useEffect(() => {
    apiGet<GateOption[]>("/gates")
      .then(setGates)
      .catch(() => undefined);
  }, []);

  const load = useCallback(async () => {
    const mine = ++gen.current;
    setLoading(true);
    setError(null);
    try {
      const p = new URLSearchParams();
      p.set("page", String(page));
      p.set("limit", String(PAGE_LIMIT));
      if (from) p.set("from", from);
      if (to) p.set("to", to);
      if (gateId) p.set("gate_id", gateId);
      if (direction) p.set("direction", direction);
      if (accessResult) p.set("access_result", accessResult);

      const token = getToken();
      const res = await fetch(`${API_BASE}/logs?${p.toString()}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        credentials: "include",
      });
      const body = (await res.json().catch(() => null)) as
        | {
            success: true;
            data: RecordRow[];
            meta: { pagination: Pagination; truncated: boolean };
          }
        | { success: false; code?: string; message?: string }
        | null;

      if (mine !== gen.current) return;

      if (!res.ok || !body || body.success !== true) {
        const failure = body as { code?: string; message?: string } | null;
        const err = new Error(failure?.message ?? "Request failed") as Error & {
          status?: number;
        };
        err.status = res.status;
        throw err;
      }

      setRows(body.data);
      setPagination(body.meta.pagination);
      setTruncated(body.meta.truncated);
      // Any completed load — auto, manual, filter change, page change — makes
      // a held-back count meaningless: whatever it was counting is either on
      // screen now or does not match the current filters. Clearing it here
      // rather than in an effect keeps "the badge is stale" impossible by
      // construction.
      setHeldBack(0);
    } catch (err) {
      if (mine !== gen.current) return;
      const e = err as Error & { status?: number };
      if (e.status === 401) {
        router.replace("/login");
        return;
      }
      setError(e.message);
    } finally {
      if (mine === gen.current) setLoading(false);
    }
  }, [page, from, to, gateId, direction, accessResult, router]);

  useEffect(() => {
    // Debounce so filter changes don't fire a request per keystroke/click.
    const t = setTimeout(() => void load(), 250);
    return () => {
      clearTimeout(t);
      // `gen` is a plain counter ref, not a DOM node — bumping it on every
      // cleanup invalidates any response from an in-flight request that a
      // newer filter change has already superseded.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      gen.current++;
    };
  }, [load]);

  /**
   * Auto-refresh is only safe on the first page of a still-open range.
   *
   * A new tap shifts every row down by one. On page 3 that silently swaps the
   * rows out from under whoever is reading them, and against a closed date
   * range (`to` set) the incoming tap does not even belong in the result — the
   * table would reload to show exactly what it already showed. Both cases hold
   * the update instead and offer it, which is why `heldBack` is a count and
   * not a boolean.
   */
  const autoRefreshable = page === 1 && !to;

  // Read through a ref inside the subscription: the handler must see the
  // CURRENT eligibility and loader without the subscription itself tearing
  // down and reconnecting the shared stream every time a filter changes.
  const liveRef = useRef({ autoRefreshable, load });
  useEffect(() => {
    liveRef.current = { autoRefreshable, load };
  }, [autoRefreshable, load]);

  useEffect(() => {
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const stop = subscribeLive(
      (e) => {
        if (e.type !== "update") return; // the snapshot is just current state
        if (!liveRef.current.autoRefreshable) {
          setHeldBack((n) => n + 1);
          return;
        }
        // The server already coalesces a tap burst into roughly one frame per
        // 250ms; this second, shorter debounce covers the case where several
        // frames still land back to back, so /logs is queried once for them.
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => void liveRef.current.load(), 150);
      },
      (st) => {
        setStreamStatus(st);
        if (st === "unauthorized") router.replace("/login");
      },
    );
    return () => {
      if (debounce) clearTimeout(debounce);
      stop();
    };
  }, [router]);


  function setFilter<T>(setter: (v: T) => void) {
    return (v: T) => {
      setter(v);
      setPage(1); // A new filter invalidates whatever page we were on.
    };
  }

  const setFromFilter = setFilter(setFrom);
  const setToFilter = setFilter(setTo);
  const setGateFilter = setFilter(setGateId);
  const setDirectionFilter = setFilter(setDirection);
  const setResultFilter = setFilter(setAccessResult);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="font-display text-xl font-700 text-navy">Records</h1>
        <p className="text-sm text-ink-soft">
          Every entry and exit tap, granted or denied, across every gate.
        </p>
      </div>

      {error && (
        <Notice className="text-sm text-ink">{error}</Notice>
      )}

      <div className="flex flex-wrap items-end gap-3 rounded-2xl border border-line bg-white p-5">
        <label className="text-xs font-600 uppercase tracking-[0.12em] text-ink-soft">
          From
          <input
            type="date"
            value={from}
            onChange={(e) => setFromFilter(e.target.value)}
            disabled={loading}
            className="mt-1 block rounded-xl border border-line bg-white px-3 py-2 text-sm text-ink disabled:opacity-50"
          />
        </label>

        <label className="text-xs font-600 uppercase tracking-[0.12em] text-ink-soft">
          To
          <input
            type="date"
            value={to}
            onChange={(e) => setToFilter(e.target.value)}
            disabled={loading}
            className="mt-1 block rounded-xl border border-line bg-white px-3 py-2 text-sm text-ink disabled:opacity-50"
          />
        </label>

        <label className="text-xs font-600 uppercase tracking-[0.12em] text-ink-soft">
          Gate
          <select
            value={gateId}
            onChange={(e) => setGateFilter(e.target.value)}
            disabled={loading}
            className="mt-1 block rounded-xl border border-line bg-white px-3 py-2 text-sm text-ink disabled:opacity-50"
          >
            <option value="">All gates</option>
            {gates.map((g) => (
              <option key={g._id} value={g._id}>
                {g.name}
              </option>
            ))}
          </select>
        </label>

        <label className="text-xs font-600 uppercase tracking-[0.12em] text-ink-soft">
          Direction
          <select
            value={direction}
            onChange={(e) => setDirectionFilter(e.target.value)}
            disabled={loading}
            className="mt-1 block rounded-xl border border-line bg-white px-3 py-2 text-sm text-ink capitalize disabled:opacity-50"
          >
            <option value="">All</option>
            <option value="entry">Entry</option>
            <option value="exit">Exit</option>
          </select>
        </label>

        <label className="text-xs font-600 uppercase tracking-[0.12em] text-ink-soft">
          Result
          <select
            value={accessResult}
            onChange={(e) => setResultFilter(e.target.value)}
            disabled={loading}
            className="mt-1 block rounded-xl border border-line bg-white px-3 py-2 text-sm text-ink capitalize disabled:opacity-50"
          >
            <option value="">All</option>
            <option value="granted">Granted</option>
            <option value="denied">Denied</option>
          </select>
        </label>

        <div className="ml-auto flex items-center gap-3">
          <span className="flex items-center gap-1.5 text-[12px] text-ink-soft">
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                streamStatus === "reconnecting"
                  ? "bg-red"
                  : streamStatus === "open" && autoRefreshable
                    ? "bg-blue"
                    : "bg-ink-soft/40"
              }`}
            />
            {streamStatus === "reconnecting"
              ? "Reconnecting"
              : streamStatus !== "open"
                ? "Connecting"
                : autoRefreshable
                  ? "Live"
                  : to
                    ? "Paused · closed date range"
                    : `Paused · page ${page}`}
          </span>

          {heldBack > 0 && (
            <button
              onClick={() => {
                // Page 1 is the only place the new taps can appear. If we are
                // already there, load() alone does it — setPage would not
                // change state and so would not retrigger the load effect.
                if (page === 1) void load();
                else setPage(1);
              }}
              className="rounded-full border border-blue bg-blue/25 px-3 py-1 text-[12px] font-600 text-ink transition hover:bg-blue/40"
            >
              {heldBack} new {heldBack === 1 ? "tap" : "taps"} — show
            </button>
          )}

          <button
            onClick={() => void load()}
            disabled={loading}
            className="flex items-center gap-2 rounded-lg border border-line px-3 py-1.5 text-[13px] font-600 text-ink-soft transition hover:border-navy/40 hover:text-navy disabled:opacity-50"
          >
            <TfiReload aria-hidden className="h-3 w-3" />
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>

      {!loading && truncated && (
        <Notice tone="warn" compact className="text-[13px] font-600 text-ink">
          Showing {rows.length} of {pagination.total} — narrow this down before treating it as
          complete.
        </Notice>
      )}

      <div className="overflow-x-auto rounded-2xl border border-line bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs uppercase tracking-[0.12em] text-ink-soft">
              <th className="px-4 py-3">Time</th>
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Gate</th>
              <th className="px-4 py-3">Direction</th>
              <th className="px-4 py-3">Result</th>
              <th className="px-4 py-3">Reason</th>
            </tr>
          </thead>
          <tbody>
            {loading && rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-ink-soft">
                  Loading…
                </td>
              </tr>
            )}
            {!loading && rows.length === 0 && !error && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-ink-soft">
                  No records match these filters.
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-line/60 last:border-0">
                <td className="px-4 py-3 text-ink-soft">{fmtTime(r.scan_time)}</td>
                <td className="px-4 py-3 font-500 text-ink">
                  {r.subject?.full_name ?? r.subject?.plate_number ?? "Unknown card"}
                </td>
                <td className="px-4 py-3 text-ink-soft">{r.gate?.name ?? "Manual override"}</td>
                <td className="px-4 py-3 capitalize text-ink-soft">{r.direction}</td>
                <td className="px-4 py-3">
                  <span
                    className={
                      r.access_result === "granted"
                        ? "rounded-full border border-blue bg-blue/25 px-2 py-1 text-xs font-600 text-ink"
                        : "rounded-full border border-red bg-red/25 px-2 py-1 text-xs font-600 text-ink"
                    }
                  >
                    {r.access_result === "granted" ? "Granted" : "Denied"}
                  </span>
                </td>
                <td className="px-4 py-3 text-ink-soft">
                  {r.reason ? reasonText(r.reason) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between text-[13px] text-ink-soft">
        <span>
          {pagination.total > 0
            ? `Page ${pagination.page} of ${pagination.pages} — ${pagination.total} total`
            : "No records"}
        </span>
        <div className="flex gap-2">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={loading || pagination.page <= 1}
            className="rounded-lg border border-line px-3 py-1.5 font-600 text-ink-soft transition hover:border-navy/40 hover:text-navy disabled:opacity-40"
          >
            Previous
          </button>
          <button
            onClick={() => setPage((p) => Math.min(pagination.pages, p + 1))}
            disabled={loading || pagination.page >= pagination.pages}
            className="rounded-lg border border-line px-3 py-1.5 font-600 text-ink-soft transition hover:border-navy/40 hover:text-navy disabled:opacity-40"
          >
            Next
          </button>
        </div>
      </div>
    </div>
  );
}
