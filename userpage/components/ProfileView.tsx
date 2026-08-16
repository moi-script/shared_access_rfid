import type { ReactNode } from "react";
import {
  TfiCar,
  TfiCheckBox,
  TfiDesktop,
  TfiNa,
  TfiPulse,
  TfiAgenda,
  TfiTime,
  TfiTimer,
} from "react-icons/tfi";
import { PersonAvatar } from "@/components/AuthedImage";
import Notice from "@/components/Notice";
import SectionHeading from "@/components/SectionHeading";
import StatTile from "@/components/StatTile";
import { gadgetTypeLabel, type GadgetType } from "@/lib/gadgetTypes";

export interface AttendanceRow {
  date: string;
  time_in: string | null;
  time_out: string | null;
  status: "present" | "late" | "absent";
}

export interface ScanRow {
  gate: string;
  direction: "entry" | "exit";
  access_result: "granted" | "denied";
  scan_time: string;
}

export interface PersonOverview {
  person: {
    full_name: string;
    type: string;
    id_number: string;
    department_section: string | null;
    contact_email: string | null;
    rfid_uid: string;
    status: string;
    photo_url?: string | null;
    createdAt?: string;
  } | null;
  today: { time_in: string | null; time_out: string | null; status: string } | null;
  attendance_summary: { present: number; late: number; absent: number };
  recent_attendance: AttendanceRow[];
  vehicles: {
    plate_number: string;
    vehicle_type: string;
    vehicle_model: string | null;
    rfid_uid: string;
    status: string;
  }[];
  gadgets: {
    // GadgetType, not string: gadgetTypeLabel() is typed to the union, and the
    // server projects straight off a Mongoose enum, so widening to string here
    // only buys a cast at the call site.
    gadget_type: GadgetType;
    brand_model: string;
    serial_number: string;
    status: string;
  }[];
  recent_scans: ScanRow[];
}

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
const statusStyle: Record<string, string> = {
  present: "border border-blue bg-blue/25 text-ink",
  late: "border border-gold bg-gold/25 text-ink",
  absent: "border border-red bg-red/25 text-ink",
};

/** Full person profile: identity, attendance, vehicle, recent activity.
 * Used both by a student's own dashboard and by the admin's per-person view. */
