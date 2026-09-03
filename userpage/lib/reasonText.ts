export const REASON_TEXT: Record<string, string> = {
  unregistered_uid: "Unregistered card",
  inactive_id: "ID inactive",
  vehicle_expired: "Pass expired",
  wrong_gate_type: "Wrong gate for this card",
  no_vehicle_registered: "No vehicle registered to this ID",
  multiple_vehicles: "Multiple vehicles — tap the vehicle's sticker",
  already_inside: "Card already inside campus",
  exit_without_entry: "Exited without tapping in",
  occupancy_unavailable: "Recorded — state not updated",
  manual_override: "Cleared via manual override",
  card_blocked: "Card blocked",
  // Exit-lane only now. On the way out the terminal is working through a
  // checklist of specific devices, so a device tapped with no checklist open,
  // or one belonging to somebody else, has no transaction to belong to.
  gadget_requires_person_tap: "Tap the person's card first",
  gadget_owner_mismatch: "Device belongs to someone else",
  // Not a denial. A granted Gadget Lane tap carries this to say the device was
  // recorded as declared but is NOT inside yet — the owner's ID tap at Main
  // Entrance is what walks it in. The guard needs to read it as "keep going",
  // which is why it names the next step rather than the state.
  carry_pending: "Declared — now tap the ID at Main Entrance",
  // A device sticker at the person reader. Names the right reader rather than
  // the generic wrong_gate_type, which reads as "this sticker is invalid".
  gadget_wrong_lane: "Tap devices at the Gadget Lane first",
  // Gadget Lane takes devices only. A student who taps their own ID there is
  // simply a few steps early — the person reader is the next one in the lane.
  person_not_allowed_at_gadget_lane: "Tap your ID at Main Entrance",
  // Not a denial. A granted tap carries this when the guard typed the ID
  // number because the card was missing — the passage stands, and the student
  // still owes OSS the paperwork for the lost card.
  manual_id_entry: "Admitted by ID number — proceed to OSS",
  unregistered_id_number: "No student with that ID number",
  // A student number identifies a person, not a car; the vehicle lanes read a
  // pass and there is nothing to type in place of one.
  manual_entry_wrong_gate: "ID numbers are for the person gates only",
};
export function reasonText(reason: string): string {
  return REASON_TEXT[reason] ?? reason;
}