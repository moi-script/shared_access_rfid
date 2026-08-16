import { ApiError } from '../utils/ApiError';

export const ROLES = {
  SUPERADMIN: 'superadmin',
  REGISTRAR: 'registrar',
  HR: 'hr',
  OSS: 'oss',
  STAFF: 'staff',
  STUDENT: 'student',
} as const;

export type Role = (typeof ROLES)[keyof typeof ROLES];

/** A class of record a role may write. */
export type Domain =
  | 'person:student'
  | 'person:staff'
  | 'person:employee'
  | 'vehicle'
  | 'gadget';

/**
 * Authority level. Deliberately NOT exported: callers use rankOf() and
 * rolesBelow() so no call site can invent its own comparison, and it is
 * deliberately NOT stored on any document — a stored rank would let a bad row
 * grant authority that the code cannot account for.
 */
const RANK: Record<Role, 1 | 2 | 3> = {
  superadmin: 3,
  registrar: 2,
  hr: 2,
  oss: 2,
  staff: 1,
  student: 1,
};

/** Every valid role, for Zod enums and Mongoose enums. */
export const ALL_ROLES: readonly Role[] = [
  ROLES.SUPERADMIN,
  ROLES.REGISTRAR,
  ROLES.HR,
  ROLES.OSS,
  ROLES.STAFF,
  ROLES.STUDENT,
];

/** Roles that get the staff-side console at /admin. */
export const STAFF_SIDE: readonly Role[] = [
  ROLES.SUPERADMIN,
  ROLES.REGISTRAR,
  ROLES.HR,
  ROLES.OSS,
];

/**
 * A bare `RANK[role]` lookup returns `undefined` for a role the table does
 * not recognize, and every rank guard compares with `>=` — `undefined >= n`
 * is `false`, so an unrecognized role would silently PASS every rank check
 * instead of failing it. `actor.role` is a JWT claim that is never
 * enum-validated on the way in, so this must fail closed rather than trust
 * the table lookup to always hit.
 */
export function rankOf(role: Role): 1 | 2 | 3 {
  const rank = RANK[role];
  if (rank === undefined) {
    throw new ApiError('FORBIDDEN', `Unrecognized role '${String(role)}'`);
  }
  return rank;
}

/**
 * Every role strictly below `actor`.
 *
 * This replaces the former BULK_PROTECTED list. That list named privileged
 * roles by hand, which worked until the next role was added and then silently
 * stopped protecting it. Deriving the set from RANK cannot go stale.
 */
export function rolesBelow(actor: Role): Role[] {
  return ALL_ROLES.filter((r) => RANK[r] < RANK[actor]);
}

/**
 * Roles a bulk action may touch: strictly below the actor AND never an admin.
 *
 * rolesBelow() alone is NOT the bulk predicate. The former BULK_PROTECTED list
 * did two jobs, and only one was peer protection: it also kept a SUPERADMIN's
 * bulk action off registrar accounts. Without the rank floor here, one
 * mis-filtered "Deactivate All" disables every Registrar, HR, and OSS account
 * at once, leaving only the acting superadmin.
 *
 * Still derived from RANK, so unlike the hand-maintained list it replaced, it
 * cannot go stale when a role is added.
 */
export function bulkEligibleRoles(actor: Role): Role[] {
  return rolesBelow(actor).filter((r) => RANK[r] < 2);
}

/**
 * Which record classes each role may create, edit, and deactivate.
 *
 * Reads are deliberately NOT restricted here: Vehicle.owner_person_id
 * references a Person, so OSS cannot attach an owner to a vehicle without
 * reading a student that the registrar created.
 */
export const WRITE_DOMAINS: Record<Role, readonly Domain[]> = {
  superadmin: ['person:student', 'person:staff', 'person:employee', 'vehicle', 'gadget'],
  registrar: ['person:student'],
  hr: ['person:staff', 'person:employee'],
  oss: ['vehicle', 'gadget'],
  staff: [],
  student: [],
};

/** Person.type -> the domain that governs writing it. */
export function personDomain(type: 'student' | 'staff' | 'employee'): Domain {
  return `person:${type}`;
}
