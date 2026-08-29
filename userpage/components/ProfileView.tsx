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
import AuthedImage, { PersonAvatar } from "@/components/AuthedImage";
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
    id: string;
    plate_number: string;
    vehicle_type: string;
    vehicle_model: string | null;
    rfid_uid: string;
    status: string;
    /** Present once a vehicle photo has been uploaded (VehicleEditForm /
     *  VehicleApplicationForm). Fetched from GET /vehicles/:id/photo, which
     *  requires auth — this field is only used as a flag to decide whether
     *  that request is worth making at all. */
    photo_url?: string | null;
  }[];
  gadgets: {
    // GadgetType, not string: gadgetTypeLabel() is typed to the union, and the
    // server projects straight off a Mongoose enum, so widening to string here
    // only buys a cast at the call site.
    id: string;
    gadget_type: GadgetType;
    brand_model: string;
    serial_number: string;
    /** Nullable, unlike a vehicle's: a device can be registered before its
     *  sticker arrives, and is then carried with no tag of its own. */
    rfid_uid: string | null;
    /** On campus right now, by the same rule the exit terminal applies. */
    inside: boolean;
    status: string;
    /** Present once a gadget photo has been uploaded (GadgetEditForm /
     *  GadgetForm). Fetched from GET /gadgets/:id/photo — same flag role as
     *  the vehicle field above. */
    photo_url?: string | null;
  }[];
  recent_scans: ScanRow[];
}

/** What VehicleEditForm needs to prefill, minus the id (passed separately). */
interface VehicleEditSeed {
  plate_number: string;
  vehicle_type: string;
  vehicle_model: string | null;
  rfid_uid: string;
}

