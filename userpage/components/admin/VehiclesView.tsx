"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiGet, apiPatch } from "@/lib/auth";
import { VEHICLE_TYPES } from "@/lib/vehicleTypes";
import Notice from "@/components/Notice";
import SectionHeading from "@/components/SectionHeading";
import { TfiCar } from "react-icons/tfi";

/**
 * The owner as GET /vehicles now joins it. Deleting a person is a soft
 * delete (persons.service.ts softDelete sets deleted_at, leaves the doc in
 * place), and .populate() issues its own query outside personRepo's
 * notDeleted filter — there's no schema-level middleware enforcing it
 * either — so a soft-deleted owner still populates normally, with a real
 * full_name. `null` only happens for a dangling reference (an
 * owner_person_id whose document no longer exists at all), which nothing in
 * this codebase currently produces. The `| null` type and the "— (deleted)"
 * fallback below are defensive for that case, not a path the app reaches
 * normally — keep them rather than treating them as dead code.
 */
interface VehicleOwner {
  _id: string;
  full_name: string;
  id_number: string;
  type: string;
}

interface VehicleRow {
  _id: string;
  plate_number: string;
  rfid_uid: string;
  vehicle_type: string;
  make?: string;
  vehicle_model?: string;
  valid_until: string;
  status: "active" | "inactive";
  owner_person_id: VehicleOwner | null;
}

type Badge = "active" | "expired" | "inactive";

/**
 * A vehicle may be stored `active` and still be past its expiry. The gate calls
 * that unusable — vehicleRepo.findActiveByOwner filters on status AND
 * valid_until — so showing the stored field alone would tell a clerk the
 * opposite of what the barrier does. Presentational only: nothing writes
 * "expired", and the toggle still sends active/inactive.
 *
 * A missing or unparsable valid_until makes `new Date(...)` produce an
 * Invalid Date, and `Invalid Date < Date` is always false (NaN comparison),
 * which would silently read as "active". Rows like that exist (see the
 * legacy-vehicle block in verifyRoles.ts, which asserts the gate denies one
 * with no valid_until via vehicle_expired), so this must fail safe toward
 * what the barrier actually does — treat unparsable as expired — rather
 * than defaulting to a reassuring "active".
 */
function badgeOf(v: VehicleRow): Badge {
  if (v.status === "inactive") return "inactive";
  const t = new Date(v.valid_until).getTime();
  return Number.isNaN(t) || t < Date.now() ? "expired" : "active";
}

const BADGE_CLS: Record<Badge, string> = {
  active: "border border-blue bg-blue/25 text-ink",
  expired: "bg-gold/40 text-ink",
  inactive: "bg-ink-soft/10 text-ink-soft",
};

