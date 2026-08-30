import type { IconType } from "react-icons";
import { TfiCar, TfiCheckBox, TfiDesktop, TfiPulse, TfiUser } from "react-icons/tfi";

export interface GateStatus {
  name: string;
  type: "person" | "vehicle";
  location: string | null;
  last_scan: string | null;
  status: "online" | "offline";
}

export interface ScanRow {
  name?: string;
  rfid_uid: string;
  entity_type: "person" | "vehicle" | "gadget";
  gate: string;
  direction: "entry" | "exit";
  access_result: "granted" | "denied";
  reason: string | null;
  scan_time: string;
}

export interface ParkingRow {
  owner_name?: string;
  plate_number: string | null;
  rfid_uid: string;
  gate: string;
  direction: "entry" | "exit";
  access_result: "granted" | "denied";
  scan_time: string;
}

export interface AdminDashboard {
  total_persons: number;
  persons_by_type: { student: number; staff: number; employee: number };
  persons_inside: number;
  vehicles_inside: number;
  gadgets_inside: number;
  active_today: number;
  total_vehicles: number;
  total_gadgets: number;
  scan_events_today: number;
  granted_today: number;
  denied_today: number;
  gates: GateStatus[];
  recent_scans: ScanRow[];
  parking_activity: ParkingRow[];
}

/**
 * The volatile slice of the Overview, from GET /dashboard/live. Every field
 * here also exists on AdminDashboard — this is the same data re-read, not a
 * different shape, so OverviewView can substitute one for the other field by
 * field.
 */
export interface LiveOverview {
  persons_inside: number;
  vehicles_inside: number;
  gadgets_inside: number;
  scan_events_today: number;
  granted_today: number;
  denied_today: number;
  recent_scans: ScanRow[];
  as_of: string;
}

export function fmtDateTime(iso: string | null): string {
  if (!iso) return "No scans yet";
  return new Date(iso).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Clock time only — this is a "seconds ago" freshness cue, not a date. */
export function fmtClock(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export type StatKey =
  | "total_persons"
  | "active_today"
  | "total_vehicles"
  | "total_gadgets"
  | "scan_events_today";
export const STATS: { key: StatKey; label: string; icon: IconType }[] = [
  { key: "total_persons", label: "Registered persons", icon: TfiUser },
  { key: "active_today", label: "Active today", icon: TfiCheckBox },
  { key: "total_vehicles", label: "Registered vehicles", icon: TfiCar },
  { key: "total_gadgets", label: "Registered devices", icon: TfiDesktop },
  { key: "scan_events_today", label: "Scans today", icon: TfiPulse },
];