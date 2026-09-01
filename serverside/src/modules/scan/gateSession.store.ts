/**
 * Tracks, per gate, which person a device tap is currently allowed to belong
 * to on the way OUT, and which of their devices that tap may be.
 *
 * Before this existed, a bare gadget RFID "just worked" at any person gate:
 * scan.service resolved it, found it active, and granted it — no person had
 * to be present at all. That is backwards. A device does not walk itself
 * through a gate; it is carried by someone who has, moments earlier, tapped
 * their own card there.
 *
 * ENTRY no longer uses this store at all — that direction now runs Gadget Lane
 * first and commits on the person's tap at Main Entrance, keyed by person
 * rather than by gate (see pendingCarry.store.ts). What remains here is the
 * exit lane, where the ordering genuinely is person-then-device: the terminal
 * is working through a checklist of SPECIFIC devices the person's own exit tap
 * reported as still inside, and a device tapped with no such checklist open
 * belongs to nobody's transaction.
 *
 * A session therefore knows WHAT IT IS FOR, not merely who opened it. It
 * carries the ids it is still waiting on, and it closes the moment the last
 * one is read. Without that it was a standing 60-second permit that every
 * device tap slid forward — so a guard walking devices past the reader kept it
 * alive indefinitely, and a device tapped long after its owner had left was
 * still accepted. Worse, the terminal gives up on its checklist at 30s and
 * files `gadget_not_returned` for whatever is outstanding, so there was a
 * window in which the screen had declared a device missing and the server
 * would still admit it. The remaining-set is what makes the permit end where
 * the transaction ends instead of where the clock does.
 *
 * In-memory and per-process, deliberately. This is a seconds-wide hint tied to
 * one physical terminal's current transaction, not a durable record — the
 * durable facts (who tapped, when, granted or denied) are already the ScanLog
 * row scan.service writes regardless of this store's state. A process restart
 * mid-checklist simply means the next device tap is asked for the person's
 * card again, which is the fail-closed direction and costs nothing worse than
 * a re-tap.
 */

interface Session {
  personId: string;
  /** Gadget ids this checklist is still waiting on. Emptying it closes the
   *  session — see `settle`. */
  remaining: Set<string>;
  expiresAt: number;
}

/** The backstop only, now that a completed checklist closes itself. Mirrors
 *  the terminal's own idle-prompt timeout (GateTerminal.tsx's 30s auto-close)
 *  with headroom for network round-trips on top of it, so the server is never
 *  the stricter of the two clocks. */
const TTL_MS = 60_000;

const sessions = new Map<string, Session>();

export const gateSessionStore = {
  /**
   * Opens (or replaces) the session for a gate. A later call always wins,
   * matching the terminal UI: a second person tapping out at the same lane
   * replaces whatever device checklist was on screen, not queues behind it.
   *
   * `expected` is the set of devices this person's exit tap reported as still
   * inside. It is required rather than optional: a session opened without one
   * is the open-ended permit this store exists to stop granting.
   */
  open(gateId: string, personId: string, expected: string[]): void {
    sessions.set(gateId, {
      personId,
      remaining: new Set(expected),
      expiresAt: Date.now() + TTL_MS,
    });
  },

  /**
   * The person a device tap at this gate is currently allowed to belong to,
   * or null if no session is open or it has expired. Expired entries are
   * deleted on read rather than on a timer, so a terminal that goes quiet for
   * hours leaves nothing behind to sweep.
   */
  activePerson(gateId: string): string | null {
    const s = sessions.get(gateId);
    if (!s) return null;
    if (s.expiresAt < Date.now()) {
      sessions.delete(gateId);
      return null;
    }
    return s.personId;
  },

  /**
   * Records that one expected device has been read, and closes the session
   * when that was the last one.
   *
   * Replaces the old `touch`, which only ever slid the clock forward. Sliding
   * still happens — a guard checking three laptops must not be cut off
   * mid-queue waiting on the first tap's clock — but it can no longer outlive
   * the checklist, because the checklist now ends the session itself.
   *
   * A device that was NOT on the expected list still slides the window (it is
   * the same person, at the same reader, mid-transaction) but cannot shorten
   * it: `delete` on an absent key is a no-op, so an unexpected device never
   * closes a session that is still owed something.
   */
  settle(gateId: string, gadgetId: string): void {
    const s = sessions.get(gateId);
    if (!s) return;
    s.remaining.delete(gadgetId);
    if (s.remaining.size === 0) {
      sessions.delete(gateId);
      return;
    }
    s.expiresAt = Date.now() + TTL_MS;
  },

  /**
   * Ends a session outright. Called when the terminal closes a checklist with
   * devices still unticked (POST /scan/gadget-session), so the screen's "these
   * were not returned" and the server's "this permit is spent" are one
   * decision rather than two clocks that disagree for thirty seconds.
   */
  close(gateId: string): void {
    sessions.delete(gateId);
  },
};
