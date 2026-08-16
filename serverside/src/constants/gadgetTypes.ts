/**
 * The gadget types the OSS office registers, and how many of each one person
 * may hold at once.
 *
 * This is the ONLY place the list lives on the server. The Mongoose enum on
 * Gadget, the zod schema, and the limit check in gadgets.service all read from
 * here — the same arrangement as `constants/vehicleTypes.ts`, and for the same
 * reason recorded there: a list repeated at eight sites is how a model and its
 * schema drift apart and start accepting values the other rejects.
 *
 * One element is deliberate, not a placeholder. Because every consumer reads
 * this array, adding `tablet` is an edit to this file and to
 * `userpage/lib/gadgetTypes.ts` — nothing else. The two are separate
 * deployables and cannot share an import. Change both together.
 */
export const GADGET_TYPES = ['laptop'] as const;

export type GadgetType = (typeof GADGET_TYPES)[number];

/**
 * Per-person allowance, counted over ACTIVE gadgets only (see
 * gadgetRepo.findActiveByOwner). Deactivating a registration frees the slot, so
 * a student who replaces a laptop is not locked out — the old row survives for
 * history without consuming the allowance.
 *
 * Unlike VEHICLE_LIMITS there is no expiry dimension here: a gadget
 * registration confers no access, so it has nothing to expire out of. Status is
 * the whole of "does this count".
 */
export const GADGET_LIMITS: Record<GadgetType, number> = {
  laptop: 1,
};

/** Plural for an error message: 1 laptop, 2 laptops. */
export function pluralizeGadget(type: GadgetType, count: number): string {
  return count === 1 ? type : `${type}s`;
}

/**
 * The stored form of a serial number: trimmed and uppercased.
 *
 * Load-bearing, not cosmetic. Without it `5cd1234abc`, `5CD1234ABC`, and
 * `5CD1234ABC ` are three rows for one physical device — so a stolen laptop is
 * re-registered to a second owner by typing its serial in a different case, and
 * the system then agrees with both claimants. The unique index on
 * `serial_number` is the anti-theft anchor of this whole subsystem, and an
 * un-normalized index anchors nothing.
 *
 * Exported and called from exactly one layer (the service), so the value
 * compared against the index and the value written are the same expression.
 */
export function normalizeSerial(serial: string): string {
  return serial.trim().toUpperCase();
}
