"use client";

import { useState } from "react";
import { apiPatch, apiUpload } from "@/lib/auth";
import PhotoCapture from "@/components/PhotoCapture";
import ExtraVehiclePhotos, {
  emptyExtraPhotos,
  uploadExtraPhotos,
  type ExtraPhotos,
} from "@/components/vehicles/ExtraVehiclePhotos";
import Notice from "@/components/Notice";
import { VEHICLE_TYPES } from "@/lib/vehicleTypes";

const inputCls =
  "w-full rounded-xl border border-line bg-white px-3 py-2 text-[14px] text-ink outline-none focus:border-blue focus:ring-4 focus:ring-blue/12";

export interface EditableVehicle {
  _id: string;
  plate_number: string;
  vehicle_type: string;
  vehicle_model: string | null;
  make?: string | null;
  color?: string | null;
  // Read-only display only — see the note above the field below.
  rfid_uid: string;
  /** Stored additional angles, so this form can show what is already on file
   *  and let the operator drop one. Absent on vehicles registered before
   *  extra photos existed. */
  extra_photo_urls?: string[] | null;
}

export default function VehicleEditForm({
  vehicle,
  onSaved,
  onClose,
}: {
  vehicle: EditableVehicle;
  onSaved: (updated: EditableVehicle & { photo_url?: string }) => void;
  onClose: () => void;
}) {
  const [form, setForm] = useState({
    plate_number: vehicle.plate_number,
    vehicle_type: vehicle.vehicle_type,
    vehicle_model: vehicle.vehicle_model ?? "",
    make: vehicle.make ?? "",
    color: vehicle.color ?? "",
  });
  const [photo, setPhoto] = useState<Blob | null>(null);
  const [extraPhotos, setExtraPhotos] = useState<ExtraPhotos>(emptyExtraPhotos);
  // Mirrors what the server says is on file. Kept in state rather than read
  // straight off the prop so removing a slot updates the strip immediately,
  // without waiting for the parent to refetch the profile.
  const [storedExtras, setStoredExtras] = useState<string[]>(
    vehicle.extra_photo_urls ?? []
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function set(k: keyof typeof form, v: string) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      // rfid_uid is deliberately not sent: vehicles.service.update rejects any
      // rfid_uid that differs from the vehicle's current one (a pass carries
      // its owner's card, not a tag of its own), so omitting it here is what
      // keeps a plain field edit from tripping that check.
      const payload: Record<string, string> = {
        plate_number: form.plate_number.trim(),
        vehicle_type: form.vehicle_type,
      };
      const model = form.vehicle_model.trim();
      const make = form.make.trim();
      const color = form.color.trim();
      if (model) payload.vehicle_model = model;
      if (make) payload.make = make;
      if (color) payload.color = color;

      const updated = await apiPatch<EditableVehicle & { photo_url?: string }>(
        `/vehicles/${vehicle._id}`,
        payload
      );
      if (photo) {
        try {
          const fd = new FormData();
          fd.append("photo", photo, "vehicle.jpg");
          const uploaded = await apiUpload<{ photo_url: string }>(
            `/vehicles/${vehicle._id}/photo`,
            fd
          );
          updated.photo_url = uploaded.photo_url;
        } catch (photoErr) {
          // The field edits are already saved. Left open so re-submitting
          // just re-PATCHes the same values and retries the photo.
          setError(
            `Saved, but the photo didn't upload: ${(photoErr as Error).message}. ` +
              "Click Save changes to retry the photo."
          );
          setSaving(false);
          return;
        }
      }
      // Extras last, and non-fatally: the field edits and the main photo are
      // already saved, so a supporting angle that fails to upload is reported
      // and the dialog stays open for a retry rather than losing the save.
      const extras = await uploadExtraPhotos(vehicle._id, extraPhotos);
      if (extras.urls) setStoredExtras(extras.urls);
      if (extras.failures.length > 0) {
        setError(
          `Saved, but ${extras.failures.join(", ")} didn't upload. ` +
            "Click Save changes to retry."
        );
        setSaving(false);
        return;
      }
      updated.extra_photo_urls = extras.urls ?? storedExtras;
      onSaved(updated);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40 grid place-items-start overflow-auto bg-ink/40 p-4 sm:p-8">
      <form
        onSubmit={submit}
        className="mx-auto w-full max-w-lg space-y-3 rounded-2xl border border-line bg-white p-6"
      >
        <div className="flex items-center justify-between">
          <h2 className="font-display text-xl font-700 tracking-tight text-ink">
            Edit vehicle
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-[14px] font-600 text-ink-soft hover:text-ink"
          >
            Cancel
          </button>
        </div>

        {error && (
          <Notice compact className="text-[13px] text-ink">
            {error}
          </Notice>
        )}

        <div className="grid grid-cols-2 gap-3">
          <label className="block text-[13px] font-600 text-ink-soft">
            Plate number
            <input
              required
              value={form.plate_number}
              onChange={(e) => set("plate_number", e.target.value)}
              className={`mt-1 font-mono ${inputCls}`}
            />
          </label>
          <label className="block text-[13px] font-600 text-ink-soft">
            Vehicle type
            <select
              value={form.vehicle_type}
              onChange={(e) => set("vehicle_type", e.target.value)}
              className={`mt-1 ${inputCls}`}
            >
              {VEHICLE_TYPES.map((t) => (
                <option key={t} value={t} className="capitalize">
                  {t[0].toUpperCase() + t.slice(1)}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="grid grid-cols-2 gap-3">
          {/* <label className="block text-[13px] font-600 text-ink-soft">
            Make
            <input
              value={form.make}
              onChange={(e) => set("make", e.target.value)}
              className={`mt-1 ${inputCls}`}
            />
          </label> */}
          {/* <label className="block text-[13px] font-600 text-ink-soft">
            Model
            <input
              value={form.vehicle_model}
              onChange={(e) => set("vehicle_model", e.target.value)}
              className={`mt-1 ${inputCls}`}
            />
          </label> */}
        </div>

        {/* <label className="block text-[13px] font-600 text-ink-soft">
          Color
          <input
            value={form.color}
            onChange={(e) => set("color", e.target.value)}
            className={`mt-1 ${inputCls}`}
          />
        </label> */}

        <label className="block text-[13px] font-600 text-ink-soft">
          RFID UID
          <input
            value={vehicle.rfid_uid}
            disabled
            readOnly
            className="mt-1 w-full rounded-xl border border-line bg-paper px-3 py-2 font-mono text-ink-soft"
          />
          <span className="mt-1 block text-[12px] text-ink-soft">
            Read-only — a vehicle pass uses its owner&apos;s card. Replace the
            owner&apos;s card to change this.
          </span>
        </label>

        <div>
          <p className="mb-1 text-[13px] font-600 text-ink-soft">
            Photo — leave blank to keep the current one
          </p>
          <PhotoCapture onChange={setPhoto} fit="whole" />
        </div>

        <ExtraVehiclePhotos
          value={extraPhotos}
          onChange={setExtraPhotos}
          vehicleId={vehicle._id}
          existing={storedExtras}
          onExistingChange={setStoredExtras}
        />

        <button
          type="submit"
          disabled={saving}
          className="w-full rounded-xl bg-navy px-4 py-2.5 text-sm font-600 text-white hover:bg-navy/90 disabled:opacity-60"
        >
          {saving ? "Saving…" : "Save changes"}
        </button>
      </form>
    </div>
  );
}