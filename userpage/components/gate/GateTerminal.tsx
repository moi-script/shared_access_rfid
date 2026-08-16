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

const RESET_MS = 5000;
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
  const effectiveType = person.owner_type ?? person.type;
  return effectiveType === "student" ? "Course & Section" : "Department";
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

export default function GateTerminal({ routeId }: { routeId: GateRouteId }) {
  const meta = GATE_ROUTES[routeId];
  const [config, setConfig] = useState<GateConfig | null>(null);
  const [ready, setReady] = useState(false);
  const [outcome, setOutcome] = useState<TapOutcome | null>(null);
  // A tap is in flight. Without this the screen still reads "Tap your card"
  // while the server decides, and the guard cannot tell a slow reply from a
  // card the reader never picked up.
  const [pending, setPending] = useState(false);
  const [recent, setRecent] = useState<{ label: string; at: string; ok: boolean }[]>([]);

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
        // The key is dead. Say so rather than silently refusing to grant.
        clearStoredGate(routeId);
        setConfig(null);
        return;
      }

      setOutcome(result);
      if (result.state === "granted" || result.state === "denied") {
        const label =
          result.state === "granted" ? result.person?.full_name ?? "Vehicle" : "Denied";
        setRecent((r) =>
          [
            { label, at: new Date(result.scan_time).toLocaleTimeString(), ok: result.state === "granted" },
            ...r,
          ].slice(0, 5)
        );
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
  }, [config, routeId]);

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
          {!outcome && !pending && (
            <GateIdleScene gateType={meta.type} direction={meta.direction} />
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
                  {outcome.person?.gadgets?.map((g, i) => (
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

        <footer className="-mx-8 -mb-6 bg-ink px-8 py-3 text-sm text-white/80">
          {recent.length === 0 ? (
            <span>No scans yet</span>
          ) : (
            <div className="flex flex-wrap gap-x-6 gap-y-1">
              {recent.map((r, i) => (
                <span key={i}>
                  {r.ok ? "ok" : "no"} · {r.at} · {r.label}
                </span>
              ))}
            </div>
          )}
        </footer>
      </div>
    </main>
  );
}
