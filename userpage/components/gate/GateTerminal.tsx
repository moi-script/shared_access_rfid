"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import AuthedImage, { PersonAvatar } from "@/components/AuthedImage";
import NcstMark from "@/components/NcstMark";
import GateCardSkeleton from "./GateCardSkeleton";
import GateIdleScene from "./GateIdleScene";
import GateProvisioning from "./GateProvisioning";
import {
  GATE_ROUTES,
  clearStoredGate,
  getStoredGate,
  postTap,
  type GateConfig,
  type GateRouteId,
  type TapDecision,
  type TapOutcome,
} from "@/lib/gateTerminal";
import { reasonText } from "@/lib/reasonText";
import { API_BASE } from "@/lib/auth";

const RESET_MS = 2000;
const UID_RE = /^[0-9A-Fa-f]{6,32}$/;
// A USB keyboard-wedge reader emits each of a UID's characters a few
// milliseconds apart — far faster than a human can type. This governs only
// the gap BETWEEN CHARACTERS, not the gap before the terminating Enter (see
// the keydown handler below for why Enter is deliberately exempt). Any
// inter-character gap above this is treated as human typing (or the start
// of a new, unrelated sequence) and resets the buffer, so the heuristic
// discriminates "reader" from "person" purely on inter-keystroke timing
// without needing focus.
const MAX_KEYSTROKE_GAP_MS = 50;

type TapPerson = NonNullable<TapDecision["person"]>;

/** Vehicle taps carry the owner's real type on `owner_type`; `type` itself is
 * just the literal string "vehicle" there. Reading `owner_type ?? type`
 * covers both lanes with one expression instead of branching on the gate. */
function departmentLabel(person: TapPerson): string {
  // Was `student ? "Course & Section" : "Department"`. As of 2026-08-18 the
  // field is called Department everywhere it is entered or listed, and a guard
  // reading one name on the barrier screen and a clerk reading another in the
  // directory is how two names for one column start to feel like two columns.
  // `person` stays in the signature: the type-dependent choice is the thing
  // being removed, not the ability to make one.
  void person;
  return "Department";
}

function RegisteredItem({ v }: { v: { vehicle_type: string; make?: string } }) {
  return (
    <>
      <span className="capitalize">{v.vehicle_type}</span>
      {v.make ? ` · ${v.make}` : null}
    </>
  );
}

/** The vehicle's own photo. Unlike PersonAvatar there are no initials to fall
 *  back to, so an absent or unfetchable photo shows a neutral glyph. */
function VehicleImage({ path, gateKey }: { path?: string; gateKey: string }) {
  const placeholder = <span className="font-display text-5xl font-700 opacity-60">—</span>;
  if (!path) return placeholder;
  return (
    <AuthedImage
      path={path}
      alt="Registered vehicle"
      className="h-full w-full object-cover"
      headers={{ "X-Gate-Key": gateKey }}
      fallback={placeholder}
    />
  );
}

/** A registered device's photo. Same neutral glyph fallback as VehicleImage —
 *  most gadgets have no photo, so the placeholder is the common case. */
function GadgetImage({ path, gateKey }: { path?: string; gateKey: string }) {
  const placeholder = <span className="font-display text-4xl font-700 opacity-60">—</span>;
  if (!path) return placeholder;
  return (
    <AuthedImage
      path={path}
      alt="Registered device"
      className="h-full w-full object-cover"
      headers={{ "X-Gate-Key": gateKey }}
      fallback={placeholder}
    />
  );
}

/**
 * The large left-hand frame the result card leads with.
 *
 * Pulled out of the vehicle branch it started in, because all three lanes now
 * want the same thing for the same reason: the guard is looking at a physical
 * object — a car, a laptop — and the screen has to show that object next to
 * the face of whoever is holding it. One size for all of them, so a person
 * walking the gadget lane and then the person lane sees one layout, not two.
 */
function SubjectFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid h-56 w-72 shrink-0 place-items-center overflow-hidden rounded-2xl bg-current/15">
      {children}
    </div>
  );
}

type DeviceRow = {
  id: string;
  gadget_type: string;
  brand_model: string;
  serial_number: string;
  photo_url?: string;
};

/**
 * The exit-only device checklist.
 *
 * Presentation only — there is no server session. Each gadget tap is an
 * ordinary POST /scan/tap that has already moved that device's occupancy row
 * by the time it appears here. So a terminal reload mid-prompt loses the
 * checklist but never loses the record: everything tapped so far stands.
 *
 * There used to be an "entry" mode here too — an open-ended, accumulate-then-
 * press-Done checklist for the Gadget Lane. It's gone: the Gadget Lane never
 * receives a person's own card (that tap is refused there and has to happen
 * at Main Entrance instead — see reasonText's person_not_allowed_at_gadget_lane),
 * so there was never a person to build a session around. What actually lands
 * on that reader is a bare stream of gadget RFID stickers, one after another,
 * each one its own independent event. That case is now handled entirely
 * inline in handleUid, exactly like an ordinary person tap: one outcome card,
 * one Recent row, immediate auto-reset. Only the exit lane still needs a
 * standing session, because it has to confirm specific EXPECTED devices are
 * coming back, and that can take a guard a while to walk through.
 */
