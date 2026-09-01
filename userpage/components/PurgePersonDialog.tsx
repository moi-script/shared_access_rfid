"use client";

import { useEffect, useState } from "react";
import { apiDelete, apiGetList } from "@/lib/auth";
import Notice from "@/components/Notice";

/**
 * Test-data-only. This is NOT DeletePersonDialog's cascade — that one
 * deactivates vehicles, blocks the card forever, and can be undone with
 * Restore. This one calls DELETE /persons/:id/purge, which hard-deletes the
 * person, every vehicle and gadget they ever registered (any status), and
 * frees any RFID UID they held for immediate reuse. There is no restore.
 * The server itself refuses this outside a non-production environment, so
 * the worst this dialog can do in prod is surface that refusal.
 *
 * Kept as its own component rather than a prop on DeletePersonDialog so the
 * two actions can never be reached through the same button by accident.
 */
export default function PurgePersonDialog({
  personId,
  personName,
  rfidUid,
  onClose,
  onPurged,
}: {
  personId: string;
  personName: string;
  rfidUid: string | null;
  onClose: () => void;
  onPurged: () => void;
}) {
  const [loadingImpact, setLoadingImpact] = useState(true);
  const [vehicleCount, setVehicleCount] = useState(0);
  const [gadgetCount, setGadgetCount] = useState(0);
  const [impactError, setImpactError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [purging, setPurging] = useState(false);
  const [confirmText, setConfirmText] = useState("");

  useEffect(() => {
    let cancelled = false;
    // limit=1: only the total is needed, not the rows themselves. Counts
    // ALL statuses, not just active — a hard purge removes inactive rows
    // too, and the warning has to be honest about that.
    Promise.all([
      apiGetList(`/vehicles?owner_person_id=${personId}&limit=1`),
      apiGetList(`/gadgets?owner_person_id=${personId}&limit=1`),
    ])
      .then(([vehicles, gadgets]) => {
        if (cancelled) return;
        setVehicleCount(vehicles.total);
        setGadgetCount(gadgets.total);
      })
      .catch((err: Error) => {
        if (!cancelled) setImpactError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoadingImpact(false);
      });
    return () => {
      cancelled = true;
    };
  }, [personId]);

  async function confirmPurge() {
    setError(null);
    setPurging(true);
    try {
      await apiDelete(`/persons/${personId}/purge`);
      onPurged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPurging(false);
    }
  }

  const confirmed = confirmText.trim() === personName.trim();

  return (
    <div className="fixed inset-0 z-50 grid place-items-start overflow-auto bg-ink/40 p-4 sm:p-8">
      <div className="mx-auto w-full max-w-md space-y-3 rounded-2xl border-2 border-red bg-white p-6">
        <div className="flex items-center justify-between">
          <h2 className="font-display text-xl font-700 tracking-tight text-ink">
            Permanently erase (test data)
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-[14px] font-600 text-ink-soft hover:text-ink"
          >
            Cancel
          </button>
        </div>

        <p className="text-[13px] text-ink-soft">
          For <span className="font-600 text-ink">{personName}</span>
        </p>

        <Notice className="text-[13px] font-600 text-ink">
          This is not the normal Delete. It hard-deletes this person from the
          database — not a soft delete, no Restore afterward.
        </Notice>

        {loadingImpact ? (
          <p className="rounded-xl bg-paper px-4 py-3 text-[13px] text-ink-soft">
            Checking what this deletes…
          </p>
        ) : impactError ? (
          <Notice compact className="text-[13px] text-ink">
            Couldn&apos;t confirm the impact: {impactError}
          </Notice>
        ) : (
          <ul className="list-disc space-y-1 rounded-xl bg-red/10 px-5 py-3 text-[13px] text-ink">
            <li>The person record, permanently</li>
            <li>
              {vehicleCount} vehicle{vehicleCount === 1 ? "" : "s"} they ever registered, any
              status
            </li>
            <li>
              {gadgetCount} gadget{gadgetCount === 1 ? "" : "s"} they ever registered, any status
            </li>
            <li>Their photo, signature, and every vehicle/gadget photo above</li>
            {rfidUid ? (
              <li className="font-600">
                Card {rfidUid} is freed for reuse — unlike normal delete, it is not blocked
              </li>
            ) : (
              <li>No card on file to free</li>
            )}
          </ul>
        )}

        {error && (
          <Notice compact className="text-[13px] text-ink">
            {error}
          </Notice>
        )}

        <label className="block text-[13px] font-600 text-ink-soft">
          Type the person&apos;s full name to confirm
          <input
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder={personName}
            className="mt-1 w-full rounded-xl border border-line bg-white px-3 py-2 text-[14px] text-ink outline-none focus:border-red focus:ring-4 focus:ring-red/20"
          />
        </label>

        <button
          type="button"
          onClick={confirmPurge}
          disabled={purging || loadingImpact || Boolean(impactError) || !confirmed}
          className="w-full rounded-xl border-2 border-red bg-red px-4 py-2.5 text-sm font-600 text-white hover:bg-red/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {purging ? "Erasing…" : "Erase permanently"}
        </button>
      </div>
    </div>
  );
}
