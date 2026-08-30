"use client";

import { TfiLocationPin, TfiPieChart, TfiPulse, TfiServer } from "react-icons/tfi";
import SectionHeading from "@/components/SectionHeading";
import StatTile from "@/components/StatTile";
import { STATS, fmtClock, fmtDateTime, type AdminDashboard } from "./types";
import { useLiveOverview } from "./useLiveOverview";

export default function OverviewView({ data }: { data: AdminDashboard }) {
  const { live, status } = useLiveOverview();

  // Every field below exists in both payloads, so the poll substitutes for the
  // mount-time fetch one field at a time. `??` rather than `live ? ... : ...`
  // so a zero from a live poll is still a zero and not a fallback to a stale
  // count — the moment the last person taps out is exactly when this matters.
  const persons_inside = live?.persons_inside ?? data?.persons_inside;
  const vehicles_inside = live?.vehicles_inside ?? data?.vehicles_inside;
  const gadgets_inside = live?.gadgets_inside ?? data?.gadgets_inside;
  const granted_today = live?.granted_today ?? data?.granted_today;
  const denied_today = live?.denied_today ?? data?.denied_today;
  const recent_scans = live?.recent_scans ?? data?.recent_scans;
  const scan_events_today = live?.scan_events_today ?? data?.scan_events_today;

  return (
    <>
      {/* Column count tracks STATS.length — five tiles in a four-column grid
          leave one stranded on its own row. */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        {STATS.map((s) => (
          <StatTile
            key={s.key}
            label={s.label}
            // Only the scan counter moves between polls; the registered-person,
            // vehicle and device totals change when somebody registers one,
            // which /dashboard/live deliberately does not re-query.
            value={
              s.key === "scan_events_today"
                ? scan_events_today
                : data
                  ? data[s.key]
                  : undefined
            }
            icon={s.icon}
          />
        ))}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <section className="rounded-2xl border border-line bg-white p-5">
          <SectionHeading icon={TfiPieChart}>Access results today</SectionHeading>
          <div className="mt-3 flex gap-6">
            <div>
              <p className="font-display text-3xl font-700 text-blue">
                {granted_today ?? "—"}
              </p>
              <p className="text-[13px] text-ink-soft">Granted</p>
            </div>
            <div>
              {/* Orange marks the alarm as an underline rather than as the
                  number's colour — #ee7a22 on white is 2.8:1, under the 3:1
                  large-text floor. */}
              <p
                className={`font-display text-3xl font-700 text-ink ${
                  denied_today !== undefined && denied_today > 0
                    ? "underline decoration-red decoration-4 underline-offset-4"
                    : ""
                }`}
              >
                {denied_today ?? "—"}
              </p>
              <p className="text-[13px] text-ink-soft">Denied</p>
            </div>
          </div>
          <GrantedBar granted={granted_today ?? 0} denied={denied_today ?? 0} />
        </section>

        <section className="rounded-2xl border border-line bg-white p-5">
          <SectionHeading icon={TfiLocationPin}>Currently inside campus</SectionHeading>
          <div className="mt-3 flex items-end gap-6">
            <div>
              <p className="font-display text-4xl font-700 leading-none text-ink">
                {persons_inside ?? "—"}
              </p>
              <p className="mt-1.5 text-[13px] text-ink-soft">
                {persons_inside === 1 ? "person" : "persons"}
              </p>
            </div>
            <div className="border-l border-line pl-6">
              <p className="font-display text-2xl font-700 leading-none text-ink-soft">
                {vehicles_inside ?? "—"}
              </p>
              <p className="mt-1.5 text-[13px] text-ink-soft">
                {vehicles_inside === 1 ? "vehicle" : "vehicles"}
              </p>
            </div>
            <div className="border-l border-line pl-6">
              <p className="font-display text-2xl font-700 leading-none text-ink-soft">
                {gadgets_inside ?? "—"}
              </p>
              <p className="mt-1.5 text-[13px] text-ink-soft">
                {gadgets_inside === 1 ? "device" : "devices"}
              </p>
            </div>
          </div>
          {/* The dot must tell the truth about the transport, not just show
              a heartbeat: an admin staring at an unchanging count during an
              evacuation needs to know whether the campus is empty or the feed
              is down. */}
          <p className="mt-4 flex items-center gap-1.5 text-[12px] text-ink-soft">
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                status === "open"
                  ? "bg-blue"
                  : status === "reconnecting"
                    ? "bg-red"
                    : "bg-ink-soft/40"
              }`}
            />
            {status === "reconnecting"
              ? live
                ? `Reconnecting · last update ${fmtClock(live.as_of)}`
                : "Reconnecting…"
              : live
                ? `updated ${fmtClock(live.as_of)}`
                : "Connecting…"}
          </p>
        </section>
      </div>

      <section className="rounded-2xl border border-line bg-white p-5">
        <SectionHeading icon={TfiServer}>Gate status</SectionHeading>
        {data && data.gates.length > 0 ? (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-[14px]">
              <thead>
                <tr className="border-b border-line text-[12px] uppercase tracking-wide text-ink-soft">
                  <th className="py-2 font-600">Gate</th>
                  <th className="py-2 font-600">Type</th>
                  <th className="py-2 font-600">Location</th>
                  <th className="py-2 font-600">Last scan</th>
                  <th className="py-2 font-600">Status</th>
                </tr>
              </thead>
              <tbody>
                {data.gates.map((g) => (
                  <tr key={g.name} className="border-b border-line/60 last:border-0">
                    <td className="py-2.5 font-600 text-ink">{g.name}</td>
                    <td className="py-2.5 capitalize text-ink-soft">{g.type}</td>
                    <td className="py-2.5 text-ink-soft">{g.location ?? "—"}</td>
                    <td className="py-2.5 text-ink-soft">{fmtDateTime(g.last_scan)}</td>
                    <td className="py-2.5">
                      <span
                        className={`inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[12px] font-600 capitalize ${
                          g.status === "online"
                            ? "border border-blue bg-blue/25 text-ink"
                            : "bg-ink-soft/10 text-ink-soft"
                        }`}
                      >
                        <span
                          className={`h-1.5 w-1.5 rounded-full ${
                            g.status === "online" ? "bg-blue" : "bg-ink-soft"
                          }`}
                        />
                        {g.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="mt-3 text-[15px] text-ink-soft">No gates configured.</p>
        )}
      </section>

      <section className="rounded-2xl border border-line bg-white p-5">
        <SectionHeading icon={TfiPulse}>Recent scan activity</SectionHeading>
        {recent_scans && recent_scans.length > 0 ? (
          <ul className="mt-3 divide-y divide-line/60">
            {/* Keyed by the scan itself, not by index: the list is repopulated
                every poll, and an index key makes React rewrite each row in
                place instead of retiring the one that fell off the end. */}
            {recent_scans.map((s) => (
              <li
                key={`${s.scan_time}-${s.rfid_uid}-${s.direction}`}
                className="flex items-center justify-between gap-3 py-2.5 text-[14px]"
              >
                <div className="min-w-0">
                  <p className="flex items-center gap-1.5 truncate font-600 text-ink">
                    {s.name ?? <span className="font-mono text-ink-soft">{s.rfid_uid}</span>}
                    {/* Person is the overwhelming majority of taps and needs no
                        label; gadget and vehicle are the exceptions worth
                        calling out so a device tap doesn't read as a person. */}
                    {s.entity_type !== "person" && (
                      <span className="shrink-0 rounded-md bg-ink-soft/10 px-1.5 py-0.5 text-[10px] font-600 uppercase tracking-wide text-ink-soft">
                        {s.entity_type}
                      </span>
                    )}
                  </p>
                  <p className="text-[12px] text-ink-soft">
                    {s.gate} · <span className="capitalize">{s.direction}</span>
                    {s.reason ? ` · ${s.reason.replace(/_/g, " ")}` : ""}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-[12px] text-ink-soft">{fmtDateTime(s.scan_time)}</p>
                  {/* A pill, not bare coloured text: the palette's orange
                      cannot carry 12px text, so denial reads as a solid fill. */}
                  <span
                    className={`inline-block rounded-md px-2 py-0.5 text-[12px] font-600 capitalize ${
                      s.access_result === "granted"
                        ? "border border-blue bg-blue/25 text-ink"
                        : "border border-red bg-red/25 text-ink"
                    }`}
                  >
                    {s.access_result}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-[15px] text-ink-soft">No scan activity yet.</p>
        )}
      </section>
    </>
  );
}

function GrantedBar({ granted, denied }: { granted: number; denied: number }) {
  const total = granted + denied;
  const pct = total > 0 ? (granted / total) * 100 : 0;
  return (
    <div className="mt-4">
      <div className="h-2 w-full overflow-hidden rounded-full bg-red/15">
        <div className="h-full rounded-full bg-blue" style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-1.5 text-[12px] text-ink-soft">
        {total > 0 ? `${Math.round(pct)}% granted` : "No scans today"}
      </p>
    </div>
  );
}