type DevicePrompt = {
  mode: "exit";
  personId: string;
  expected: DeviceRow[];
  seen: DeviceRow[];
};

/** The exit checklist panel. Rendered both inside the granted result card
 *  (immediately after the person's own exit tap) and, once that card's
 *  `outcome` auto-resets after RESET_MS, as its own standalone panel — the
 *  prompt persists on `devicePrompt` state, not on `outcome`, since a guard
 *  needs far longer than RESET_MS to walk someone's devices past the reader. */
function DevicePromptPanel({
  prompt,
  gateKey,
  onDone,
}: {
  prompt: DevicePrompt;
  gateKey: string;
  onDone: () => void;
}) {
  // The exit lane already knows which devices this person is carrying —
  // gadgets_inside — so this checklist is expected-vs-seen.
  return (
    <div className="w-full text-center">
      <p className="font-mono text-xs uppercase tracking-[0.42em] text-gold/70">
        Devices to return
      </p>
      <h1 className="mt-5 font-display text-5xl font-700 uppercase leading-[0.9] tracking-tight">
        Tap each device
      </h1>
      <div className="mx-auto mt-6 max-w-xl space-y-3 text-left">
        {prompt.expected.map((g) => {
          // `g` comes from gadgets_inside, which the server deliberately sends
          // without a photo_url (see scan.service.ts) — the exit lane is meant
          // to confirm a device once it is actually read back, not to preview
          // it in advance. The photo only exists once the matching tap has
          // landed in `seen`, which carries the full gadget row (photo_url
          // included).
          const seenMatch = prompt.seen.find((s) => s.id === g.id);
          const ticked = Boolean(seenMatch);
          return (
            <div
              key={g.id}
              className={`flex items-center gap-4 rounded-2xl px-5 py-3 ${
                ticked ? "bg-current/15" : "bg-current/5"
              }`}
            >
              <div className="grid h-16 w-16 shrink-0 place-items-center overflow-hidden rounded-xl bg-current/15">
                <GadgetImage path={seenMatch?.photo_url} gateKey={gateKey} />
              </div>
              <div
                className={`grid h-8 w-8 shrink-0 place-items-center rounded-full text-lg font-700 ${
                  ticked ? "bg-current/25" : "bg-current/10 opacity-40"
                }`}
                aria-hidden
              >
                {ticked ? "✓" : ""}
              </div>
              <div className="min-w-0">
                <p className="text-lg font-600 uppercase tracking-[0.14em] opacity-70">
                  <span className="capitalize">{g.gadget_type}</span> · {g.brand_model}
                </p>
                <p className="font-mono text-3xl font-700 leading-tight">{g.serial_number}</p>
              </div>
            </div>
          );
        })}
      </div>
      <button
        type="button"
        onClick={onDone}
        className="mt-8 rounded-full bg-current/15 px-8 py-3 text-lg font-700 uppercase tracking-[0.18em]"
      >
        Done
      </button>
    </div>
  );
}

/**
 * One row of the recent-taps panel.
 *
 * Carries the person rather than a pre-flattened label because a DENIED tap is
 * the row a guard most needs to read, and the old shape stored the literal
 * string "Denied" — throwing away who had just been refused. The fields mirror
 * what the result card shows, minus gadgets and registered vehicles: those run
 * to several lines each and would turn a glanceable row into a paragraph.
 */
interface RecentEntry {
  /** scan_time + uid: unique per tap, and stable, so React keys never reshuffle. */
  id: string;
  ok: boolean;
  at: string;
  name: string;
  deptLabel: string | null;
  dept: string | null;
  photoUrl?: string;
  /** Kept separate from photoUrl so a vehicle row can lead with the vehicle,
   *  the way the result card does — see the thumbnail branch in the panel. */
  vehiclePhotoUrl?: string;
  plate?: string;
  vehicleType?: string;
  reason: string | null;
}

/** Newest first, and only ever this many — see the panel's comment. */
const RECENT_LIMIT = 3;

