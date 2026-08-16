/**
 * Mirror of serverside/src/constants/gadgetTypes.ts. The two projects are
 * separate deployables and cannot share an import — the server file is
 * authoritative, and both must be changed together.
 */
export const GADGET_TYPES = ["laptop"] as const;

export type GadgetType = (typeof GADGET_TYPES)[number];

/** Per-person allowance, counted over active registrations only. */
export const GADGET_LIMITS: Record<GadgetType, number> = {
  laptop: 1,
};

/** Sentence-case for a form label: "laptop" -> "Laptop". */
export function gadgetTypeLabel(type: GadgetType): string {
  return type.charAt(0).toUpperCase() + type.slice(1);
}
