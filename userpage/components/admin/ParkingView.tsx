"use client";

import { TfiCar } from "react-icons/tfi";
import SectionHeading from "@/components/SectionHeading";
import { fmtDateTime, type AdminDashboard } from "./types";

export default function ParkingView({ data }: { data: AdminDashboard }) {
  const rows = data.parking_activity;
  return (
    <section className="rounded-2xl border border-line bg-white p-5">
      <SectionHeading icon={TfiCar}>Parking usage</SectionHeading>
      {rows.length > 0 ? (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-[14px]">
            <thead>
              <tr className="border-b border-line text-[12px] uppercase tracking-wide text-ink-soft">
                <th className="py-2 font-600">Owner</th>
                <th className="py-2 font-600">Plate</th>
                <th className="py-2 font-600">Gate</th>
                <th className="py-2 font-600">Direction</th>
                <th className="py-2 font-600">Time</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((v, i) => (
                <tr key={i} className="border-b border-line/60 last:border-0">
                  <td className="py-2.5 font-600 text-ink">
                    {v.owner_name ?? <span className="font-mono text-ink-soft">{v.rfid_uid}</span>}
                  </td>
                  <td className="py-2.5 font-mono text-[13px] text-ink">{v.plate_number ?? "—"}</td>
                  <td className="py-2.5 text-ink-soft">{v.gate}</td>
                  <td className="py-2.5">
                    <span
                      className={`rounded-md px-2 py-0.5 text-[12px] font-600 capitalize ${
                        v.direction === "entry"
                          ? "border border-blue bg-blue/25 text-ink"
                          : "bg-ink-soft/10 text-ink-soft"
                      }`}
                    >
                      {v.direction}
                    </span>
                  </td>
                  <td className="py-2.5 text-ink-soft">{fmtDateTime(v.scan_time)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="mt-3 text-[15px] text-ink-soft">No parking activity yet.</p>
      )}
    </section>
  );
}