export default function GateTerminal({ routeId }: { routeId: GateRouteId }) {
  const meta = GATE_ROUTES[routeId];
  const [config, setConfig] = useState<GateConfig | null>(null);
  const [ready, setReady] = useState(false);
  const [outcome, setOutcome] = useState<TapOutcome | null>(null);
  // A tap is in flight. Without this the screen still reads "Tap your card"
  // while the server decides, and the guard cannot tell a slow reply from a
  // card the reader never picked up.
  const [pending, setPending] = useState(false);
  const [recent, setRecent] = useState<RecentEntry[]>([]);
  const [devicePrompt, setDevicePrompt] = useState<DevicePrompt | null>(null);
  // Set only when an exit checklist closes with devices still unticked. Gold,
  // not red: the exit is never refused, this just tells the guard what to log.
  // Cleared on the very next tap so it never lingers over an unrelated scan.
  const [deviceWarning, setDeviceWarning] = useState<DeviceRow[] | null>(null);

  const busyRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Guards against a second dispatch reaching the same closure before React
  // commits the setDevicePrompt(null) below. A kiosk touchscreen can fire an
  // emulated and a native click for one press, and both would otherwise see the
  // same non-null prompt, compute the same `missing`, and file the audit row
  // twice — two gadget_not_returned rows for one exit, which is exactly the
  // double-count the row exists to make countable. Mirrors busyRef's shape.
  const closingRef = useRef(false);
  // Buffer for the global keydown listener below: the characters typed so
  // far in the current burst, and the timestamp of the last keystroke so the
  // next one can be checked against MAX_KEYSTROKE_GAP_MS.
  const bufferRef = useRef("");
  const lastKeyTimeRef = useRef<number | null>(null);

  // localStorage is unavailable during SSR, so config resolves after mount.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reading localStorage is only possible client-side, and this synchronizes local state with that external store once on mount.
    setConfig(getStoredGate(routeId));
    setReady(true);
  }, [routeId]);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  // Closes an exit checklist, warning in gold on anything still unticked and
  // filing the audit row for it. The exit itself is never in question here —
  // the person was already released by their own tap in step 1 — so this is
  // pure record-keeping: it always clears the prompt, and only touches the
  // network when there is something missing to log.
  const closeExitPrompt = useCallback(async () => {
    // A second dispatch (double-tap, or a touchscreen's emulated + native
    // click) reaching this closure before setDevicePrompt(null) commits would
    // otherwise see the same non-null prompt and file the same audit row
    // twice. Ignore it, never queue it — there is nothing to queue.
    if (closingRef.current) return;
    const p = devicePrompt;
    if (!p) return;
    closingRef.current = true;
    try {
      const missing = p.expected.filter((e) => !p.seen.some((s) => s.id === e.id));
      setDevicePrompt(null);
      if (missing.length === 0) return;
      setDeviceWarning(missing);
      if (!config) return;
      // Fire-and-log. The person is already outside — a failed audit write must
      // never hold the terminal, and the guard has the warning on screen either
      // way. Matches how liveHub.notifyScan is treated at the end of a tap.
      try {
        await fetch(`${API_BASE}/scan/gadget-session`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Gate-Key": config.key },
          body: JSON.stringify({
            person_id: p.personId,
            missing_gadget_ids: missing.map((m) => m.id),
          }),
        });
      } catch (err) {
        console.error("[gate] gadget session close failed", err);
      }
    } finally {
      // Reset unconditionally — including when the POST above throws — so a
      // later, genuinely new prompt is not stranded unable to close.
      closingRef.current = false;
    }
  }, [devicePrompt, config]);

  // Closes itself once the last expected device is read, so the guard does not
  // have to press anything in the normal case.
  useEffect(() => {
    if (!devicePrompt) return;
    if (devicePrompt.expected.length === 0) return;
    const allSeen = devicePrompt.expected.every((e) =>
      devicePrompt.seen.some((s) => s.id === e.id),
    );
    // eslint-disable-next-line react-hooks/set-state-in-effect -- this synchronizes devicePrompt with an external event (the last expected device being read by the physical RFID reader), not with other React state.
    if (allSeen) setDevicePrompt(null);
  }, [devicePrompt]);

  // Closes an unattended prompt so the next person does not tap into someone
  // else's session. Resets on every device tap, not on a fixed deadline: a guard
  // checking three laptops must not be cut off mid-queue. Always the exit lane
  // now — devicePrompt only ever exists in "exit" mode — so a timeout always
  // means the same thing: file the audit row for whatever's still unticked.
  useEffect(() => {
    if (!devicePrompt) return;
    const t = setTimeout(() => {
      void closeExitPrompt();
    }, 30_000);
    return () => clearTimeout(t);
  }, [devicePrompt, closeExitPrompt]);

  const handleUid = useCallback(async (uid: string) => {
    if (!config) return;
    // Ignore, never queue: a queued tap would let the next person through on a
    // result the guard has already read.
    if (busyRef.current) return;
    if (!UID_RE.test(uid)) return;

    busyRef.current = true;
    setPending(true);
    // Cleared on every new tap so a previous exit's gold warning never lingers
    // over an unrelated scan.
    setDeviceWarning(null);
    // releasedByTimer tracks whether the auto-reset timer below has taken
    // ownership of releasing busyRef. The finally block only releases it
    // itself when that hand-off never happened (early return or a throw) —
    // otherwise the timer would release early AND the finally would release
    // again, letting a second tap in before the guard has read the outcome.
    let releasedByTimer = false;
    try {
      const result = await postTap(config.key, uid);

      if (result.state === "unauthorized") {
        // The key is dead. Say so rather than refusing to grant.
        clearStoredGate(routeId);
        setConfig(null);
        return;
      }

      const isGrantedGadgetTap =
        (result.state === "granted" || result.state === "denied") &&
        result.person?.type === "gadget" &&
        result.access_result === "granted";

      if (isGrantedGadgetTap) {
        // Optional chaining, not `result.person.` — `isGrantedGadgetTap` is a
        // boolean const, so TypeScript does not carry its narrowing in here.
        const g = result.person?.gadgets?.[0];

        // Exit lane: this device tap is ticking off something already known
        // to be leaving — devicePrompt.expected, seeded from gadgets_inside on
        // the person's own exit tap moments earlier. That accounting is
        // unchanged: tick the line, no separate outcome card or Recent row of
        // its own — the checklist panel IS the record while it's open, and
        // closeExitPrompt is what turns "still unticked" into an audit row.
        if (devicePrompt && g) {
          setDevicePrompt((p) =>
            p && !p.seen.some((s) => s.id === g.id) ? { ...p, seen: [...p.seen, g] } : p,
          );
          return;
        }

        // Gadget Lane: no person tap ever opens a session here (see the
        // DevicePrompt comment above), so there is nothing to accumulate and
        // no Done button to wait for. Each gadget RFID sticker is its own
        // event — one tap in, one owner+device card out, one Recent row, then
        // straight back to ready for whatever's tapped next.
        if (meta.gadgetFocus && g) {
          setOutcome(result);
          const owner = result.person;
          setRecent((r) =>
            [
              {
                id: `${result.scan_time}:${result.rfid_uid}`,
                ok: true,
                at: new Date(result.scan_time).toLocaleTimeString(),
                name: owner?.full_name ?? "Unknown card",
                deptLabel: owner ? departmentLabel(owner) : null,
                dept: owner?.department_section ?? null,
                // Gadget Lane's Recent thumbnail is the DEVICE's own photo,
                // not the owner's — Recent here answers "what was just
                // tapped", and on this lane that's the gadget.
                photoUrl: g.photo_url,
                reason: result.reason,
              },
              ...r,
            ].slice(0, RECENT_LIMIT)
          );

          if (timerRef.current) clearTimeout(timerRef.current);
          timerRef.current = setTimeout(() => {
            setOutcome(null);
            busyRef.current = false;
          }, RESET_MS);
          releasedByTimer = true;
          return;
        }
      }

      setOutcome(result);
      if (result.state === "granted" || result.state === "denied") {
        const p = result.person;
        setRecent((r) =>
          [
            {
              id: `${result.scan_time}:${result.rfid_uid}`,
              ok: result.state === "granted",
              at: new Date(result.scan_time).toLocaleTimeString(),
              // "Unknown card" matches what the result card shows for a tap
              // the server could not attach to anybody — most often the exact
              // denial a guard is being asked to explain.
              name: p?.full_name ?? "Unknown card",
              deptLabel: p ? departmentLabel(p) : null,
              dept: p?.department_section ?? null,
              photoUrl: p?.photo_url,
              vehiclePhotoUrl: p?.vehicle_photo_url,
              plate: p?.plate_number,
              vehicleType: p?.vehicle?.vehicle_type,
              reason: result.reason,
            },
            ...r,
          ].slice(0, RECENT_LIMIT)
        );

        // Keyed on gadgets_inside, NOT on the route. The server sends this only on a
        // granted person EXIT tap and only when devices are actually still inside, so
        // every other tap on this terminal behaves exactly as it did before.
        if (
          meta.direction === "exit" &&
          result.access_result === "granted" &&
          result.person?.person_id &&
          (result.person.gadgets_inside?.length ?? 0) > 0
        ) {
          // Person B tapping out while person A's checklist is still open used
          // to overwrite it with a plain setDevicePrompt. That silently
          // destroyed A's audit row: the 30s timeout effect is keyed on
          // devicePrompt, so replacing the prompt runs the effect's cleanup,
          // clearing A's timer before it ever fired — and closeExitPrompt,
          // which is the ONLY thing that writes gadget_not_returned, never ran
          // for A. Their unreturned devices went unrecorded, which is the one
          // fact this whole lane exists to record.
          //
          // AWAITED, not fire-and-forget, and that is load-bearing against
          // closingRef: closeExitPrompt sets that guard on entry and clears it
          // in its finally, so a `void` call here would open B's prompt while
          // the guard was still raised for A's in-flight POST — and B's own
          // close would then hit the `if (closingRef.current) return` and be
          // skipped, turning one lost audit row into two. Awaiting resolves
          // after the finally, so the guard is down before B's prompt exists.
          //
          // Nothing about B's passage waits on this: the barrier decision was
          // made server-side and setOutcome already rendered it above. Only
          // the checklist is sequenced. A no-op when nothing is open —
          // closeExitPrompt returns immediately unless an exit prompt exists.
          await closeExitPrompt();
          setDevicePrompt({
            mode: "exit",
            personId: result.person.person_id,
            expected: result.person.gadgets_inside!,
            seen: [],
          });
        }
      }

      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        setOutcome(null);
        busyRef.current = false;
      }, RESET_MS);
      releasedByTimer = true;
    } finally {
      // Whatever throws — a network hang past the fetch timeout, a bug in the
      // branches above — the terminal must never stay silently busy forever.
      // The skeleton is cleared unconditionally: by here the call has either
      // produced an outcome to render or failed, and neither leaves anything
      // left to wait for.
      setPending(false);
      if (!releasedByTimer) busyRef.current = false;
    }
  }, [config, routeId, devicePrompt, meta, closeExitPrompt]);

  // Global listener: the reader is a keyboard, but no longer one we keep
  // focused. Every keystroke on the page is inspected instead, so a tap is
  // never dropped just because a guard clicked something. Two guards keep
  // this from swallowing real human input (see GateProvisioning's username
  // and password fields, rendered by this very component when unprovisioned):
  // it only runs once `config` is set (i.e. never on the provisioning
  // screen), and it ignores any event whose target is a form field or
  // contenteditable element.
  useEffect(() => {
    if (!config) return;

    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        target?.isContentEditable
      ) {
        return;
      }

      // Enter is handled before the gap check, and deliberately not
      // gap-checked itself: the characters were already gap-checked as they
      // arrived, so the buffer can only be well-formed (6-32 hex chars) if
      // those characters came in fast. A human typing hex digits slowly
      // would have had the buffer reset on each slow keystroke, leaving at
      // most one character in it — which UID_RE rejects anyway. So a slow
      // terminator can't let human typing through; gap-checking it too only
      // risks discarding a real reader burst whose firmware pauses (e.g. for
      // a checksum step) between the data and Enter.
      if (e.key === "Enter") {
        const uid = bufferRef.current;
        bufferRef.current = "";
        lastKeyTimeRef.current = null;
        if (uid) void handleUid(uid);
        return;
      }

      const now = performance.now();
      const last = lastKeyTimeRef.current;
      lastKeyTimeRef.current = now;
      if (last !== null && now - last > MAX_KEYSTROKE_GAP_MS) {
        // Too slow to be the reader — this is a human (or an unrelated
        // burst). Start over rather than mixing the two into one UID.
        bufferRef.current = "";
      }

      // Single printable characters only — modifier keys ("Shift",
      // "CapsLock", etc.) have multi-character e.key values and must not be
      // appended to the buffer.
      if (e.key.length === 1) {
        bufferRef.current += e.key;
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [config, handleUid]);

  // Config comes from localStorage, so the first paint has nothing to show yet.
  if (!ready) {
    return (
      <main className="min-h-dvh bg-ink text-white">
        <div className="mx-auto flex min-h-dvh max-w-4xl flex-col px-8 py-6">
          <header className="flex items-baseline justify-between">
            <div className="skeleton skeleton-idle h-5 w-48 rounded-md opacity-40" />
            <div className="skeleton skeleton-idle h-4 w-32 rounded-md opacity-40" />
          </header>
          <div className="flex flex-1 items-center justify-center">
            <GateCardSkeleton idle />
          </div>
          <footer className="border-t border-white/20 pt-3">
            <div className="skeleton skeleton-idle h-4 w-56 rounded-md opacity-40" />
          </footer>
        </div>
      </main>
    );
  }
  if (!config) return <GateProvisioning routeId={routeId} onProvisioned={setConfig} />;

  // Blue and orange mean the system decided; yellow means it did not. A guard
  // must never read a network failure as a grant.
  //
  // The palette has no dark warm, so orange and yellow carry navy text instead
  // of white — white on either is under 3:1 and unreadable across a lobby. Tone
  // therefore sets the foreground too, and everything layered on top uses
  // `current` alphas so it follows.
  const tone =
    outcome?.state === "granted"
      ? "bg-blue text-white"
      : outcome?.state === "denied"
        ? "bg-red text-navy"
        : outcome
          ? "bg-gold text-navy"
          : "bg-ink text-white";

  return (
    <main className={`min-h-dvh ${tone} transition-colors`}>
      <div className="mx-auto flex min-h-dvh max-w-4xl flex-col px-8 py-6">
        {/* Chrome sits on its own navy band rather than on the tone. The tone
            changes underneath it four ways, and small text at 14px cannot clear
            4.5:1 against the yellow and orange ones. On navy it is fixed at
            11.5:1, and gold works as an accent again. */}
        {/* items-center, not items-baseline: the seal has no text baseline to
            sit on, and baseline alignment would hang it below the gate name. */}
        <header className="-mx-8 -mt-6 flex items-center justify-between bg-ink px-8 py-3 text-white">
          <div className="flex items-center gap-3">
            <NcstMark className="h-8 w-8 shrink-0" />
            <p className="font-display text-lg font-700 uppercase tracking-[0.12em]">
              {config.name}
            </p>
          </div>
          <p className="text-sm font-600 uppercase tracking-[0.18em]">
            {meta.type} <span className="opacity-60">/</span>{" "}
            <span className="font-700 tracking-[0.24em] text-gold">{meta.direction}</span>
          </p>
        </header>

        <div className="flex flex-1 items-center justify-center">
          {!outcome && !pending && !devicePrompt && !deviceWarning && (
            <GateIdleScene gateType={meta.type} direction={meta.direction} />
          )}

          {/* The exit checklist's standalone survival past RESET_MS. Done
              here always runs closeExitPrompt, which is the only path that
              both clears the prompt and — if anything is still unticked —
              warns and files the audit row. */}
          {!outcome && !pending && devicePrompt && (
            <DevicePromptPanel
              prompt={devicePrompt}
              gateKey={config.key}
              onDone={() => void closeExitPrompt()}
            />
          )}

          {/* The exit is never refused — this is a record-keeping notice, not
              a denial, so it is gold with navy text like the no-device panel
              above, never red. Rendered whenever nothing else is claiming the
              center of the screen, so it survives past RESET_MS the same way
              the device prompt above it does. */}
          {!outcome && !pending && !devicePrompt && deviceWarning && (
            <div className="w-full text-center">
              <div className="mx-auto max-w-xl rounded-2xl bg-gold px-6 py-5 text-navy">
                <p className="font-display text-4xl font-700 uppercase tracking-tight">
                  Device not returned
                </p>
                <div className="mt-3 space-y-2 text-left">
                  {deviceWarning.map((g) => (
                    <p key={g.id} className="text-xl font-600">
                      <span className="capitalize">{g.gadget_type}</span> · {g.brand_model}
                      {" · SN "}
                      <span className="font-mono">{g.serial_number}</span>
                    </p>
                  ))}
                </div>
                <p className="mt-3 text-lg">Logged. This did not block the exit.</p>
              </div>
            </div>
          )}

          {/* In flight. The skeleton mirrors the result card below, so the real
              result replaces the placeholder in place instead of shifting the
              screen around. */}
          {!outcome && pending && (
            <div className="w-full text-center" aria-live="polite" aria-busy>
              <p className="font-mono text-xs uppercase tracking-[0.42em] text-gold/70">
                Verifying
              </p>
              <h1 className="mt-5 font-display text-6xl font-700 uppercase leading-[0.9] tracking-tight sm:text-7xl">
                Reading card
              </h1>
              <p className="mt-4 text-lg text-white/55">Checking with the server</p>
              <div className="mt-10">
                <GateCardSkeleton />
              </div>
            </div>
          )}

          {(outcome?.state === "granted" || outcome?.state === "denied") && (
            <div className="w-full">
              <p className="text-center font-display text-7xl font-700 uppercase tracking-tight">
                {outcome.access_result}
              </p>
              {/* The lane the tap was recorded against. Present on every route,
                  not just the gadget lane: the header band names the gate too,
                  but the guard reads the result card, and two person/entry
                  terminals now exist that are otherwise identical on screen. */}
              <p className="mt-1 text-center text-lg font-600 uppercase tracking-[0.18em] opacity-70">
                {config.name}
              </p>

              {/* GADGET LANE ONLY. Hoisted above the face because at this lane
                  the serial IS the job — the guard compares it to the laptop in
                  the person's hands — and a serial set below the fold in 24px
                  is a check nobody performs. The ordinary person-entry lane
                  keeps its compact inline list further down.

                  This now also covers the granted DEVICE tap itself (handleUid
                  sets `outcome` for every standalone gadget tap on this lane),
                  so a bare RFID sticker landing here shows the same owner face
                  + serial card a person tap would, not just a silent tick. */}
              {meta.gadgetFocus && outcome.access_result === "granted" && (
                <div className="mt-6">
                  {outcome.person?.gadgets && outcome.person.gadgets.length > 0 ? (
                    <div className="rounded-2xl bg-current/15 px-6 py-4">
                      {outcome.person.gadgets.map((g, i) => (
                        <div key={i} className={i > 0 ? "mt-3 border-t border-current/20 pt-3" : ""}>
                          <p className="text-xl font-600 uppercase tracking-[0.18em] opacity-70">
                            <span className="capitalize">{g.gadget_type}</span> · {g.brand_model}
                          </p>
                          <p className="font-mono text-5xl font-700 leading-tight">
                            {g.serial_number}
                          </p>
                        </div>
                      ))}
                    </div>
                  ) : (
                    /* Gold, not red: this is a prompt to send someone to
                       register, not a refusal. The gadget registry denies
                       nothing by design (see scan.service.ts:390), and the tap
                       above this panel still reads GRANTED. Gold carries navy
                       text per the tone note above. */
                    <div className="rounded-2xl bg-gold px-6 py-4 text-center text-navy">
                      <p className="font-display text-4xl font-700 uppercase tracking-tight">
                        No device registered
                      </p>
                      <p className="mt-1 text-xl font-600">
                        Admitted. Send them to register any device they are carrying.
                      </p>
                    </div>
                  )}
                </div>
              )}

              {/* The exit's checklist, keyed on gadgets_inside rather than on
                  meta.gadgetFocus (this route is never gadgetFocus) — see the
                  comment on where devicePrompt is set in handleUid. */}
              {devicePrompt && (
                <div className="mt-6">
                  <DevicePromptPanel
                    prompt={devicePrompt}
                    gateKey={config.key}
                    onDone={() => void closeExitPrompt()}
                  />
                </div>
              )}
              <div className="mt-8 flex items-center justify-center gap-8">
                {/* Vehicle gates lead with the vehicle: it is the thing the
                    guard is looking at. The owner's face sits beside it,
                    smaller, to confirm who is driving. Person gates keep the
                    single-avatar layout — they have no vehicle to show. */}
                {meta.type === "vehicle" && (
                  <SubjectFrame>
                    <VehicleImage
                      path={outcome.person?.vehicle_photo_url}
                      gateKey={config.key}
                    />
                  </SubjectFrame>
                )}
                {/* The Gadget Lane's own subject: the device that was just
                    tapped, beside the face of the student it is registered to.
                    That pairing IS the check on this lane — the sticker
                    resolves through the gadget's owner, so both halves are
                    known from the one tap. Granted only: a refused sticker
                    arrives with no owner photo at all (scan.service strips it
                    with the device list), and framing an empty box beside a
                    denial would read as a failed lookup. */}
                {meta.gadgetFocus && outcome.access_result === "granted" && (
                  <SubjectFrame>
                    <GadgetImage
                      path={outcome.person?.gadgets?.[0]?.photo_url}
                      gateKey={config.key}
                    />
                  </SubjectFrame>
                )}
                <div className="grid h-44 w-44 shrink-0 place-items-center overflow-hidden rounded-2xl bg-current/15">
                  {outcome.person ? (
                    <PersonAvatar
                      person={{
                        full_name: outcome.person.full_name,
                        photo_url: outcome.person.photo_url,
                      }}
                      headers={{ "X-Gate-Key": config.key }}
                    />
                  ) : (
                    <span className="font-display text-5xl font-700 opacity-60">?</span>
                  )}
                </div>
                {/* The person lane's other half. These are the devices this
                    person declared at the Gadget Lane moments ago, which THIS
                    tap just walked inside — so the guard sees the face and the
                    hardware together at the door that actually decides, rather
                    than having to remember a screen from the previous reader.
                    Two frames at most: the row is already carrying an avatar
                    and a text column, and every serial is listed in full
                    below regardless of how many fit here. */}
                {outcome.person?.gadgets_carried?.slice(0, 2).map((g) => (
                  <div key={g.id} className="shrink-0 text-center">
                    <div className="grid h-44 w-44 place-items-center overflow-hidden rounded-2xl bg-current/15">
                      <GadgetImage path={g.photo_url} gateKey={config.key} />
                    </div>
                    <p className="mt-2 text-lg font-600 uppercase tracking-[0.14em] opacity-70">
                      <span className="capitalize">{g.gadget_type}</span>
                    </p>
                  </div>
                ))}
                <div className="min-w-0">
                  <p className="font-display text-4xl font-700">
                    {outcome.person?.full_name ?? "Unknown card"}
                  </p>
                  {outcome.person && (
                    <p className="mt-1 text-2xl">
                      {departmentLabel(outcome.person)}: {outcome.person.department_section || "—"}
                    </p>
                  )}
                  {(() => {
                    const vehicleType = outcome.person?.vehicle?.vehicle_type;
                    const make = outcome.person?.vehicle?.make;
                    const plate = outcome.person?.plate_number;
                    if (!vehicleType && !make && !plate) return null;
                    return (
                      <p className="mt-1 text-2xl">
                        {[
                          vehicleType ? (
                            <span key="type" className="capitalize">
                              {vehicleType}
                            </span>
                          ) : null,
                          make,
                          plate,
                        ]
                          .filter(Boolean)
                          .map((part, i) => (
                            <Fragment key={i}>
                              {i > 0 && " · "}
                              {part}
                            </Fragment>
                          ))}
                      </p>
                    );
                  })()}
                  {outcome.person?.registered && outcome.person.registered.length > 0 && (
                    <p className="mt-1 text-2xl">
                      {outcome.person.registered.map((v, i) => (
                        <Fragment key={i}>
                          {i > 0 && ", "}
                          <RegisteredItem v={v} />
                        </Fragment>
                      ))}
                    </p>
                  )}
                  {/* Registered devices. The serial is what the guard actually
                      compares against the laptop in the person's hands, so it
                      is set in mono and never abbreviated. Deliberately text
                      rather than a photo frame: a picture of a black laptop
                      distinguishes it from no other black laptop, and a third
                      frame would compete with the owner's face. */}
                  {/* Suppressed on the gadget lane, where the same devices are
                      already shown full size above. Rendering both would put
                      the serial on screen twice at two sizes, which invites the
                      guard to read the smaller one. */}
                  {/* Carried devices are listed ahead of, and instead of, the
                      registered list below: "what they are walking in with"
                      answers a different question from "what they own", and
                      showing both puts the same serial on screen twice. */}
                  {outcome.person?.gadgets_carried?.map((g) => (
                    <p key={g.id} className="mt-1 text-2xl">
                      <span className="capitalize">{g.gadget_type}</span>
                      {" · "}
                      {g.brand_model}
                      {" · SN "}
                      <span className="font-mono font-700">{g.serial_number}</span>
                    </p>
                  ))}
                  {!meta.gadgetFocus &&
                    !outcome.person?.gadgets_carried &&
                    outcome.person?.gadgets?.map((g, i) => (
                      <p key={i} className="mt-1 text-2xl">
                        <span className="capitalize">{g.gadget_type}</span>
                        {" · "}
                        {g.brand_model}
                        {" · SN "}
                        <span className="font-mono font-700">{g.serial_number}</span>
                      </p>
                    ))}
                  {outcome.reason && (
                    <p className="mt-2 text-2xl">
                      {reasonText(outcome.reason)}
                    </p>
                  )}
                  {outcome.access_result === "granted" && !outcome.person?.photo_url && (
                    <p className="mt-2 text-xl font-700">No photo on file</p>
                  )}
                  <p className="mt-2 font-mono text-xl font-700">{outcome.rfid_uid}</p>
                </div>
              </div>
            </div>
          )}

          {outcome &&
            // "message" only exists on the offline/ratelimited/error arm; this
            // also narrows out "unauthorized", which handleUid never stores.
            "message" in outcome && (
              <div className="text-center">
                <p className="font-display text-6xl font-700 uppercase">
                  {outcome.state === "offline"
                    ? "Offline"
                    : outcome.state === "ratelimited"
                      ? "Slow down"
                      : "System error"}
                </p>
                <p className="mt-3 text-xl">{outcome.message}</p>
                <p className="mt-1 text-lg">The tap was not recorded.</p>
              </div>
            )}
        </div>

        {/* Recent taps. On its own navy band for the same reason the header is
            (see above): the tone behind it changes four ways and small text
            cannot clear 4.5:1 against the yellow and orange ones.

            Capped at RECENT_LIMIT rather than scrolling. The panel exists so a
            guard can answer "who just went through?" at a glance — a list long
            enough to need reading is a list nobody reads at a barrier, and a
            fixed three rows also keeps the result card's height from moving as
            taps accumulate. Newest first, because the answer is almost always
            the last person. */}
        <footer className="-mx-8 -mb-6 shrink-0 bg-ink px-8 pb-7 pt-5 text-white">
          <p className="font-mono text-sm uppercase tracking-[0.3em] text-white/45">
            Recent
          </p>
          {/* Always RECENT_LIMIT slots, filled or not. The panel's height is
              therefore constant from the first tap, so the result card above it
              never shifts as the list fills — the jump used to happen on each of
              the first three taps of a shift, which is precisely when a guard is
              looking at the screen. Empty slots read as "taps appear here"
              rather than as missing content. */}
          <ul className="mt-4 space-y-3">
            {Array.from({ length: RECENT_LIMIT }).map((_, slot) => {
              const r = recent[slot];
              if (!r) {
                return (
                  <li
                    key={`empty-${slot}`}
                    className="flex h-26 items-center rounded-2xl border border-dashed border-white/10 px-4"
                    aria-hidden
                  >
                    <span className="text-xl text-white/25">
                      {slot === 0 && recent.length === 0 ? "No scans yet" : ""}
                    </span>
                  </li>
                );
              }
              return (
                <li
                  key={r.id}
                  // Only the top slot animates; see .tap-in in globals.css.
                  className={`flex h-26 items-center gap-5 rounded-2xl border border-white/10 bg-linear-to-b from-white/9 to-white/4 px-4 ${
                    slot === 0 ? "tap-in" : ""
                  }`}
                >
                  {/* Vehicle gates lead with the vehicle here too, matching the
                      result card's reasoning: it is what the guard is looking
                      at. One thumbnail, not the card's two — a second frame at
                      this size reads as clutter rather than confirmation.

                      Gadget-lane rows likewise lead with what was actually
                      tapped: `r.photoUrl` was set to the gadget's own photo
                      for a device tap, so this same PersonAvatar branch (it's
                      just an image-with-fallback, keyed off `photoUrl`) shows
                      the device thumbnail without needing a third branch. */}
                  <div className="grid h-20 w-20 shrink-0 place-items-center overflow-hidden rounded-lg bg-white/10">
                    {meta.type === "vehicle" ? (
                      <VehicleImage path={r.vehiclePhotoUrl} gateKey={config.key} />
                    ) : (
                      <PersonAvatar
                        person={{ full_name: r.name, photo_url: r.photoUrl }}
                        headers={{ "X-Gate-Key": config.key }}
                      />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-3xl font-700">{r.name}</p>
                    <p className="truncate text-lg text-white/65">
                      {/* Same values the result card shows, in its order:
                          department, then the vehicle, then the denial reason.
                          Assembled by filtering so a row never renders a
                          dangling separator when a field is absent. */}
                      {[
                        r.deptLabel ? `${r.deptLabel}: ${r.dept || "—"}` : null,
                        r.vehicleType,
                        r.plate,
                        r.reason ? reasonText(r.reason) : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p
                      className={`font-display text-lg font-700 uppercase tracking-[0.14em] ${
                        r.ok ? "text-blue" : "text-red"
                      }`}
                    >
                      {r.ok ? "Granted" : "Denied"}
                    </p>
                    <p className="font-mono text-lg text-white/55">{r.at}</p>
                  </div>
                </li>
              );
            })}
          </ul>
        </footer>
      </div>
    </main>
  );
}