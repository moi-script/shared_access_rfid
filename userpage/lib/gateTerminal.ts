import { API_BASE } from "@/lib/auth";

const STORAGE_KEY = "ncst_gate_terminal";

export interface GateConfig {
  key: string;
  gateId: string;
  name: string;
  type: "person" | "vehicle";
  direction: "entry" | "exit";
}

/**
 * The five routes, each pre-declaring which gate it expects to be provisioned as.
 *
 * `gadgetFocus` marks the lane whose whole reason to exist is the device check.
 * It changes nothing about the tap — same endpoint, same person/entry gate type
 * — only how the result is laid out and whether a missing device is called out.
 *
 * It is declared on EVERY entry, false included, rather than only on the lane
 * that sets it: with `as const` an absent key is absent from the union type, so
 * `meta.gadgetFocus` would not typecheck at the one call site that needs it.
 * Spelling it out beats widening the type and losing the literal keys.
 *
 * Note that person-entry-gadget provisions independently of person-entry:
 * getStoredGate keys storage by routeId, so the two terminals hold separate
 * gate records and their taps are distinguishable in the scan logs. That
 * separation is the point of the route — see the 'Gadget Lane' gate in
 * serverside/src/config/seed.ts.
 */
export const GATE_ROUTES = {
  "person-entry": {
    type: "person", direction: "entry", label: "Person · Entry", gadgetFocus: false,
  },
  "person-entry-gadget": {
    type: "person", direction: "entry", label: "Person · Entry · Gadget Lane", gadgetFocus: true,
  },
  "person-exit": {
    type: "person", direction: "exit", label: "Person · Exit", gadgetFocus: false,
  },
  "vehicle-entry": {
    type: "vehicle", direction: "entry", label: "Vehicle · Entry", gadgetFocus: false,
  },
  "vehicle-exit": {
    type: "vehicle", direction: "exit", label: "Vehicle · Exit", gadgetFocus: false,
  },
} as const;

export type GateRouteId = keyof typeof GATE_ROUTES;

export function getStoredGate(routeId: GateRouteId): GateConfig | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(`${STORAGE_KEY}:${routeId}`);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as GateConfig;
    return parsed.key && parsed.gateId ? parsed : null;
  } catch {
    return null;
  }
}

export function storeGate(routeId: GateRouteId, config: GateConfig): void {
  window.localStorage.setItem(`${STORAGE_KEY}:${routeId}`, JSON.stringify(config));
}

export function clearStoredGate(routeId: GateRouteId): void {
  window.localStorage.removeItem(`${STORAGE_KEY}:${routeId}`);
}

/** A tap the server actually decided on — granted or denied. */
export interface TapDecision {
  state: "granted" | "denied";
  access_result: "granted" | "denied";
  reason: string | null;
  scan_time: string;
  person?: {
    full_name: string;
    type: string;
    owner_type?: string;
    department_section?: string | null;
    photo_url?: string;
    /** The vehicle's own photo. `photo_url` above stays the owner's face. */
    vehicle_photo_url?: string;
    person_id?: string;
    plate_number?: string;
    vehicle?: { vehicle_type: string; make?: string };
    registered?: { vehicle_type: string; make?: string }[];
    /** The cardholder's registered devices, for the exit ownership check. The
     *  server sends this only on a GRANTED person tap — see the block at
     *  scan.service.ts:301 for why it is withheld on every denial. */
    gadgets?: {
      id: string;
      gadget_type: string;
      brand_model: string;
      serial_number: string;
      photo_url?: string;
    }[];
    /** Devices still inside, returned only on a granted person EXIT tap. */
    gadgets_inside?: {
      id: string;
      gadget_type: string;
      brand_model: string;
      serial_number: string;
    }[];
  };
  rfid_uid: string;
}

export type TapOutcome =
  | TapDecision
  /** Amber: the system did not decide. Never rendered like a grant. */
  | { state: "offline" | "ratelimited" | "error"; message: string; rfid_uid: string }
  /** The stored key is dead; the terminal must be re-provisioned. */
  | { state: "unauthorized"; rfid_uid: string };

/** Above this, a hung server would leave the terminal showing READY forever
 * while silently discarding every further tap; the guard must see amber instead. */
const TAP_TIMEOUT_MS = 8000;

export async function postTap(key: string, rfid_uid: string): Promise<TapOutcome> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/scan/tap`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Gate-Key": key },
      body: JSON.stringify({ rfid_uid }),
      signal: AbortSignal.timeout(TAP_TIMEOUT_MS),
    });
  } catch {
    // Covers both a promptly-rejected connection (cable unplugged) and an
    // aborted-by-timeout hang (server accepted but never answered) — either
    // way the tap was not recorded, so this must render amber, never a grant.
    return { state: "offline", message: "Not recording scans", rfid_uid };
  }

  if (res.status === 401) return { state: "unauthorized", rfid_uid };
  if (res.status === 429) {
    return { state: "ratelimited", message: "Too many taps — wait a moment", rfid_uid };
  }

  const body = (await res.json().catch(() => null)) as
    | { success: true; data: Omit<TapDecision, "state" | "rfid_uid"> }
    | { success: false; message?: string }
    | null;

  if (!res.ok || !body || body.success !== true) {
    const message = (body as { message?: string } | null)?.message ?? "System error";
    return { state: "error", message, rfid_uid };
  }

  return {
    ...body.data,
    state: body.data.access_result === "granted" ? "granted" : "denied",
    rfid_uid,
  };
}

/** Mints a key for a gate. Requires a superadmin token in the Authorization header. */
export async function mintGateKey(
  token: string,
  gateId: string
): Promise<{ key: string; gate: { _id: string; name: string; type: string; direction: string } }> {
  const res = await fetch(`${API_BASE}/gates/${gateId}/key`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = (await res.json().catch(() => null)) as
    | { success: true; data: { key: string; gate: { _id: string; name: string; type: string; direction: string } } }
    | { success: false; message?: string }
    | null;
  if (!res.ok || !body || body.success !== true) {
    throw new Error((body as { message?: string } | null)?.message ?? "Could not mint a device key");
  }
  return body.data;
}
