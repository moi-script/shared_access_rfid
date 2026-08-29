// Shared between the gate terminal (denial/edge-case messaging for a guard)
// and the superadmin Records view (denial/edge-case messaging for an
// auditor). Both must render the server's snake_case reason codes in plain
// English rather than leaking internal identifiers — a granted exit can
// legitimately carry `exit_without_entry` or `occupancy_unavailable`, and
// printing those raw was a must-fix during an earlier review.
export const REASON_TEXT: Record<string, string> = {
  unregistered_uid: "Unregistered card",
  inactive_id: "ID inactive",
  vehicle_expired: "Pass expired",
  wrong_gate_type: "Wrong gate for this card",
  // Single-card access: the card IS valid for this gate, so neither of these
  // is a wrong_gate_type. The wording tells a guard what to DO — check the
  // plate by eye, or send them to register — rather than naming the internal
  // condition.
  no_vehicle_registered: "No vehicle registered to this ID",
  multiple_vehicles: "Multiple vehicles — tap the vehicle's sticker",
  already_inside: "Card already inside campus",
  exit_without_entry: "Exited without tapping in",
  occupancy_unavailable: "Recorded — state not updated",
  // Produced by the occupancy-roster "Clear" action (see PresenceView), not
  // by a gate tap — the row still needs English on the Records screen, which
  // is the only place these rows are visible after the fact.
  manual_override: "Cleared via manual override",
  // A UID that left a person's record — by card replacement or deletion —
  // is permanently blocked and denied before entity resolution, so no
  // identity is revealed. A raw snake_case code on an operator screen has
  // been a must-fix twice here; do not let this one slip through either.
  card_blocked: "Card blocked",
  // Gate-session denials (scan.service.ts's gateSessionStore). Both fire only
  // for a gadget entity — a person's own card is never checked against a
  // session — so the wording speaks to the guard about the DEVICE, matching
  // no_vehicle_registered/multiple_vehicles' pattern of naming the fix, not
  // the mechanism.
  gadget_requires_person_tap: "Tap the person's card first",
  gadget_owner_mismatch: "Device belongs to someone else",
};

export function reasonText(reason: string): string {
  return REASON_TEXT[reason] ?? reason;
}