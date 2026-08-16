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
  entity_type: "person" | "vehicle";
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

export function fmtDateTime(iso: string | null): string {
  if (!iso) return "No scans yet";
  return new Date(iso).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
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
