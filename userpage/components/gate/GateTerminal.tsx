"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import AuthedImage, { PersonAvatar } from "@/components/AuthedImage";
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

const RESET_MS = 750;
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

type DeviceRow = {
  id: string;
  gadget_type: string;
  brand_model: string;
  serial_number: string;
  photo_url?: string;
};

/**
 * The two-step prompt.
 *
 * Presentation only — there is no server session. Each gadget tap is an
 * ordinary POST /scan/tap that has already moved that device's occupancy row
 * by the time it appears here. So a terminal reload mid-prompt loses the
 * checklist but never loses the record: everything tapped so far stands.
 */
type DevicePrompt = {
  mode: "entry" | "exit";
  personId: string;
  expected: DeviceRow[];
  seen: DeviceRow[];
};

/** The gadget-lane device checklist. Rendered both inside the granted result
 *  card (immediately after the person's own tap) and, once that card's
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
  if (prompt.mode !== "entry") return null;
  return (
    <div className="w-full text-center">
      <p className="font-mono text-xs uppercase tracking-[0.42em] text-gold/70">Gadget Lane</p>
      <h1 className="mt-5 font-display text-5xl font-700 uppercase leading-[0.9] tracking-tight">
        Tap devices
      </h1>
      {prompt.seen.length === 0 ? (
        <p className="mt-4 text-lg text-white/55">Tap each device now, or press Done</p>
      ) : (
        <div className="mx-auto mt-6 max-w-xl space-y-3 text-left">
          {prompt.seen.map((g) => (
            <div
              key={g.id}
              className="flex items-center gap-4 rounded-2xl bg-current/15 px-5 py-3"
            >
              <div className="grid h-16 w-16 shrink-0 place-items-center overflow-hidden rounded-xl bg-current/15">
                <GadgetImage path={g.photo_url} gateKey={gateKey} />
              </div>
              <div className="min-w-0">
                <p className="text-lg font-600 uppercase tracking-[0.14em] opacity-70">
                  <span className="capitalize">{g.gadget_type}</span> · {g.brand_model}
                </p>
                <p className="font-mono text-3xl font-700 leading-tight">{g.serial_number}</p>
              </div>
            </div>
          ))}
        </div>
      )}
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

  const busyRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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

  // Closes an unattended prompt so the next person does not tap into someone
  // else's session. Resets on every device tap, not on a fixed deadline: a guard
  // checking three laptops must not be cut off mid-queue.
  useEffect(() => {
    if (!devicePrompt) return;
    const t = setTimeout(() => setDevicePrompt(null), 30_000);
    return () => clearTimeout(t);
  }, [devicePrompt]);

  const handleUid = useCallback(async (uid: string) => {
    if (!config) return;
    // Ignore, never queue: a queued tap would let the next person through on a
    // result the guard has already read.
    if (busyRef.current) return;
    if (!UID_RE.test(uid)) return;

    busyRef.current = true;
    setPending(true);
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

      // A device tap while the prompt is open ticks a line instead of replacing the
      // whole screen. Deduped by id so a double-read of the same sticker — common
      // when someone holds it against the reader — does not list it twice.
      if (
        devicePrompt &&
        (result.state === "granted" || result.state === "denied") &&
        result.person?.type === "gadget" &&
        result.access_result === "granted"
      ) {
        const g = result.person.gadgets?.[0];
        if (g) {
          setDevicePrompt((p) =>
            p && !p.seen.some((s) => s.id === g.id) ? { ...p, seen: [...p.seen, g] } : p,
          );
        }
        return;
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

        // The gadget lane opens the prompt on a granted PERSON tap. A gadget tap
        // arriving while the prompt is open is handled above and must not reopen it.
        if (
          meta.gadgetFocus &&
          result.access_result === "granted" &&
          result.person?.type !== "gadget" &&
          result.person?.person_id
        ) {
          setDevicePrompt({
            mode: "entry",
            personId: result.person.person_id,
            expected: [],
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
  }, [config, routeId, devicePrompt, meta]);

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
        <header className="-mx-8 -mt-6 flex items-baseline justify-between bg-ink px-8 py-3 text-white">
          <p className="font-display text-lg font-700 uppercase tracking-[0.12em]">{config.name}</p>
          <p className="text-sm font-600 uppercase tracking-[0.18em]">
            {meta.type} <span className="opacity-60">/</span>{" "}
            <span className="font-700 tracking-[0.24em] text-gold">{meta.direction}</span>
          </p>
        </header>

        <div className="flex flex-1 items-center justify-center">
          {!outcome && !pending && !devicePrompt && (
            <GateIdleScene gateType={meta.type} direction={meta.direction} />
          )}

          {/* Once the granted card below auto-resets after RESET_MS, the
              device prompt keeps the screen open on its own — it is driven
              by devicePrompt, not by outcome. */}
          {!outcome && !pending && devicePrompt?.mode === "entry" && (
            <DevicePromptPanel
              prompt={devicePrompt}
              gateKey={config.key}
              onDone={() => setDevicePrompt(null)}
            />
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
                  keeps its compact inline list further down. */}
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

              {/* The device checklist starts as soon as the person is granted.
                  Shown here so the guard sees it immediately, before RESET_MS
                  pulls this card away — see the standalone panel above for
                  what keeps showing it afterward. */}
              {meta.gadgetFocus && devicePrompt?.mode === "entry" && (
                <div className="mt-6">
                  <DevicePromptPanel
                    prompt={devicePrompt}
                    gateKey={config.key}
                    onDone={() => setDevicePrompt(null)}
                  />
                </div>
              )}
              <div className="mt-8 flex items-center justify-center gap-8">
                {/* Vehicle gates lead with the vehicle: it is the thing the
                    guard is looking at. The owner's face sits beside it,
                    smaller, to confirm who is driving. Person gates keep the
                    single-avatar layout — they have no vehicle to show. */}
                {meta.type === "vehicle" && (
                  <div className="grid h-56 w-72 shrink-0 place-items-center overflow-hidden rounded-2xl bg-current/15">
                    <VehicleImage
                      path={outcome.person?.vehicle_photo_url}
                      gateKey={config.key}
                    />
                  </div>
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
                  {!meta.gadgetFocus &&
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
                      this size reads as clutter rather than confirmation. */}
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