export default function ProfileView({ data }: { data: PersonOverview }) {
  const p = data.person;
  const kindLabel = p?.type === "student" ? "Student" : p?.type === "staff" ? "Staff" : "Member";

  return (
    <div className="space-y-4">
      {/* Identity */}
      <section className="rounded-2xl border border-line bg-white p-6">
        <div className="flex flex-wrap items-center gap-4">
          <div className="grid h-24 w-24 shrink-0 place-items-center overflow-hidden rounded-xl border border-line bg-paper text-ink-soft">
            {p ? (
              <PersonAvatar person={p} />
            ) : (
              <span className="font-display text-xl font-700 text-ink-soft">?</span>
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h1 className="font-display text-2xl font-700 tracking-tight text-ink">
                {p?.full_name ?? "Unknown"}
              </h1>
              {p && (
                <span
                  className={`rounded-md px-2 py-0.5 text-[12px] font-600 capitalize ${
                    p.status === "active" ? "border border-blue bg-blue/25 text-ink" : "border border-red bg-red/25 text-ink"
                  }`}
                >
                  {p.status}
                </span>
              )}
            </div>
            <p className="mt-0.5 text-[15px] text-ink-soft">
              {kindLabel} · <span className="font-600 text-ink">{p?.id_number}</span>
            </p>
          </div>
        </div>

        <dl className="mt-5 grid gap-x-6 gap-y-3 border-t border-line pt-5 text-[14px] sm:grid-cols-2">
          <Field label="Department / Section" value={p?.department_section} />
          <Field label="Email" value={p?.contact_email} />
          <Field label="RFID card UID" value={p?.rfid_uid} mono />
          <Field label="ID number" value={p?.id_number} mono />
        </dl>
      </section>

      {/* Attendance summary */}
      <section className="grid grid-cols-3 gap-4">
        <StatTile label="Present" value={data.attendance_summary.present} icon={TfiCheckBox} />
        <StatTile label="Late" value={data.attendance_summary.late} icon={TfiTimer} />
        <StatTile label="Absent" value={data.attendance_summary.absent} icon={TfiNa} />
      </section>

      {/* Today + vehicle */}
      <div className="grid gap-4 sm:grid-cols-2">
        <section className="rounded-2xl border border-line bg-white p-5">
          <SectionHeading icon={TfiTime}>Today&apos;s attendance</SectionHeading>
          {data.today ? (
            <div className="mt-3 flex items-end justify-between">
              <div className="space-y-1 text-[15px]">
                <p className="text-ink-soft">
                  Time in: <span className="font-600 text-ink">{fmtTime(data.today.time_in)}</span>
                </p>
                <p className="text-ink-soft">
                  Time out: <span className="font-600 text-ink">{fmtTime(data.today.time_out)}</span>
                </p>
              </div>
              <span
                className={`rounded-lg px-2.5 py-1 text-[12px] font-600 capitalize ${
                  statusStyle[data.today.status] ?? "border border-blue bg-blue/25 text-ink"
                }`}
              >
                {data.today.status}
              </span>
            </div>
          ) : (
            <p className="mt-3 text-[15px] text-ink-soft">No scan recorded today.</p>
          )}
        </section>

        <section className="rounded-2xl border border-line bg-white p-5">
          <SectionHeading icon={TfiCar}>Registered vehicles</SectionHeading>
          {data.vehicles.length > 0 ? (
            <ul className="mt-3 space-y-3">
              {data.vehicles.map((v, i) => (
                <li
                  key={`${v.plate_number}-${i}`}
                  className={i > 0 ? "border-t border-line/60 pt-3" : ""}
                >
                  <div className="space-y-2 text-[15px]">
                    <div className="flex items-center justify-between">
                      <span className="font-mono font-700 text-ink">{v.plate_number}</span>
                      <span className="rounded-lg border border-blue bg-blue/25 px-2.5 py-1 text-[12px] font-600 capitalize text-ink">
                        {v.status}
                      </span>
                    </div>
                    <p className="text-ink-soft">
                      {v.vehicle_type}
                      {v.vehicle_model ? ` · ${v.vehicle_model}` : ""}
                    </p>
                    <p className="font-mono text-[12px] text-ink-soft">{v.rfid_uid}</p>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-[15px] text-ink-soft">No vehicle on file.</p>
          )}
        </section>

        <section className="rounded-2xl border border-line bg-white p-5">
          <SectionHeading icon={TfiDesktop}>Registered devices</SectionHeading>
          {(data.gadgets ?? []).length > 0 ? (
            <ul className="mt-3 space-y-3">
              {(data.gadgets ?? []).map((g, i) => (
                <li
                  key={`${g.serial_number}-${i}`}
                  className={i > 0 ? "border-t border-line/60 pt-3" : ""}
                >
                  <div className="space-y-2 text-[15px]">
                    <div className="flex items-center justify-between">
                      <span className="font-mono font-700 text-ink">{g.serial_number}</span>
                      <span
                        className={`rounded-lg px-2.5 py-1 text-[12px] font-600 capitalize ${
                          g.status === "active"
                            ? "border border-blue bg-blue/25 text-ink"
                            : "border border-red bg-red/25 text-ink"
                        }`}
                      >
                        {g.status}
                      </span>
                    </div>
                    <p className="text-ink-soft">
                      {gadgetTypeLabel(g.gadget_type)} · {g.brand_model}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-[15px] text-ink-soft">No device on file.</p>
          )}
        </section>
      </div>

      {/* Recent attendance */}
      <section className="rounded-2xl border border-line bg-white p-5">
        <SectionHeading icon={TfiAgenda}>Recent attendance</SectionHeading>
        {data.recent_attendance.length > 0 ? (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-[14px]">
              <thead>
                <tr className="border-b border-line text-[12px] uppercase tracking-wide text-ink-soft">
                  <th className="py-2 font-600">Date</th>
                  <th className="py-2 font-600">Time in</th>
                  <th className="py-2 font-600">Time out</th>
                  <th className="py-2 font-600">Status</th>
                </tr>
              </thead>
              <tbody>
                {data.recent_attendance.map((r) => (
                  <tr key={r.date} className="border-b border-line/60 last:border-0">
                    <td className="py-2.5 text-ink">{r.date}</td>
                    <td className="py-2.5 text-ink-soft">{fmtTime(r.time_in)}</td>
                    <td className="py-2.5 text-ink-soft">{fmtTime(r.time_out)}</td>
                    <td className="py-2.5">
                      <span
                        className={`rounded-md px-2 py-0.5 text-[12px] font-600 capitalize ${
                          statusStyle[r.status] ?? "border border-blue bg-blue/25 text-ink"
                        }`}
                      >
                        {r.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="mt-3 text-[15px] text-ink-soft">No attendance history yet.</p>
        )}
      </section>

      {/* Recent gate taps */}
      <section className="rounded-2xl border border-line bg-white p-5">
        <SectionHeading icon={TfiPulse}>Recent gate taps</SectionHeading>
        {data.recent_scans.length > 0 ? (
          <ul className="mt-3 divide-y divide-line/60">
            {data.recent_scans.map((s, i) => (
              <li key={i} className="flex items-center justify-between py-2.5 text-[14px]">
                <div className="flex items-center gap-3">
                  <span
                    className={`grid h-8 w-8 place-items-center rounded-lg text-[13px] ${
                      s.direction === "entry"
                        ? "border border-blue bg-blue/25 text-ink"
                        : "bg-ink-soft/10 text-ink-soft"
                    }`}
                  >
                    {s.direction === "entry" ? "↓" : "↑"}
                  </span>
                  <div>
                    <p className="font-600 text-ink">{s.gate}</p>
                    <p className="text-[12px] capitalize text-ink-soft">{s.direction}</p>
                  </div>
                </div>
                <div className="text-right">
                  <p className="text-[12px] text-ink-soft">{fmtDateTime(s.scan_time)}</p>
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
          <p className="mt-3 text-[15px] text-ink-soft">No gate activity yet.</p>
        )}
      </section>
    </div>
  );
}

function Field({ label, value, mono }: { label: string; value?: string | null; mono?: boolean }) {
  return (
    <div>
      <dt className="text-[12px] uppercase tracking-wide text-ink-soft">{label}</dt>
      <dd className={`mt-0.5 text-ink ${mono ? "font-mono text-[13px]" : ""}`}>{value ?? "—"}</dd>
    </div>
  );
}

export function InfoBanner({ children }: { children: ReactNode }) {
  return <Notice className="text-[14px] text-ink">{children}</Notice>;
}
