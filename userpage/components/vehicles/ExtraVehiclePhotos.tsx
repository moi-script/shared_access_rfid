"use client";

import { useState } from "react";
import AuthedImage from "@/components/AuthedImage";
import PhotoCapture from "@/components/PhotoCapture";
import { apiDelete, apiUpload } from "@/lib/auth";

/**
 * The four additional angles a vehicle may carry beyond its main photo.
 *
 * Slot numbers, not array positions, are what the server stores against, so
 * clearing slot 3 leaves slots 1, 2 and 4 exactly where they were instead of
 * shuffling the remaining photos down. The array here is indexed by
 * `slot - 1`; EXTRA_PHOTO_SLOTS is the only place that mapping is written.
 */
export const EXTRA_PHOTO_SLOTS = [1, 2, 3, 4] as const;

export type ExtraPhotos = (Blob | null)[];

export const emptyExtraPhotos = (): ExtraPhotos => [null, null, null, null];

export const extraPhotoPath = (vehicleId: string, slot: number) =>
  `/vehicles/${vehicleId}/photos/${slot}`;

/**
 * Uploads whichever slots were filled, one request per photo.
 *
 * Collects a message per slot that failed rather than throwing: a vehicle whose
 * record and main photo already saved must not be reported as a failed
 * registration because a third supporting angle didn't upload. Callers fold
 * these into the same "registered, but…" notice they already show for the main
 * photo.
 *
 * `urls` is the server's own list of what the vehicle now holds, taken from the
 * last successful upload, so a caller can refresh its view without a refetch.
 * Null when nothing was uploaded.
 */
export async function uploadExtraPhotos(
  vehicleId: string,
  photos: ExtraPhotos
): Promise<{ failures: string[]; urls: string[] | null }> {
  const failures: string[] = [];
  let urls: string[] | null = null;
  for (const slot of EXTRA_PHOTO_SLOTS) {
    const blob = photos[slot - 1];
    if (!blob) continue;
    try {
      const fd = new FormData();
      fd.append("photo", blob, `vehicle-${slot}.jpg`);
      const res = await apiUpload<{ extra_photo_urls: string[] }>(
        extraPhotoPath(vehicleId, slot),
        fd
      );
      urls = res.extra_photo_urls ?? urls;
    } catch (err) {
      failures.push(`additional photo ${slot} (${(err as Error).message})`);
    }
  }
  return { failures, urls };
}

export default function ExtraVehiclePhotos({
  value,
  onChange,
  vehicleId,
  existing = [],
  onExistingChange,
}: {
  value: ExtraPhotos;
  onChange: (next: ExtraPhotos) => void;
  /** Set only when the vehicle already exists (the edit form), which is what
   *  makes the stored photos fetchable and removable. */
  vehicleId?: string;
  /** Stored `/vehicles/:id/photos/:slot` paths, as the server reports them. */
  existing?: string[];
  onExistingChange?: (next: string[]) => void;
}) {
  const filled = value.filter(Boolean).length;
  // Collapsed by default: these are optional, and four capture widgets unfolded
  // under the required fields buries the Register button on a desk monitor.
  const [open, setOpen] = useState(false);
  const [removing, setRemoving] = useState<number | null>(null);

  function setSlot(slot: number, blob: Blob | null) {
    const next = [...value];
    next[slot - 1] = blob;
    onChange(next);
  }

  const storedSlots = new Set(
    existing
      .map((url) => Number(url.split("/").pop()))
      .filter((slot) => Number.isInteger(slot))
  );

  async function removeStored(slot: number) {
    if (!vehicleId) return;
    setRemoving(slot);
    try {
      const res = await apiDelete<{ extra_photo_urls: string[] }>(
        extraPhotoPath(vehicleId, slot)
      );
      onExistingChange?.(res.extra_photo_urls ?? []);
    } catch {
      // Deliberately quiet. The photo is still there, the caption still says
      // so on the next render, and a failed optional delete is not worth
      // taking over the form's single error slot from a save in progress.
    } finally {
      setRemoving(null);
    }
  }

  return (
    <div className="rounded-xl border border-line bg-white p-3">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between text-left"
      >
        <span className="text-[13px] font-600 text-ink-soft">
          Additional photos — optional, up to 4
          {filled > 0 && <span className="ml-1 font-700 text-ink">({filled} ready)</span>}
          {storedSlots.size > 0 && (
            <span className="ml-1 text-ink-soft">({storedSlots.size} on file)</span>
          )}
        </span>
        <span className="text-[13px] font-600 text-navy">{open ? "Hide" : "Show"}</span>
      </button>

      {open && (
        <>
          <p className="mt-1 text-[12px] text-ink-soft">
            Other angles of the same vehicle. The main photo above is the only one
            the guard sees at the barrier.
          </p>
          {/* One column until there is genuinely room for two. The forms that
              render this are capped-width dialogs, so a viewport-wide `sm:`
              two-up was splitting a ~300px panel into two columns narrower
              than a single capture widget. */}
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            {EXTRA_PHOTO_SLOTS.map((slot) => {
              const stored = storedSlots.has(slot);
              return (
                <div key={slot} className="min-w-0 space-y-1 rounded-lg border border-line/60 p-2">
                  <div className="flex items-center justify-between">
                    <p className="text-[12px] font-600 text-ink-soft">Photo {slot}</p>
                    {stored && vehicleId && (
                      <button
                        type="button"
                        disabled={removing === slot}
                        onClick={() => void removeStored(slot)}
                        className="rounded px-1 text-[12px] font-600 text-ink-soft hover:bg-red/25 hover:text-ink disabled:opacity-60"
                      >
                        {removing === slot ? "Removing…" : "Remove"}
                      </button>
                    )}
                  </div>
                  {stored && vehicleId && !value[slot - 1] && (
                    <div className="grid h-24 w-full place-items-center overflow-hidden rounded-lg border border-line bg-paper text-[11px] text-ink-soft sm:h-28">
                      <AuthedImage
                        path={extraPhotoPath(vehicleId, slot)}
                        alt={`Additional vehicle photo ${slot}`}
                        className="h-full w-full object-contain"
                        fallback={<span>On file</span>}
                      />
                    </div>
                  )}
                  <PhotoCapture onChange={(blob) => setSlot(slot, blob)} fit="whole" />
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
