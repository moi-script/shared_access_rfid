"use client";

import { useEffect, useRef, useState } from "react";
import { apiGetList, apiPost, apiUpload } from "@/lib/auth";
import PhotoCapture from "@/components/PhotoCapture";
import { VEHICLE_TYPES, VEHICLE_LIMITS } from "@/lib/vehicleTypes";
import Notice from "@/components/Notice";
import type { IconType } from "react-icons";
import {
  TfiCar,
  TfiIdBadge,
  TfiKey,
  TfiLayersAlt,
  TfiUser,
  TfiWrite,
} from "react-icons/tfi";

const inputCls =
  "w-full rounded-xl border border-line bg-white px-3 py-2 text-[14px] text-ink outline-none focus:border-blue focus:ring-4 focus:ring-blue/12";

const CATEGORY = ["new", "renewal"] as const;
const APPLICANT_TYPE = ["student", "employee"] as const;

interface OwnerHit {
  _id: string;
  full_name: string;
  id_number: string;
  type: string;
  // Present because the /persons list query projects the whole document. Used
  // only to decide whether to offer an owner-photo capture below — a face
  // already on file does not need recapturing.
  photo_url?: string;
}

interface FormState {
  // Category
  category: (typeof CATEGORY)[number];
  applicant_type: (typeof APPLICANT_TYPE)[number];
  vehicle_type: (typeof VEHICLE_TYPES)[number];
  // Applicant
  id_number: string;
  last_name: string;
  first_name: string;
  middle_name: string;
  year_level: string;
  school_year: string;
  email: string;
  mobile_no: string;
  tel_no: string;
  permanent_address: string;
  // Vehicle
  plate_no: string;
  mv_file_no: string;
  make: string;
  model: string;
  year: string;
  color: string;
  // LTO
  lto_cr_no: string;
  lto_cr_date: string;
  lto_or_no: string;
  lto_or_date: string;
  // Ownership (driver details grouped here — the brief's six named sections
  // have no separate "Driver" heading, and driver/owner/relationship read
  // together on the printed sheet)
  registered_owner_name: string;
  relationship: string;
  driver_name: string;
  driver_license_no: string;
  // Authorization
  signed_name: string;
  signed_date: string;
  rfid_uid: string;
}

const EMPTY_FORM: FormState = {
  category: "new",
  applicant_type: "student",
  vehicle_type: "motorcycle",
  id_number: "",
  last_name: "",
  first_name: "",
  middle_name: "",
  year_level: "",
  school_year: "",
  email: "",
  mobile_no: "",
  tel_no: "",
  permanent_address: "",
  plate_no: "",
  mv_file_no: "",
  make: "",
  model: "",
  year: "",
  color: "",
  lto_cr_no: "",
  lto_cr_date: "",
  lto_or_no: "",
  lto_or_date: "",
  registered_owner_name: "",
  relationship: "",
  driver_name: "",
  driver_license_no: "",
  signed_name: "",
  signed_date: "",
  rfid_uid: "",
};

// Sent only when non-blank — the backend rejects empty strings for fields it
// declared optional, and most of a real paper form is blank.
const OPTIONAL_KEYS = [
  "year_level",
  "tel_no",
  "mv_file_no",
  "model",
  "year",
  "color",
  "lto_cr_no",
  "lto_cr_date",
  "lto_or_no",
  "lto_or_date",
  "relationship",
  "driver_name",
  "driver_license_no",
] as const satisfies readonly (keyof FormState)[];

const REQUIRED_KEYS = [
  "id_number",
  "last_name",
  "first_name",
  "middle_name",
  "school_year",
  "email",
  "mobile_no",
  "permanent_address",
  "plate_no",
  "make",
  "registered_owner_name",
  "signed_name",
  "signed_date",
  "rfid_uid",
] as const satisfies readonly (keyof FormState)[];

/**
 * Re-encodes whatever image the clerk picked (a phone photo of the signed
 * paper, a scanned PNG, anything createImageBitmap can decode) through a
 * canvas as a PNG blob. The server checks the PNG magic bytes, not
 * Content-Type, so round-tripping through canvas.toBlob("image/png") is what
 * guarantees a real PNG regardless of the source file's format — the same
 * "encode through canvas" approach PhotoCapture.tsx already uses for photos.
 */