/** What GadgetEditForm needs to prefill, minus the id (passed separately). */
interface GadgetEditSeed {
  gadget_type: GadgetType;
  brand_model: string;
  serial_number: string;
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

/**
 * Small fixed-size thumbnail shared by the vehicle and gadget cards below.
 * Only calls AuthedImage (an authenticated fetch) when `photoUrl` is
 * present — a vehicle/gadget with no photo on file falls straight to the
 * icon instead of firing a request that will only 404, mirroring how
 * PersonAvatar/classifyPhotoUrl decide whether to fetch at all.
 */
function EntityThumb({
  path,
  photoUrl,
  alt,
  icon: Icon,
}: {
  path: string;
  photoUrl?: string | null;
  alt: string;
  icon: typeof TfiCar;
}) {
  return (
    <div className="grid h-16 w-24 shrink-0 place-items-center overflow-hidden rounded-lg border border-line bg-paper text-ink-soft">
      {photoUrl ? (
        <AuthedImage
          path={path}
          alt={alt}
          className="h-full w-full object-cover"
          fallback={<Icon aria-hidden className="h-6 w-6" />}
        />
      ) : (
        <Icon aria-hidden className="h-6 w-6" />
      )}
    </div>
  );
}

/** Full person profile: identity, attendance, vehicle, recent activity.
 * Used both by a student's own dashboard and by the admin's per-person view. */
export default function ProfileView({
  data,
  onReplaceTag,
  onEditVehicle,
  onEditGadget,
}: {
  /**
   * Optional/nullable on purpose, even though every intended caller (e.g.
   * PersonProfile) already guards with `{data && <ProfileView .../>}`: this
   * component has at least one other render path (seen via AdminShell in
   * production) that mounts it before its fetch resolves. Rather than rely
   * on every current and future caller getting that guard right, ProfileView
   * renders its own loading state when `data` isn't there yet instead of
   * throwing on `data.person`.
   */
  data?: PersonOverview | null;
  /**
   * Supplied only by the admin directory (PersonProfile). Absent on a student's
   * own dashboard, which renders this same component — so the buttons are gated
   * by whether the caller can act at all, not by a role check repeated here.
   */
  onReplaceTag?: (kind: "gadget", id: string, label: string, currentUid: string | null) => void;
  /**
   * Opens VehicleEditForm for the given row. Not gated on gadget write
   * authority — vehicle writes are a separate domain — so PersonProfile
   * passes this unconditionally; the server's assertCanWrite('vehicle') is
   * the real check, this only decides whether the button renders.
   */
  onEditVehicle?: (id: string, current: VehicleEditSeed) => void;
  /**
   * Opens GadgetEditForm for the given row. Passed only when this operator
   * may write to the gadget domain, mirroring onReplaceTag above.
   */
  onEditGadget?: (id: string, current: GadgetEditSeed) => void;
}) {
  // See the `data` prop comment above: this is the fallback for a caller
  // that mounts ProfileView before its overview fetch has resolved.
  if (!data) {
    return (
      <div className="rounded-2xl border border-line bg-white p-6 text-[15px] text-ink-soft">
        Loading profile…
      </div>
    );
  }

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
                  <div className="flex gap-3">
                    <EntityThumb
                      path={`/vehicles/${v.id}/photo`}
                      photoUrl={v.photo_url}
                      alt={`${v.plate_number} photo`}
                      icon={TfiCar}
                    />
                    <div className="min-w-0 flex-1 space-y-2 text-[15px]">
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
                      {/* No "Replace tag" here, unlike the device card below: a
                          vehicle pass carries its OWNER'S card rather than a
                          sticker of its own, so the only way to change this UID
                          is to replace the person's card — which carries onto
                          the vehicle automatically (persons.service.reassignRfid). */}
                      <div className="flex items-center justify-between gap-2">
                        <p className="font-mono text-[12px] text-ink-soft">{v.rfid_uid}</p>
                        <span className="shrink-0 text-[12px] text-ink-soft">Owner&apos;s card</span>
                      </div>
                      {onEditVehicle && (
                        <div className="flex justify-end">
                          <button
                            type="button"
                            onClick={() =>
                              onEditVehicle(v.id, {
                                plate_number: v.plate_number,
                                vehicle_type: v.vehicle_type,
                                vehicle_model: v.vehicle_model,
                                rfid_uid: v.rfid_uid,
                              })
                            }
                            className="shrink-0 rounded-lg border border-line px-2.5 py-1 text-[12px] font-600 text-ink-soft hover:border-navy hover:text-ink"
                          >
                            Edit
                          </button>
                        </div>
                      )}
                    </div>
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
          {/* What this person is carrying right now.
              Counted against TAGGED devices only, not every registered one: an
              untagged device has never tapped a reader, so it holds no
              occupancy row and can never be reported inside. Counting it in the
              denominator would read as "1 of 3 devices" for someone who is
              carrying everything they can actually be tracked with. */}
          {(() => {
            const tagged = (data.gadgets ?? []).filter((g) => g.rfid_uid);
            const inside = tagged.filter((g) => g.inside).length;
            if (tagged.length === 0) return null;
            return (
              <p className="mt-2 text-[13px] text-ink-soft">
                Carrying{" "}
                <span className="font-700 text-ink">
                  {inside} of {tagged.length}
                </span>{" "}
                tagged {tagged.length === 1 ? "device" : "devices"}
              </p>
            );
          })()}
          {(data.gadgets ?? []).length > 0 ? (
            <ul className="mt-3 space-y-3">
              {(data.gadgets ?? []).map((g, i) => (
                <li
                  key={`${g.serial_number}-${i}`}
                  className={i > 0 ? "border-t border-line/60 pt-3" : ""}
                >
                  <div className="flex gap-3">
                    <EntityThumb
                      path={`/gadgets/${g.id}/photo`}
                      photoUrl={g.photo_url}
                      alt={`${g.brand_model} photo`}
                      icon={TfiDesktop}
                    />
                    <div className="min-w-0 flex-1 space-y-2 text-[15px]">
                      <div className="flex items-center justify-between">
                        <span className="font-mono font-700 text-ink">{g.serial_number}</span>
                        <span className="flex items-center gap-1.5">
                          {/* Gold, the same accent the gate terminal uses for a
                              device it is still waiting on. Shown only when true:
                              an "Outside" badge on every device most of the time
                              would be noise on the common case. */}
                          {g.inside && (
                            <span className="rounded-lg border border-gold bg-gold/25 px-2.5 py-1 text-[12px] font-600 text-ink">
                              Inside
                            </span>
                          )}
                          <span
                            className={`rounded-lg px-2.5 py-1 text-[12px] font-600 capitalize ${
                              g.status === "active"
                                ? "border border-blue bg-blue/25 text-ink"
                                : "border border-red bg-red/25 text-ink"
                            }`}
                          >
                            {g.status}
                          </span>
                        </span>
                      </div>
                      <p className="text-ink-soft">
                        {gadgetTypeLabel(g.gadget_type)} · {g.brand_model}
                      </p>
                      {/* The device's own tag, mirroring the vehicle row above.
                          Spelled out when absent rather than left blank: an empty
                          slot reads as "the screen did not load it", and "no
                          sticker yet" is a real state someone acts on — it is the
                          device that will not appear on any gate checklist. */}
                      <div className="flex items-center justify-between gap-2">
                        {g.rfid_uid ? (
                          <p className="font-mono text-[12px] text-ink-soft">{g.rfid_uid}</p>
                        ) : (
                          <p className="text-[12px] italic text-ink-soft">No RFID sticker yet</p>
                        )}
                        <span className="flex shrink-0 items-center gap-2">
                          {onEditGadget && (
                            <button
                              type="button"
                              onClick={() =>
                                onEditGadget(g.id, {
                                  gadget_type: g.gadget_type,
                                  brand_model: g.brand_model,
                                  serial_number: g.serial_number,
                                })
                              }
                              className="rounded-lg border border-line px-2.5 py-1 text-[12px] font-600 text-ink-soft hover:border-navy hover:text-ink"
                            >
                              Edit
                            </button>
                          )}
                          {onReplaceTag && (
                            <button
                              type="button"
                              onClick={() =>
                                onReplaceTag("gadget", g.id, g.brand_model, g.rfid_uid)
                              }
                              className="rounded-lg border border-line px-2.5 py-1 text-[12px] font-600 text-ink-soft hover:border-navy hover:text-ink"
                            >
                              {g.rfid_uid ? "Replace tag" : "Assign tag"}
                            </button>
                          )}
                        </span>
                      </div>
                    </div>
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