const selectCls =
  "rounded-xl border border-line bg-white px-3 py-2 text-[14px] text-ink outline-none focus:border-blue focus:ring-4 focus:ring-blue/12";

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export default function VehiclesView() {
  const [rows, setRows] = useState<VehicleRow[]>([]);
  const [type, setType] = useState("");
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Keyed by vehicle id, not a single boolean: one slow row must not freeze the
  // whole table, and a double-click must not queue two writes for the same row.
  const [busyId, setBusyId] = useState<string | null>(null);
  const gen = useRef(0);

  const load = useCallback(async () => {
    const mine = ++gen.current;
    setError(null);
    try {
      const p = new URLSearchParams();
      if (type) p.set("vehicle_type", type);
      if (status) p.set("status", status);
      if (search.trim()) p.set("search", search.trim());
      p.set("limit", "100");
      const list = await apiGet<VehicleRow[]>(`/vehicles?${p.toString()}`);
      if (mine !== gen.current) return; // a newer load started; discard this
      setRows(list);
    } catch (err) {
      if (mine !== gen.current) return;
      setError((err as Error).message);
    } finally {
      if (mine === gen.current) setLoading(false);
    }
  }, [type, status, search]);

  useEffect(() => {
    // Debounced so typing in the search box doesn't fire a request per keystroke.
    const t = setTimeout(() => void load(), 250);
    return () => {
      clearTimeout(t);
      // `gen` is a plain counter ref, not a DOM node, so there is no stale-node
      // hazard here — bumping it on every cleanup is what invalidates in-flight
      // responses after unmount or filter change.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      gen.current++;
    };
  }, [load]);

  async function toggle(row: VehicleRow) {
    setBusyId(row._id);
    // Tracked locally, not via setError, because load() (called below,
    // regardless of outcome) starts with its own setError(null). Setting
    // React state here and then immediately calling load() would let that
    // reset land in the same commit as this one, batched away before the
    // browser ever paints it. Re-applying it as state AFTER load() has fully
    // settled guarantees it is the last write and therefore the one shown.
    let toggleError: string | null = null;
    try {
      await apiPatch(`/vehicles/${row._id}/status`, {
        status: row.status === "active" ? "inactive" : "active",
      });
    } catch (err) {
      // Reactivation legitimately fails when the owner has since filled that
      // type. The server already words it with the owner's name and the
      // type-correct plural, so it is shown verbatim rather than re-composed.
      toggleError = (err as Error).message;
    } finally {
      setBusyId(null);
      // Reload regardless of outcome: a failed toggle can still mean the
      // on-screen list is stale, e.g. someone else changed the same row.
      await load();
      if (toggleError) setError(toggleError);
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="font-display text-xl font-700 text-navy">Vehicles</h1>
        <p className="text-sm text-ink-soft">
          Deactivating a vehicle frees the owner&apos;s slot for that type and stops its
          RFID sticker at the barrier. The registration is kept, so you can reactivate it
          later.
        </p>
      </div>

      {error && <Notice className="text-sm text-ink">{error}</Notice>}

      <section className="rounded-2xl border border-line bg-white p-5">
        <SectionHeading icon={TfiCar}>Registered vehicles</SectionHeading>

        <div className="mt-3 flex flex-wrap gap-2">
          <select value={type} onChange={(e) => setType(e.target.value)} className={selectCls}>
            <option value="">All types</option>
            {VEHICLE_TYPES.map((t) => (
              <option key={t} value={t} className="capitalize">
                {t}
              </option>
            ))}
          </select>
          <select value={status} onChange={(e) => setStatus(e.target.value)} className={selectCls}>
            <option value="">All statuses</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search plate or RFID UID…"
            className={`min-w-[16rem] flex-1 ${selectCls}`}
          />
        </div>

        {loading && <p className="mt-3 text-[15px] text-ink-soft">Loading…</p>}

        {!loading && rows.length === 0 && (
          <p className="mt-3 text-[15px] text-ink-soft">No vehicles match those filters.</p>
        )}

        {!loading && rows.length > 0 && (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-[14px]">
              <thead>
                <tr className="border-b border-line text-[12px] uppercase tracking-wide text-ink-soft">
                  <th className="py-2 font-600">Plate</th>
                  <th className="py-2 font-600">Vehicle</th>
                  <th className="py-2 font-600">Owner</th>
                  <th className="py-2 font-600">Valid until</th>
                  <th className="py-2 font-600">Status</th>
                  <th className="py-2 font-600">
                    <span className="sr-only">Action</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((v) => {
                  const badge = badgeOf(v);
                  const busy = busyId === v._id;
                  return (
                    <tr key={v._id} className="border-b border-line/60 last:border-0">
                      <td className="py-2.5 font-mono text-[13px] font-600 text-ink">
                        {v.plate_number}
                      </td>
                      <td className="py-2.5 text-ink">
                        <span className="capitalize">{v.vehicle_type}</span>
                        {(v.make || v.vehicle_model) && (
                          <span className="text-ink-soft">
                            {" · "}
                            {[v.make, v.vehicle_model].filter(Boolean).join(" ")}
                          </span>
                        )}
                      </td>
                      <td className="py-2.5 text-ink">
                        {v.owner_person_id ? (
                          <>
                            <span className="font-600">{v.owner_person_id.full_name}</span>{" "}
                            <span className="text-ink-soft">
                              · {v.owner_person_id.id_number}
                            </span>
                          </>
                        ) : (
                          <span className="text-ink-soft">— (deleted)</span>
                        )}
                      </td>
                      <td className="py-2.5 text-ink-soft">{fmtDate(v.valid_until)}</td>
                      <td className="py-2.5">
                        <span
                          className={`rounded-md px-2 py-0.5 text-[12px] font-600 capitalize ${BADGE_CLS[badge]}`}
                        >
                          {badge}
                        </span>
                      </td>
                      <td className="py-2.5 text-right">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void toggle(v)}
                          className="rounded-lg border border-line bg-white px-3 py-1.5 text-[13px] font-600 text-ink-soft transition hover:border-navy hover:text-navy disabled:opacity-60"
                        >
                          {busy
                            ? "Saving…"
                            : v.status === "active"
                              ? "Deactivate"
                              : "Reactivate"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