async function toPngBlob(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas is unavailable in this browser");
    ctx.drawImage(bitmap, 0, 0);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error("Could not encode the signature"))),
        "image/png"
      );
    });
  } finally {
    bitmap.close();
  }
}

function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

function Optional() {
  return <span className="ml-1 font-500 normal-case text-ink-soft/60">(optional)</span>;
}

function Section({
  title,
  icon: Icon,
  children,
}: {
  title: string;
  icon: IconType;
  children: React.ReactNode;
}) {
  return (
    <fieldset className="space-y-3 rounded-2xl border border-line bg-white p-5">
      <legend className="flex items-center gap-2 px-1 text-[13px] font-600 uppercase tracking-[0.16em] text-ink-soft">
        <Icon aria-hidden className="h-3.5 w-3.5 shrink-0" />
        {title}
      </legend>
      {children}
    </fieldset>
  );
}

interface CreatedApplication {
  application: { _id: string; plate_no: string };
  vehicle: { _id: string; plate_number: string; valid_until: string; status: string };
}

export default function VehicleApplicationForm({
  onCreated,
  onClose,
}: {
  onCreated: (vehicle: CreatedApplication["vehicle"]) => void;
  onClose: () => void;
}) {
  const [form, setForm] = useState<FormState>(EMPTY_FORM);

  // Owner search — same debounced generation-ref pattern AccountsView uses so
  // a slow first keystroke's response can never clobber a faster later one.
  const [ownerQuery, setOwnerQuery] = useState("");
  const [ownerResults, setOwnerResults] = useState<OwnerHit[]>([]);
  const [owner, setOwner] = useState<OwnerHit | null>(null);
  const [searching, setSearching] = useState(false);
  const gen = useRef(0);

  const [signatureFile, setSignatureFile] = useState<File | null>(null);
  const [signaturePreview, setSignaturePreview] = useState<string | null>(null);

  // Both uploaded AFTER the application POST returns — the vehicle id does not
  // exist until then. See submit().
  const [vehiclePhoto, setVehiclePhoto] = useState<Blob | null>(null);
  const [ownerPhoto, setOwnerPhoto] = useState<Blob | null>(null);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  function set(k: keyof FormState, v: string) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  useEffect(() => {
    // Every state update below happens inside the timeout callback (or the
    // fetch it kicks off), never synchronously in the effect body — this is
    // the debounce itself, not just a stylistic echo of AccountsView's.
    const mine = ++gen.current;
    const t = setTimeout(() => {
      if (owner || !ownerQuery.trim()) {
        if (mine === gen.current) setOwnerResults([]);
        return;
      }
      if (mine === gen.current) setSearching(true);
      apiGetList<OwnerHit>(`/persons?search=${encodeURIComponent(ownerQuery.trim())}&limit=8`)
        .then(({ items }) => {
          if (mine !== gen.current) return; // a newer search started; discard this result
          setOwnerResults(items);
        })
        .catch(() => {
          if (mine !== gen.current) return;
          setOwnerResults([]);
        })
        .finally(() => {
          if (mine === gen.current) setSearching(false);
        });
    }, 250);
    return () => {
      clearTimeout(t);
      // `gen` is a plain counter ref, not a DOM node, so there is no
      // stale-node hazard here — bumping it on every cleanup is exactly what
      // invalidates in-flight responses after unmount/query change.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      gen.current++;
    };
  }, [ownerQuery, owner]);

  function selectOwner(o: OwnerHit) {
    setOwner(o);
    setOwnerQuery(o.full_name);
    setOwnerResults([]);
  }

  function clearOwner() {
    setOwner(null);
    setOwnerQuery("");
  }

  function handleSignature(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null;
    setSignaturePreview((old) => {
      if (old) URL.revokeObjectURL(old);
      return file ? URL.createObjectURL(file) : null;
    });
    setSignatureFile(file);
  }

  function resetForm() {
    setForm(EMPTY_FORM);
    clearOwner();
    setSignatureFile(null);
    setSignaturePreview((old) => {
      if (old) URL.revokeObjectURL(old);
      return null;
    });
    setVehiclePhoto(null);
    setOwnerPhoto(null);
  }

  // Discrepancy flags between what the clerk typed and the selected person's
  // own record — informational only, per the design: the paper is the
  // record, and a mismatch is for a human to notice, not for the form to
  // silently normalise away. Name comparison is a loose substring check
  // because Person.full_name and the paper's Last/First/Middle split are not
  // guaranteed to share a single canonical order.
  const idMismatch =
    !!owner && !!form.id_number.trim() && normalize(form.id_number) !== normalize(owner.id_number);
  const nameMismatch =
    !!owner &&
    !!(form.last_name.trim() || form.first_name.trim()) &&
    (() => {
      const target = normalize(owner.full_name);
      const last = normalize(form.last_name);
      const first = normalize(form.first_name);
      return (last && !target.includes(last)) || (first && !target.includes(first));
    })();

  const requiredFilled = REQUIRED_KEYS.every((k) => form[k].trim().length > 0) && !!owner;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    if (!owner) {
      setError("Search for and select the applicant before submitting.");
      return;
    }
    setSaving(true);
    try {
      const payload: Record<string, string> = {
        category: form.category,
        applicant_type: form.applicant_type,
        vehicle_type: form.vehicle_type,
        owner_person_id: owner._id,
      };
      for (const k of REQUIRED_KEYS) payload[k] = form[k].trim();
      for (const k of OPTIONAL_KEYS) {
        const v = form[k].trim();
        if (v) payload[k] = v;
      }

      const created = await apiPost<CreatedApplication>("/vehicle-applications", payload);

      // Signature goes to the application id the server just returned,
      // matching the server's own write ordering (application, then
      // signature, then vehicle already exists by the time we're here).
      if (signatureFile) {
        try {
          const png = await toPngBlob(signatureFile);
          const fd = new FormData();
          fd.append("signature", png, "signature.png");
          await apiUpload(`/vehicle-applications/${created.application._id}/signature`, fd);
        } catch (sigErr) {
          // The application and vehicle already exist and grant access; a
          // failed signature upload must not read as a failed registration.
          setError(
            `Registered ${created.vehicle.plate_number}, but the signature did not upload: ${
              (sigErr as Error).message
            }`
          );
          resetForm();
          onCreated(created.vehicle);
          return;
        }
      }

      // Photos upload AFTER the create, because the vehicle id does not exist
      // until the server returns it. A failure here is reported but never
      // rolls anything back: the pass is already valid, and revoking gate
      // access over a missing image is the worse failure. Same posture as the
      // signature block above.
      const photoFailures: string[] = [];
      if (vehiclePhoto) {
        try {
          const fd = new FormData();
          fd.append("photo", vehiclePhoto, "vehicle.jpg");
          await apiUpload(`/vehicles/${created.vehicle._id}/photo`, fd);
        } catch (photoErr) {
          photoFailures.push(`the vehicle photo (${(photoErr as Error).message})`);
        }
      }
      if (ownerPhoto) {
        try {
          const fd = new FormData();
          fd.append("photo", ownerPhoto, "owner.jpg");
          await apiUpload(`/persons/${owner._id}/photo`, fd);
        } catch (photoErr) {
          photoFailures.push(`the owner photo (${(photoErr as Error).message})`);
        }
      }
      if (photoFailures.length > 0) {
        setError(
          `Registered ${created.vehicle.plate_number}, but ${photoFailures.join(
            " and "
          )} did not upload. Add it from the profile.`
        );
        resetForm();
        onCreated(created.vehicle);
        return;
      }

      setSuccess(
        `Registered ${created.vehicle.plate_number}, valid until ${new Date(
          created.vehicle.valid_until
        ).toLocaleDateString()}.`
      );
      resetForm();
      onCreated(created.vehicle);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-ink-soft">
          Transcribe the signed paper application. Fields marked{" "}
          <span className="font-500 text-ink-soft/70">(optional)</span> may stay blank exactly as
          they are on the form.
        </p>
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 text-[14px] font-600 text-ink-soft hover:text-ink"
        >
          Cancel
        </button>
      </div>

      {error && (
        <Notice compact className="text-[13px] text-ink">
          {error}
        </Notice>
      )}
      {success && (
        <Notice tone="info" compact className="text-[13px] text-ink">
          {success}
        </Notice>
      )}

      {/* Category */}
      <Section title="Category" icon={TfiLayersAlt}>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="block text-[13px] font-600 text-ink-soft">
            Application
            <select
              value={form.category}
              onChange={(e) => set("category", e.target.value as FormState["category"])}
              className={`mt-1 ${inputCls}`}
            >
              {CATEGORY.map((c) => (
                <option key={c} value={c} className="capitalize">
                  {c[0].toUpperCase() + c.slice(1)}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-[13px] font-600 text-ink-soft">
            Applicant type
            <select
              value={form.applicant_type}
              onChange={(e) => set("applicant_type", e.target.value as FormState["applicant_type"])}
              className={`mt-1 ${inputCls}`}
            >
              {APPLICANT_TYPE.map((t) => (
                <option key={t} value={t} className="capitalize">
                  {t[0].toUpperCase() + t.slice(1)}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-[13px] font-600 text-ink-soft">
            Vehicle type
            <select
              value={form.vehicle_type}
              onChange={(e) => set("vehicle_type", e.target.value as FormState["vehicle_type"])}
              className={`mt-1 ${inputCls}`}
            >
              {VEHICLE_TYPES.map((t) => (
                <option key={t} value={t} className="capitalize">
                  {t[0].toUpperCase() + t.slice(1)}
                </option>
              ))}
            </select>
            <span className="mt-1 block text-[12px] font-400 text-ink-soft">
              Limit: {VEHICLE_LIMITS[form.vehicle_type]} active per person
            </span>
          </label>
        </div>
      </Section>

      {/* Applicant */}
      <Section title="Applicant" icon={TfiUser}>
        <div className="relative">
          <label className="block text-[13px] font-600 text-ink-soft">
            Owner — search by name or ID number
            <input
              required
              value={ownerQuery}
              onChange={(e) => {
                setOwner(null);
                setOwnerQuery(e.target.value);
              }}
              placeholder="Start typing to search the directory…"
              className={`mt-1 ${inputCls}`}
            />
          </label>
          {owner && (
            <p className="mt-1 flex items-center gap-2 text-[12px] text-ink-soft">
              Selected: <span className="font-600 text-ink">{owner.full_name}</span> (
              {owner.id_number})
              <button
                type="button"
                onClick={clearOwner}
                className="font-600 text-blue hover:underline"
              >
                Change
              </button>
            </p>
          )}
          {!owner && (searching || ownerResults.length > 0) && ownerQuery.trim() && (
            <ul className="absolute z-10 mt-1 max-h-56 w-full overflow-auto rounded-xl border border-line bg-white shadow-lg">
              {searching && ownerResults.length === 0 && (
                <li className="px-3 py-2 text-[13px] text-ink-soft">Searching…</li>
              )}
              {ownerResults.map((o) => (
                <li key={o._id}>
                  <button
                    type="button"
                    onClick={() => selectOwner(o)}
                    className="block w-full px-3 py-2 text-left text-[13px] hover:bg-paper"
                  >
                    <span className="font-600 text-ink">{o.full_name}</span>{" "}
                    <span className="text-ink-soft">
                      · {o.id_number} · {o.type}
                    </span>
                  </button>
                </li>
              ))}
              {!searching && ownerResults.length === 0 && (
                <li className="px-3 py-2 text-[13px] text-ink-soft">No matches.</li>
              )}
            </ul>
          )}
          {(idMismatch || nameMismatch) && (
            <Notice tone="warn" compact className="mt-2 text-[12px] text-ink">
              What was typed below doesn&apos;t match the selected person&apos;s record
              {idMismatch ? " (ID number differs)" : ""}
              {idMismatch && nameMismatch ? " and" : ""}
              {nameMismatch ? " (name differs)" : ""}. The paper form is the record — submitting
              is still allowed; this is only a flag for a human to check.
            </Notice>
          )}
        </div>

        {/* Only when there is no face on file. Recapturing one the gate can
            already show is churn, and the person record is not this form's
            job to maintain. */}
        {owner && !owner.photo_url && (
          <div className="block text-[13px] font-600 text-ink-soft">
            Owner photo — none on file yet
            <PhotoCapture onChange={setOwnerPhoto} />
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-[13px] font-600 text-ink-soft">
            ID number
            <input
              required
              value={form.id_number}
              onChange={(e) => set("id_number", e.target.value)}
              className={`mt-1 ${inputCls}`}
            />
          </label>
          <label className="block text-[13px] font-600 text-ink-soft">
            School year
            <input
              required
              value={form.school_year}
              onChange={(e) => set("school_year", e.target.value)}
              placeholder="e.g. 26-27"
              className={`mt-1 ${inputCls}`}
            />
          </label>
          <label className="block text-[13px] font-600 text-ink-soft">
            Last name
            <input
              required
              value={form.last_name}
              onChange={(e) => set("last_name", e.target.value)}
              className={`mt-1 ${inputCls}`}
            />
          </label>
          <label className="block text-[13px] font-600 text-ink-soft">
            First name
            <input
              required
              value={form.first_name}
              onChange={(e) => set("first_name", e.target.value)}
              className={`mt-1 ${inputCls}`}
            />
          </label>
          <label className="block text-[13px] font-600 text-ink-soft">
            Middle name
            <input
              required
              value={form.middle_name}
              onChange={(e) => set("middle_name", e.target.value)}
              className={`mt-1 ${inputCls}`}
            />
          </label>
          <label className="block text-[13px] font-600 text-ink-soft">
            Year level
            <Optional />
            <input
              value={form.year_level}
              onChange={(e) => set("year_level", e.target.value)}
              placeholder="e.g. 4th"
              className={`mt-1 ${inputCls}`}
            />
          </label>
          <label className="block text-[13px] font-600 text-ink-soft">
            Email
            <input
              required
              type="email"
              value={form.email}
              onChange={(e) => set("email", e.target.value)}
              className={`mt-1 ${inputCls}`}
            />
          </label>
          <label className="block text-[13px] font-600 text-ink-soft">
            Mobile no.
            <input
              required
              value={form.mobile_no}
              onChange={(e) => set("mobile_no", e.target.value)}
              className={`mt-1 ${inputCls}`}
            />
          </label>
          <label className="block text-[13px] font-600 text-ink-soft">
            Tel no.
            <Optional />
            <input
              value={form.tel_no}
              onChange={(e) => set("tel_no", e.target.value)}
              className={`mt-1 ${inputCls}`}
            />
          </label>
          <label className="block text-[13px] font-600 text-ink-soft sm:col-span-2">
            Permanent address
            <input
              required
              value={form.permanent_address}
              onChange={(e) => set("permanent_address", e.target.value)}
              className={`mt-1 ${inputCls}`}
            />
          </label>
        </div>
      </Section>

      {/* Vehicle */}
      <Section title="Vehicle" icon={TfiCar}>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-[13px] font-600 text-ink-soft">
            Plate no.
            <input
              required
              value={form.plate_no}
              onChange={(e) => set("plate_no", e.target.value)}
              className={`mt-1 font-mono ${inputCls}`}
            />
          </label>
          <label className="block text-[13px] font-600 text-ink-soft">
            MV file no.
            <Optional />
            <input
              value={form.mv_file_no}
              onChange={(e) => set("mv_file_no", e.target.value)}
              className={`mt-1 ${inputCls}`}
            />
          </label>
          <label className="block text-[13px] font-600 text-ink-soft">
            Make
            <input
              required
              value={form.make}
              onChange={(e) => set("make", e.target.value)}
              className={`mt-1 ${inputCls}`}
            />
          </label>
          <label className="block text-[13px] font-600 text-ink-soft">
            Model
            <Optional />
            <input
              value={form.model}
              onChange={(e) => set("model", e.target.value)}
              className={`mt-1 ${inputCls}`}
            />
          </label>
          <label className="block text-[13px] font-600 text-ink-soft">
            Year
            <Optional />
            <input
              value={form.year}
              onChange={(e) => set("year", e.target.value)}
              className={`mt-1 ${inputCls}`}
            />
          </label>
          <label className="block text-[13px] font-600 text-ink-soft">
            Color
            <Optional />
            <input
              value={form.color}
              onChange={(e) => set("color", e.target.value)}
              className={`mt-1 ${inputCls}`}
            />
          </label>
          <label className="block text-[13px] font-600 text-ink-soft sm:col-span-2">
            RFID UID (hex) — scan the sticker&apos;s card now
            <input
              required
              value={form.rfid_uid}
              onChange={(e) => set("rfid_uid", e.target.value)}
              placeholder="e.g. A3F19C24"
              className={`mt-1 font-mono ${inputCls}`}
            />
          </label>
          <div className="block text-[13px] font-600 text-ink-soft sm:col-span-2">
            Vehicle photo — shown to the guard at the barrier
            <PhotoCapture onChange={setVehiclePhoto} />
          </div>
        </div>
      </Section>

      {/* LTO */}
      <Section title="LTO" icon={TfiIdBadge}>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-[13px] font-600 text-ink-soft">
            CR no.
            <Optional />
            <input
              value={form.lto_cr_no}
              onChange={(e) => set("lto_cr_no", e.target.value)}
              className={`mt-1 ${inputCls}`}
            />
          </label>
          <label className="block text-[13px] font-600 text-ink-soft">
            CR date
            <Optional />
            <input
              type="date"
              value={form.lto_cr_date}
              onChange={(e) => set("lto_cr_date", e.target.value)}
              className={`mt-1 ${inputCls}`}
            />
          </label>
          <label className="block text-[13px] font-600 text-ink-soft">
            OR no.
            <Optional />
            <input
              value={form.lto_or_no}
              onChange={(e) => set("lto_or_no", e.target.value)}
              placeholder="~"
              className={`mt-1 ${inputCls}`}
            />
          </label>
          <label className="block text-[13px] font-600 text-ink-soft">
            OR date
            <Optional />
            <input
              type="date"
              value={form.lto_or_date}
              onChange={(e) => set("lto_or_date", e.target.value)}
              className={`mt-1 ${inputCls}`}
            />
          </label>
        </div>
      </Section>

      {/* Ownership */}
      <Section title="Ownership" icon={TfiKey}>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-[13px] font-600 text-ink-soft">
            Registered owner name
            <input
              required
              value={form.registered_owner_name}
              onChange={(e) => set("registered_owner_name", e.target.value)}
              className={`mt-1 ${inputCls}`}
            />
          </label>
          <label className="block text-[13px] font-600 text-ink-soft">
            Relationship to applicant
            <Optional />
            <input
              value={form.relationship}
              onChange={(e) => set("relationship", e.target.value)}
              className={`mt-1 ${inputCls}`}
            />
          </label>
          <label className="block text-[13px] font-600 text-ink-soft">
            Driver name
            <Optional />
            <input
              value={form.driver_name}
              onChange={(e) => set("driver_name", e.target.value)}
              className={`mt-1 ${inputCls}`}
            />
          </label>
          <label className="block text-[13px] font-600 text-ink-soft">
            Driver&apos;s license no.
            <Optional />
            <input
              value={form.driver_license_no}
              onChange={(e) => set("driver_license_no", e.target.value)}
              className={`mt-1 ${inputCls}`}
            />
          </label>
        </div>
      </Section>

      {/* Authorization */}
      <Section title="Authorization" icon={TfiWrite}>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-[13px] font-600 text-ink-soft">
            Signed name
            <input
              required
              value={form.signed_name}
              onChange={(e) => set("signed_name", e.target.value)}
              className={`mt-1 ${inputCls}`}
            />
          </label>
          <label className="block text-[13px] font-600 text-ink-soft">
            Signed date
            <input
              required
              type="date"
              value={form.signed_date}
              onChange={(e) => set("signed_date", e.target.value)}
              className={`mt-1 ${inputCls}`}
            />
          </label>
        </div>

        <div className="rounded-xl border border-line bg-paper p-3">
          <p className="mb-2 text-[13px] font-600 text-ink-soft">
            Signature <span className="font-500 normal-case text-ink-soft/60">(optional)</span>
          </p>
          <div className="flex items-start gap-3">
            <div className="grid h-20 w-40 shrink-0 place-items-center overflow-hidden rounded-lg border border-line bg-white text-[11px] text-ink-soft">
              {signaturePreview ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={signaturePreview}
                  alt="Signature preview"
                  className="h-full w-full object-contain"
                />
              ) : (
                "No signature"
              )}
            </div>
            <div className="space-y-1">
              <input
                type="file"
                accept="image/*"
                onChange={handleSignature}
                className="text-[13px] text-ink-soft file:mr-3 file:rounded-lg file:border file:border-line file:bg-white file:px-3 file:py-1.5 file:text-[13px] file:font-600 file:text-ink-soft"
              />
              <p className="text-[11px] text-ink-soft">
                Upload a photo or scan of the signed paper. Stored as PNG.
              </p>
            </div>
          </div>
        </div>
      </Section>

      <button
        type="submit"
        disabled={saving || !requiredFilled}
        className="w-full rounded-xl bg-navy px-4 py-2.5 text-sm font-600 text-white hover:bg-navy/90 disabled:opacity-60"
      >
        {saving ? "Submitting…" : "Submit application"}
      </button>
    </form>
  );
}
