"use client";

import { useState } from "react";
import { apiPatch, apiUpload } from "@/lib/auth";
import PhotoCapture from "@/components/PhotoCapture";
import Notice from "@/components/Notice";
import { GADGET_TYPES, gadgetTypeLabel } from "@/lib/gadgetTypes";

const inputCls =
  "w-full rounded-xl border border-line bg-white px-3 py-2 text-[14px] text-ink outline-none focus:border-blue focus:ring-4 focus:ring-blue/12";

export interface EditableGadget {
  _id: string;
  gadget_type: string;
  brand_model: string;
  serial_number: string;
}

export default function GadgetEditForm({
  gadget,
  onSaved,
  onClose,
}: {
  gadget: EditableGadget;
  onSaved: (updated: EditableGadget & { photo_url?: string }) => void;
  onClose: () => void;
}) {
  const [form, setForm] = useState({
    gadget_type: gadget.gadget_type,
    brand_model: gadget.brand_model,
    serial_number: gadget.serial_number,
  });
  const [photo, setPhoto] = useState<Blob | null>(null);
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
      // gadgetService.update refuses owner_person_id outright — it is never
      // sent here, so there is no transfer path to accidentally trigger.
      const payload = {
        gadget_type: form.gadget_type,
        brand_model: form.brand_model.trim(),
        // Sent as typed; the server normalizes (trim + uppercase) against the
        // unique index, same as GadgetForm's create-side payload.
        serial_number: form.serial_number,
      };
      const updated = await apiPatch<EditableGadget & { photo_url?: string }>(
        `/gadgets/${gadget._id}`,
        payload
      );
      if (photo) {
        try {
          const fd = new FormData();
          fd.append("photo", photo, "gadget.jpg");
          const uploaded = await apiUpload<{ photo_url: string }>(
            `/gadgets/${gadget._id}/photo`,
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
            Edit device
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
            Device
            <select
              value={form.gadget_type}
              onChange={(e) => set("gadget_type", e.target.value)}
              className={`mt-1 ${inputCls}`}
            >
              {GADGET_TYPES.map((t) => (
                <option key={t} value={t}>
                  {gadgetTypeLabel(t)}
                </option>
              ))}
            </select>
            <span className="mt-1 block text-[12px] text-ink-soft">
              Moving between types is checked against the new type&apos;s allowance.
            </span>
          </label>
          <label className="block text-[13px] font-600 text-ink-soft">
            Brand and model
            <input
              required
              value={form.brand_model}
              onChange={(e) => set("brand_model", e.target.value)}
              className={`mt-1 ${inputCls}`}
            />
          </label>
        </div>

        <label className="block text-[13px] font-600 text-ink-soft">
          Serial number
          <input
            required
            value={form.serial_number}
            onChange={(e) => set("serial_number", e.target.value)}
            className={`mt-1 font-mono ${inputCls}`}
          />
        </label>

        <div>
          <p className="mb-1 text-[13px] font-600 text-ink-soft">
            Photo — leave blank to keep the current one
          </p>
          <PhotoCapture onChange={setPhoto} fit="whole" />
        </div>

        <p className="text-[12px] text-ink-soft">
          RFID sticker and owner are not edited here — use &quot;Replace tag&quot; /
          &quot;Assign tag&quot; on the profile for the sticker. A gadget cannot change
          owners; deactivate this one and register a new one instead.
        </p>

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