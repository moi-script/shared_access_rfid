import type { IconType } from "react-icons";
import {
  TfiDashboard,
  TfiIdBadge,
  TfiCar,
  TfiTime,
  TfiAgenda,
  TfiWrite,
  TfiKey,
} from "react-icons/tfi";
import type { Role } from "./auth";

export type AdminView =
  | "overview"
  | "directory"
  | "parking"
  | "vehicles"
  | "presence"
  | "records"
  | "register"
  | "accounts";

export type Action =
  | "manageStatus"
  | "registerPeople"
  | "registerVehicles"
  | "registerGadgets"
  | "viewDirectory"
  | "viewReports"
  | "viewRecords"
  | "manageAccounts";

/**
 * Mirrors the server matrix in
 * docs/superpowers/specs/2026-07-30-rbac-v2-design.md.
 * This is a usability layer; the API enforces the real boundary.
 */
const ABILITIES: Record<Role, Action[]> = {
  superadmin: [
    "manageStatus",
    "registerPeople",
    "registerVehicles",
    "registerGadgets",
    "viewDirectory",
    "viewReports",
    "viewRecords",
    "manageAccounts",
  ],
  registrar: ["registerPeople", "viewDirectory", "manageStatus"],
  hr: ["registerPeople", "viewDirectory", "manageStatus"],
  // OSS holds the registrar's and HR's authority on top of its own. Mirrors
  // WRITE_DOMAINS.oss on the server, which now carries all three person
  // domains as well as vehicle and gadget. registrar and hr are unchanged —
  // this widened OSS rather than retiring them.
  oss: [
    "registerPeople",
    "registerVehicles",
    "registerGadgets",
    "viewDirectory",
    "manageStatus",
  ],
  staff: [],
  student: [],
};

const RANK: Record<Role, 1 | 2 | 3> = {
  superadmin: 3,
  registrar: 2,
  hr: 2,
  oss: 2,
  staff: 1,
  student: 1,
};

const ALL: Role[] = ["superadmin", "registrar", "hr", "oss", "staff", "student"];

export function rankOf(role: Role): 1 | 2 | 3 {
  return RANK[role];
}

/**
 * Roles this actor may create or act on. Mirrors the server's rolesBelow()
 * PLUS the one peer exception in assertCanCreateRole/assertCanActOn: a
 * superadmin may create and manage another superadmin.
 *
 * Spelled out as `actor === "superadmin"` rather than a rank comparison for
 * the same reason the server's isSuperadminPeer is — a rank test would extend
 * the exception to any future rank-3 role by accident.
 *
 * This is the usability layer only; the API enforces the real boundary.
 */
export function rolesBelow(actor: Role): Role[] {
  const below = ALL.filter((r) => RANK[r] < RANK[actor]);
  return actor === "superadmin" ? ["superadmin", ...below] : below;
}

/** Person types this role may register. Empty means it registers no people. */
export function personTypesFor(role: Role): ("student" | "staff" | "employee")[] {
  switch (role) {
    case "superadmin":
      return ["student", "staff", "employee"];
    // OSS registers every person type: it holds the registrar's student domain
    // and HR's staff/employee domains as well as its own. Listed beside
    // superadmin rather than merged with it so the two stay independently
    // editable — they are equal today by decision, not by definition.
    case "oss":
      return ["student", "staff", "employee"];
    case "registrar":
      return ["student"];
    case "hr":
      return ["staff", "employee"];
    default:
      return [];
  }
}

export function can(role: Role, action: Action): boolean {
  return ABILITIES[role].includes(action);
}

export function isStaffSide(role: Role): boolean {
  return rankOf(role) >= 2;
}

/**
 * The member (student/staff) self-service portal at /dashboard.
 *
 * Disconnected during testing: gate access is by RFID tap, so a member has no
 * reason to sign in to the web app, and every screen they could reach there is
 * one more surface to keep working. The page and its components are all still
 * in the tree — flip this to true to reconnect it. The three places that lead
 * to /dashboard (LoginExperience, app/admin/page.tsx, app/dashboard/page.tsx)
 * all read this flag; nothing else needs changing to turn it back on.
 */
export const MEMBER_PORTAL_ENABLED = false;

/** Roles that may register a vehicle. Mirrors WRITE_DOMAINS on the server. */
export function canRegisterVehicles(role: Role): boolean {
  return role === "superadmin" || role === "oss";
}

/** Roles that may register a gadget. Mirrors WRITE_DOMAINS on the server. */
export function canRegisterGadgets(role: Role): boolean {
  return role === "superadmin" || role === "oss";
}

/** One icon per view, so a tab looks the same wherever a role meets it. */
export const VIEW_ICONS: Record<AdminView, IconType> = {
  overview: TfiDashboard,
  directory: TfiIdBadge,
  parking: TfiCar,
  // Same icon as Parking on purpose: same subject, seen from the registry side
  // rather than the gate side.
  vehicles: TfiCar,
  presence: TfiTime,
  records: TfiAgenda,
  register: TfiWrite,
  accounts: TfiKey,
};

export const NAV_BY_ROLE: Record<Role, { id: AdminView; label: string }[]> = {
  superadmin: [
    { id: "overview", label: "Overview" },
    { id: "directory", label: "Directory" },
    { id: "parking", label: "Parking" },
    { id: "vehicles", label: "Vehicles" },
    { id: "presence", label: "Presence" },
    { id: "records", label: "Records" },
    { id: "register", label: "Register" },
    { id: "accounts", label: "Accounts" },
  ],
  registrar: [
    { id: "register", label: "Register" },
    { id: "directory", label: "Directory" },
  ],
  hr: [
    { id: "register", label: "Register" },
    { id: "directory", label: "Directory" },
  ],
  // The vehicle application form now exists, so OSS gets the Register tab
  // RBAC v2 deliberately withheld — a tab opening an empty panel was worse
  // than no tab, and that condition no longer holds.
  // No vehicles tab for registrar or hr. They may READ /vehicles
  // (vehicles.routes.ts authorizes all four staff roles) but writes are
  // OSS-only via assertCanWrite('vehicle'), so the tab's only button would
  // 403 for them — the same reason the OSS Register tab was withheld until it
  // had something behind it.
  oss: [
    { id: "register", label: "Register" },
    { id: "directory", label: "Directory" },
    { id: "parking", label: "Parking" },
    { id: "vehicles", label: "Vehicles" },
  ],
  staff: [],
  student: [],
};

/** The view a role sees when it opens /admin with no tab selected. */
export function defaultViewFor(role: Role): AdminView | null {
  return NAV_BY_ROLE[role][0]?.id ?? null;
}
