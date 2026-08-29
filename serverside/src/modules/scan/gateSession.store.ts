/**
 * Tracks, per gate, which person a device tap is currently allowed to belong
 * to.
 *
 * Before this existed, a bare gadget RFID "just worked" at any person gate:
 * scan.service resolved it, found it active, and granted it — no person had
 * to be present at all. That is backwards. A device does not walk itself
 * through a gate; it is carried by someone who has, moments earlier, tapped
 * their own card there. This store is what makes that ordering load-bearing
 * instead of a UI convention the terminal's devicePrompt state merely
 * happened to follow.
 *
 * A session opens ONLY from scan.service, and only on a GRANTED person tap at
 * a gate that is actually expecting a device next — the Gadget Lane on entry,
 * or an exit where the person left devices inside (see the two call sites in
 * scan.service.ts). Every other person gate (a plain entry, an exit with
 * nothing left behind) never opens one, so a gadget tapped there is refused no
 * matter how recently its owner walked through — matching Main Entrance's
 * "one person tap, nothing else" rule.
 *
 * In-memory and per-process, deliberately. This is a few-seconds-wide hint
 * tied to one physical terminal's current transaction, not a durable record —
 * the durable facts (who tapped, when, granted or denied) are already the
 * ScanLog row scan.service writes regardless of this store's state. A process
 * restart mid-checklist simply means the next device tap is asked for the
 * person's card again, which is the fail-closed direction and costs nothing
 * worse than a re-tap.
 */

interface Session {
  personId: string;
  expiresAt: number;
}

/** Mirrors the terminal's own idle-prompt timeout (GateTerminal.tsx's 30s
 *  auto-close) with headroom for network round-trips on top of it, so the
 *  server is never the stricter of the two clocks. */
const TTL_MS = 60_000;

const sessions = new Map<string, Session>();

export const gateSessionStore = {
  /**
   * Opens (or replaces) the session for a gate. A later call always wins,
   * matching the terminal UI: a second person tapping the same lane replaces
   * whatever device checklist was on screen, not queues behind it.
   */
  open(gateId: string, personId: string): void {
    sessions.set(gateId, { personId, expiresAt: Date.now() + TTL_MS });
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
   * Slides the window forward on every successful device tap, so a guard
   * walking three laptops past the reader one at a time is never cut off
   * mid-list waiting on the first tap's clock.
   */
  touch(gateId: string): void {
    const s = sessions.get(gateId);
    if (s) s.expiresAt = Date.now() + TTL_MS;
  },
};