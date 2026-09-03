"use client";

import { useEffect, useState } from "react";
import { TfiCar } from "react-icons/tfi";
import AuthedImage from "@/components/AuthedImage";

/**
 * The vehicle's additional registration angles, as a thumbnail strip that
 * opens one photo full-size on click.
 *
 * Its own client component rather than markup inside ProfileView: the lightbox
 * needs state, and ProfileView is rendered from both a client dashboard and a
 * server shell. Keeping the interactive part here leaves that unchanged.
 */
export default function VehiclePhotoStrip({
  urls,
  label,
}: {
  /** Authenticated `/vehicles/:id/photos/:slot` paths, as the server sends. */
  urls: string[];
  /** Plate number, used for alt text and the lightbox caption. */
  label: string;
}) {
  const [open, setOpen] = useState<string | null>(null);

  // Escape closes the lightbox — it covers the whole screen, and a mouse is not
  // always the fastest way out of it at a registration desk.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (urls.length === 0) return null;

  return (
    <>
      <div className="flex flex-wrap gap-2">
        {urls.map((url, i) => (
          <button
            key={url}
            type="button"
            onClick={() => setOpen(url)}
            title="View larger"
            className="grid h-12 w-16 shrink-0 place-items-center overflow-hidden rounded-lg border border-line bg-paper text-ink-soft hover:border-navy"
          >
            <AuthedImage
              path={url}
              alt={`${label} — additional photo ${i + 1}`}
              // contain, like EntityThumb: these are whole-frame photos of any
              // shape, and filling a fixed landscape tile would crop them on
              // screen a second time.
              className="h-full w-full object-contain"
              fallback={<TfiCar aria-hidden className="h-4 w-4" />}
            />
          </button>
        ))}
      </div>

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`${label} photo`}
          onClick={() => setOpen(null)}
          className="fixed inset-0 z-50 grid place-items-center bg-ink/70 p-6"
        >
          <div className="max-h-full w-full max-w-2xl space-y-2">
            <div className="grid max-h-[75vh] place-items-center overflow-hidden rounded-2xl border border-line bg-white p-2">
              <AuthedImage
                path={open}
                alt={`${label} — additional photo`}
                className="max-h-[70vh] w-full object-contain"
                fallback={<span className="p-8 text-[14px] text-ink-soft">Photo unavailable</span>}
              />
            </div>
            <p className="text-center text-[13px] font-600 text-white">
              {label} — click anywhere or press Esc to close
            </p>
          </div>
        </div>
      )}
    </>
  );
}
