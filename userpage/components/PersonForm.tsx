"use client";

import { useState } from "react";
import { apiPost, apiUpload, getStoredUser, type Role } from "@/lib/auth";
import { personTypesFor } from "@/lib/permissions";
import PhotoCapture from "@/components/PhotoCapture";
import Notice from "@/components/Notice";
import type { PersonRecord } from "@/components/RegistrationForm";

const inputCls =
  "w-full rounded-xl border border-line bg-white px-3 py-2 text-[14px] text-ink outline-none focus:border-blue focus:ring-4 focus:ring-blue/12";

export default function PersonForm({
  onCreated,
  onClose,
}: {
  onCreated: (person: PersonRecord) => void;
  onClose: () => void;
}) {
  // Fails closed: if somehow no stored user is found, personTypesFor("staff")
  // returns [], which renders the disabled single-value field with no options
  // rather than silently defaulting to "student".
  const myRole = (getStoredUser()?.role ?? "staff") as Role;
  const allowedTypes = personTypesFor(myRole);

  const [form, setForm] = useState({
    full_name: "",
    type: allowedTypes[0] ?? "student",
    id_number: "",
    department_section: "",
    contact_email: "",
    rfid_uid: "",
    password: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [photo, setPhoto] = useState<Blob | null>(null);
  // Set when the person saved but their photo did not — the record exists and
  // must not be rolled back, so the failure is offered as a retry instead.
  // Carries the full created record (not just id/name) so a successful retry
  // or an explicit skip can still hand the complete person to onCreated,
  // matching what the immediate-success path does.
  const [photoRetry, setPhotoRetry] = useState<(PersonRecord & { _id: string }) | null>(null);

  function set(k: keyof typeof form, v: string) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    // Only send optional fields when non-empty (backend rejects empty rfid_uid/email).
    const payload: Record<string, string> = {
      full_name: form.full_name.trim(),
      type: form.type,
      id_number: form.id_number.trim(),
      password: form.password,
    };
    for (const k of ["department_section", "contact_email", "rfid_uid"] as const) {
      const v = form[k].trim();
      if (v) payload[k] = v;
    }
    try {
      const created = await apiPost<PersonRecord & { _id: string }>("/persons", payload);
      if (photo) {
        try {
          const form = new FormData();
          form.append("photo", photo, "photo.jpg");
          const uploaded = await apiUpload<{ photo_url: string }>(
            `/persons/${created._id}/photo`,
            form
          );
          created.photo_url = uploaded.photo_url;
        } catch {
          // The person exists and is usable. Deleting them over a flaky upload
          // is worse, and id_number is unique so a retry would collide.
          setPhotoRetry(created);
          setSaving(false);
          return;
        }
      }
      onCreated(created);
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
            Add person
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

        {photoRetry && (
          <div className="rounded-xl bg-gold/10 px-4 py-3 text-[13px] text-ink">
            <p className="font-600">
              Registered {photoRetry.full_name} — the photo didn&apos;t upload.
            </p>
            <p className="mt-0.5 text-ink-soft">
              The record is saved. You can retry the photo now.
            </p>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                disabled={!photo || saving}
                onClick={async () => {
                  if (!photo) return;
                  setSaving(true);
                  try {
                    const form = new FormData();
                    form.append("photo", photo, "photo.jpg");
                    const uploaded = await apiUpload<{ photo_url: string }>(
                      `/persons/${photoRetry._id}/photo`,
                      form
                    );
                    const completed = { ...photoRetry, photo_url: uploaded.photo_url };
                    setPhotoRetry(null);
                    onCreated(completed);
                  } catch (err) {
                    setError((err as Error).message);
                  } finally {
                    setSaving(false);
                  }
                }}
                className="rounded-lg bg-navy px-3 py-1.5 text-[13px] font-600 text-white disabled:opacity-60"
              >
                Retry photo
              </button>
              <button
                type="button"
                onClick={() => {
                  const skipped = photoRetry;
                  setPhotoRetry(null);
                  onCreated(skipped);
                }}
                className="rounded-lg border border-line bg-white px-3 py-1.5 text-[13px] font-600 text-ink-soft"
              >
                Continue without it
              </button>
            </div>
          </div>
        )}

        <label className="block text-[13px] font-600 text-ink-soft">
          Full name
          <input
            required
            value={form.full_name}
            onChange={(e) => set("full_name", e.target.value)}
            className={`mt-1 ${inputCls}`}
          />
        </label>

        <div className="grid grid-cols-2 gap-3">
          {allowedTypes.length === 1 ? (
            <label className="block text-[13px] font-600 text-ink-soft">
              Type
              <input
                value={allowedTypes[0]}
                disabled
                readOnly
                className="mt-1 w-full rounded-xl border border-line bg-paper px-3 py-2 capitalize text-ink-soft"
              />
            </label>
          ) : (
            <label className="block text-[13px] font-600 text-ink-soft">
              Type
              <select
                value={form.type}
                onChange={(e) => set("type", e.target.value)}
                className={`mt-1 ${inputCls}`}
              >
                {allowedTypes.map((t) => (
                  <option key={t} value={t}>
                    {t[0].toUpperCase() + t.slice(1)}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="block text-[13px] font-600 text-ink-soft">
            ID number
            <input
              required
              value={form.id_number}
              onChange={(e) => set("id_number", e.target.value)}
              className={`mt-1 ${inputCls}`}
            />
          </label>
        </div>

        <label className="block text-[13px] font-600 text-ink-soft">
          Course / Section
          <input
            value={form.department_section}
            onChange={(e) => set("department_section", e.target.value)}
            className={`mt-1 ${inputCls}`}
          />
        </label>

        <label className="block text-[13px] font-600 text-ink-soft">
          Email
          <input
            type="email"
            value={form.contact_email}
            onChange={(e) => set("contact_email", e.target.value)}
            className={`mt-1 ${inputCls}`}
          />
        </label>

        <PhotoCapture onChange={setPhoto} />

        <label className="block text-[13px] font-600 text-ink-soft">
          RFID UID (hex) — scan a card now, or leave blank to assign later
          <input
            value={form.rfid_uid}
            onChange={(e) => set("rfid_uid", e.target.value)}
            placeholder="e.g. A3F19C24"
            className={`mt-1 font-mono ${inputCls}`}
          />
        </label>

        <label className="block text-[13px] font-600 text-ink-soft">
          Password — the person signs in with this and their ID number
          <input
            required
            type="text"
            minLength={8}
            value={form.password}
            onChange={(e) => set("password", e.target.value)}
            placeholder="Min. 8 characters"
            className={`mt-1 ${inputCls}`}
          />
          <span className="mt-1 block text-[12px] font-400 text-ink-soft">
            Read this back to them so they can note it down. They must change it at
            first sign-in.
          </span>
        </label>

        <button
          type="submit"
          disabled={saving}
          className="w-full rounded-xl bg-navy px-4 py-2.5 text-sm font-600 text-white hover:bg-navy/90 disabled:opacity-60"
        >
          {saving ? "Saving…" : "Create & print form"}
        </button>
      </form>
    </div>
  );
}
