/**
 * Devices that have pinged the Gadget Lane but are not yet inside.
 *
 * The lane is a one-way sequence: a student taps each device they are
 * carrying at the Gadget Lane reader, then taps their own ID a few steps
 * later at Main Entrance. The person tap is the real security door — the
 * device tap is only a declaration of what they are carrying. So a device tap
 * moves NO occupancy state on its own; it parks here, and the owner's
 * subsequent granted entry is what actually walks it inside (see the commit
 * block in scan.service.ts). A device whose owner never reaches Main
 * Entrance simply expires, having never been recorded as inside.
 *
 * Keyed by PERSON, not by gate, and that is the whole point. The store this
 * replaces on the entry path (gateSession.store.ts) held one session per
 * gate and documented that "a later call always wins" — so the moment a
 * second student tapped a device while the first was still walking to the
 * person reader, the first student's session was destroyed. Here the two
 * students occupy two different keys: any number of people can have devices
 * parked at once, in any order, and each person's ID tap claims only their
 * own bucket.
 *
 * In-memory and per-process, deliberately, for the same reason its
 * predecessor is: this is a minute-wide hint about a transaction in progress
 * at one physical lane, not a durable record. The durable fact — that the
 * device was tapped at all — is the `carry_pending` ScanLog row scan.service
 * writes regardless of what happens here. A restart mid-walk costs a re-tap
 * of the sticker, which is the fail-closed direction.
 */

export interface ParkedGadget {
  id: string;
  rfid_uid: string;
  gadget_type: string;
  brand_model: string;
  serial_number: string;
  photo_url?: string;
}

interface Bucket {
  gadgets: ParkedGadget[];
  expiresAt: number;
}

/** Long enough to walk from the device reader to the person reader with a
 *  queue in front of you, short enough that a device abandoned at the lane is
 *  forgotten within one visitor's memory of tapping it. */
const TTL_MS = 120_000;

const buckets = new Map<string, Bucket>();

function live(personId: string): Bucket | null {
  const b = buckets.get(personId);
  if (!b) return null;
  if (b.expiresAt < Date.now()) {
    buckets.delete(personId);
    return null;
  }
  return b;
}

export const pendingCarryStore = {
  /**
   * Parks one device under its owner. Idempotent per gadget id: a student who
   * taps the same laptop twice (hesitation, a reader that double-fires) gets
   * one entry, so the commit below writes one occupancy row. The TTL slides on
   * every tap, so someone carrying three devices is never cut off partway
   * through by the first one's clock.
   */
  park(personId: string, gadget: ParkedGadget): void {
    const b = live(personId) ?? { gadgets: [], expiresAt: 0 };
    if (!b.gadgets.some((g) => g.id === gadget.id)) b.gadgets.push(gadget);
    b.expiresAt = Date.now() + TTL_MS;
    buckets.set(personId, b);
  },

  /**
   * Hands over everything this person parked and empties their bucket.
   * Returns an empty array for the ordinary case — someone entering carrying
   * nothing — which is why the caller never has to ask first.
   */
  claim(personId: string): ParkedGadget[] {
    const b = live(personId);
    if (!b) return [];
    buckets.delete(personId);
    return b.gadgets;
  },
};
