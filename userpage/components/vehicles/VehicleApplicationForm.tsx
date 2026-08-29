"use client";

import { useEffect, useRef, useState } from "react";
import { apiGet, apiGetBlob, apiGetList, apiPost, apiUpload } from "@/lib/auth";
import PhotoCapture from "@/components/PhotoCapture";
import { VEHICLE_TYPES } from "@/lib/vehicleTypes";
import Notice from "@/components/Notice";
import type { IconType } from "react-icons";
import {
  TfiCar,
  // Icons for the LTO / Ownership / Authorization sections, commented out
  // with their sections below.
  // TfiIdBadge,
  // TfiKey,
  // TfiWrite,
  TfiLayersAlt,
  TfiUser,
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
  // The only contact detail the Person record carries. School year and mobile
  // number are NOT on it; they come from a prior application. See lookup().
  contact_email?: string;
  // The card the pass is issued under — a vehicle has no sticker of its own.
  // Absent for a person who has not been issued a card yet, which is exactly
  // the case the RFID field below refuses to submit on.
  rfid_uid?: string;
}

/** The fields a previous application can supply that the Person record cannot. */
interface PriorApplication {
  school_year?: string;
  mobile_no?: string;
  email?: string;
}

/** Enough of the owner's existing vehicles to match a plate and find its photo. */
interface PriorVehicle {
  _id: string;
  plate_number: string;
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

// FormState and EMPTY_FORM deliberately keep every key, including the ones the
// form no longer renders (2026-08-18 simplification). The hidden fields stay ""
// and are skipped by the OPTIONAL_KEYS loop in submit(), so nothing junk is
// sent — and the commented-out inputs below still typecheck the moment anyone
// uncomments them.
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
// declared optional, and most of a real paper form is blank. Every field the
// simplified form stopped rendering also lands here by staying blank, which is
// why they simply drop out of the payload rather than needing removal.
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
  // Moved out of REQUIRED_KEYS by the 2026-08-18 simplification. The server
  // relaxed these to .optional() to match; see vehicleApplications.schema.ts.
  "last_name",
  "first_name",
  "middle_name",
  "permanent_address",
  "make",
  "signed_name",
  "signed_date",
] as const satisfies readonly (keyof FormState)[];

// What the clerk actually fills in, plus registered_owner_name, which is not
// typed but derived from the resolved person (see lookup()) and still required
// by the server.
const REQUIRED_KEYS = [
  "id_number",
  "school_year",
  "email",
  "mobile_no",
  "plate_no",
  "registered_owner_name",
  "rfid_uid",
] as const satisfies readonly (keyof FormState)[];

/*
 * Signature capture left the form on 2026-08-18. toPngBlob is kept commented
 * rather than deleted because the applicationSignatures module, the
 * POST /vehicle-applications/:id/signature route, and every signature already
 * on file are all still live — only this form stopped feeding them.
 *
 * Re-encodes whatever image the clerk picked (a phone photo of the signed
 * paper, a scanned PNG, anything createImageBitmap can decode) through a
 * canvas as a PNG blob. The server checks the PNG magic bytes, not
 * Content-Type, so round-tripping through canvas.toBlob("image/png") is what
 * guarantees a real PNG regardless of the source file's format — the same
 * "encode through canvas" approach PhotoCapture.tsx already uses for photos.
 *
 * async function toPngBlob(file: File): Promise<Blob> {
 *   const bitmap = await createImageBitmap(file);
 *   try {
 *     const canvas = document.createElement("canvas");
 *     canvas.width = bitmap.width;
 *     canvas.height = bitmap.height;
 *     const ctx = canvas.getContext("2d");
 *     if (!ctx) throw new Error("Canvas is unavailable in this browser");
 *     ctx.drawImage(bitmap, 0, 0);
 *     return await new Promise<Blob>((resolve, reject) => {
 *       canvas.toBlob(
 *         (blob) => (blob ? resolve(blob) : reject(new Error("Could not encode the signature"))),
 *         "image/png"
 *       );
 *     });
 *   } finally {
 *     bitmap.close();
 *   }
 * }
 */

function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

/*
 * Used only by fields the simplified form no longer renders — every field it
 * still shows is required. Kept for whoever uncomments one of them.
 *
 * function Optional() {
 *   return <span className="ml-1 font-500 normal-case text-ink-soft/60">(optional)</span>;
 * }
 */

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

type LookupState = "idle" | "searching" | "found" | "none";

export default function VehicleApplicationForm({
  onCreated,
  onClose,
}: {
  onCreated: (vehicle: CreatedApplication["vehicle"]) => void;
  onClose: () => void;
}) {
  const [form, setForm] = useState<FormState>(EMPTY_FORM);

  // The applicant is resolved from the ID number rather than searched by name.
  // A vehicle application cannot exist without owner_person_id, so every
  // applicant is already a person — there is no "new applicant" path here.
  const [owner, setOwner] = useState<OwnerHit | null>(null);
  const [lookup, setLookup] = useState<LookupState>("idle");
  // Same debounced generation-ref pattern the name search used (and AccountsView
  // still uses) so a slow early response can never clobber a faster later one.
  const gen = useRef(0);

  /*
   * Signature state, commented out with the capture UI below.
   *
   * const [signatureFile, setSignatureFile] = useState<File | null>(null);
   * const [signaturePreview, setSignaturePreview] = useState<string | null>(null);
   */

  // Both uploaded AFTER the application POST returns — the vehicle id does not
  // exist until then. See submit().
  const [vehiclePhoto, setVehiclePhoto] = useState<Blob | null>(null);
  const [ownerPhoto, setOwnerPhoto] = useState<Blob | null>(null);

  // Renewal photo reuse: the plate the photo came from, an object URL for the
  // preview, and whether the clerk chose to override it with a fresh capture.
  const [reusedFromPlate, setReusedFromPlate] = useState<string | null>(null);
  const [reusedPhotoUrl, setReusedPhotoUrl] = useState<string | null>(null);
  const [retakePhoto, setRetakePhoto] = useState(false);
  const photoGen = useRef(0);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  function set(k: keyof FormState, v: string) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  function clearReusedPhoto() {
    setReusedFromPlate(null);
    setReusedPhotoUrl((old) => {
      if (old) URL.revokeObjectURL(old);
      return null;
    });
  }

  /**
   * Resolve the applicant from the ID number, then fill what is blank.
   *
   * Two hops, because one is not enough: the Person record carries only
   * full_name / id_number / department_section / contact_email. School year and
   * mobile number live ONLY on prior applications, so a person-only lookup
   * would leave half the contact block empty on a returning applicant.
   *
   * Fills blanks only. Anything the clerk has already typed wins, which is what
   * makes it safe to re-run every time the ID number changes.
   * registered_owner_name is the exception: it is derived, never typed, so it
   * always tracks the resolved person.
   */
  useEffect(() => {
    // Every setState below runs inside the timeout callback or the fetch it
    // starts, never synchronously in the effect body — this is the debounce
    // itself, not a stylistic echo of it.
    const mine = ++gen.current;
    const raw = form.id_number.trim();
    const t = setTimeout(() => {
      if (!raw) {
        if (mine === gen.current) {
          setOwner(null);
          setLookup("idle");
        }
        return;
      }
      if (mine === gen.current) setLookup("searching");
      apiGetList<OwnerHit>(`/persons?search=${encodeURIComponent(raw)}&limit=8`)
        .then(async ({ items }) => {
          if (mine !== gen.current) return; // a newer lookup started
          // Exact match only. `search` is a partial match, so "2025-000" would
          // otherwise resolve to whichever student happened to sort first.
          const hit = items.find((p) => normalize(p.id_number) === normalize(raw)) ?? null;
          if (!hit) {
            setOwner(null);
            setLookup("none");
            return;
          }
          setOwner(hit);
          setLookup("found");
          setForm((f) => ({
            ...f,
            registered_owner_name: hit.full_name,
            email: f.email.trim() ? f.email : (hit.contact_email ?? ""),
            // Derived, never typed — see the RFID field below. The server
            // reads it off the owner too and ignores what we send, so this is
            // for the clerk to SEE which card the pass will use.
            rfid_uid: hit.rfid_uid ?? "",
          }));

          // Hop 2 carries its OWN catch rather than sharing the outer one.
          // Sharing it would make a failed prior-application read
          // indistinguishable from a failed person lookup, and the outer
          // handler clears `owner` — so a returning applicant whose history
          // happened to fail to load would silently lose the person the form
          // had already resolved.
          try {
            const { items: apps } = await apiGetList<PriorApplication>(
              `/vehicle-applications?owner_person_id=${hit._id}&limit=1`
            );
            if (mine !== gen.current) return;
            const prior = apps[0];
            if (!prior) return; // first-time applicant: nothing to carry over
            setForm((f) => ({
              ...f,
              school_year: f.school_year.trim() ? f.school_year : (prior.school_year ?? ""),
              mobile_no: f.mobile_no.trim() ? f.mobile_no : (prior.mobile_no ?? ""),
              email: f.email.trim() ? f.email : (prior.email ?? ""),
            }));
          } catch {
            // Ordinary: a first-time applicant has no history, and a failed
            // read only costs the clerk some typing. The person is resolved
            // either way, so this is not worth an error banner.
          }
        })
        .catch(() => {
          // Person lookup failed. Clearing `owner` matters as much as the
          // message: submit() sends owner._id, so a stale person from the
          // previous ID number would file the application against the wrong
          // human.
          if (mine !== gen.current) return;
          setOwner(null);
          setLookup("none");
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
  }, [form.id_number]);

  /**
   * Reuse the vehicle photo when renewing a plate the person already holds.
   *
   * Matched on PLATE, not vehicle type. Two cars owned by one person share a
   * type but are not the same vehicle, and the photo's whole job is to show the
   * guard the vehicle actually at the barrier — inheriting the other car's
   * picture would defeat it.
   */
  useEffect(() => {
    const mine = ++photoGen.current;
    const plate = form.plate_no.trim().toUpperCase();
    const ownerId = owner?._id;
    const isRenewal = form.category === "renewal";
    const t = setTimeout(() => {
      if (!isRenewal || !ownerId || !plate) {
        if (mine === photoGen.current) clearReusedPhoto();
        return;
      }
      apiGet<{ vehicles: PriorVehicle[] }>(`/persons/${ownerId}/overview`)
        .then(async ({ vehicles }) => {
          if (mine !== photoGen.current) return;
          const match = vehicles.find((v) => v.plate_number.trim().toUpperCase() === plate);
          if (!match) {
            clearReusedPhoto();
            return;
          }
          // 404 here is an ordinary state, not an error: the old vehicle simply
          // has no photo on file. The catch below falls back to capture.
          const blob = await apiGetBlob(`/vehicles/${match._id}/photo`);
          if (mine !== photoGen.current) return;
          setVehiclePhoto(blob);
          setReusedFromPlate(match.plate_number);
          setRetakePhoto(false);
          setReusedPhotoUrl((old) => {
            if (old) URL.revokeObjectURL(old);
            return URL.createObjectURL(blob);
          });
        })
        .catch(() => {
          if (mine === photoGen.current) clearReusedPhoto();
        });
    }, 300);
    return () => {
      clearTimeout(t);
      // eslint-disable-next-line react-hooks/exhaustive-deps
      photoGen.current++;
    };
  }, [form.category, form.plate_no, owner]);

  // Object URLs outlive the component unless revoked. Mirrors the same cleanup
  // the signature preview used to do.
  useEffect(() => {
    return () => {
      if (reusedPhotoUrl) URL.revokeObjectURL(reusedPhotoUrl);
    };
  }, [reusedPhotoUrl]);

  function resetForm() {
    setForm(EMPTY_FORM);
    setOwner(null);
    setLookup("idle");
    setVehiclePhoto(null);
    setOwnerPhoto(null);
    setRetakePhoto(false);
    clearReusedPhoto();
  }

  const requiredFilled = REQUIRED_KEYS.every((k) => form[k].trim().length > 0) && !!owner;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    if (!owner) {
      setError("Enter the applicant's ID number and wait for their record to load.");
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

      /*
       * Signature upload, commented out with the capture UI. It went to the
       * application id the server had just returned, matching the server's own
       * write ordering (application, then signature, then vehicle already
       * exists by the time we're here).
       *
       * if (signatureFile) {
       *   try {
       *     const png = await toPngBlob(signatureFile);
       *     const fd = new FormData();
       *     fd.append("signature", png, "signature.png");
       *     await apiUpload(`/vehicle-applications/${created.application._id}/signature`, fd);
       *   } catch (sigErr) {
       *     // The application and vehicle already exist and grant access; a
       *     // failed signature upload must not read as a failed registration.
       *     setError(
       *       `Registered ${created.vehicle.plate_number}, but the signature did not upload: ${
       *         (sigErr as Error).message
       *       }`
       *     );
       *     resetForm();
       *     onCreated(created.vehicle);
       *     return;
       *   }
       * }
       */

      // Photos upload AFTER the create, because the vehicle id does not exist
      // until the server returns it. A failure here is reported but never
      // rolls anything back: the pass is already valid, and revoking gate
      // access over a missing image is the worse failure.
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
          Enter the applicant&apos;s ID number first — their name and contact details fill in from
          their record.
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
              Limit: one active vehicle per person
            </span>
          </label>
        </div>
      </Section>

      {/* Applicant */}
      <Section title="Applicant" icon={TfiUser}>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-[13px] font-600 text-ink-soft">
            ID number
            <input
              required
              value={form.id_number}
              onChange={(e) => {
                // Drop the resolved person SYNCHRONOUSLY, the way the old owner
                // search did on every keystroke. The lookup below is debounced,
                // so without this there is a window where the ID number reads
                // as one person while `owner` still points at the previous one
                // — and submit() would file the application against `owner`.
                // requiredFilled gates on `owner`, so clearing it also disables
                // the submit button until the new ID resolves.
                setOwner(null);
                setForm((f) => ({
                  ...f,
                  id_number: e.target.value,
                  registered_owner_name: "",
                  rfid_uid: "",
                }));
              }}
              placeholder="e.g. 2025-0001"
              className={`mt-1 ${inputCls}`}
            />
            {lookup === "searching" && (
              <span className="mt-1 block text-[12px] font-400 text-ink-soft">
                Looking up this ID number…
              </span>
            )}
            {lookup === "none" && (
              <span className="mt-1 block text-[12px] font-400 text-ink">
                No person with that ID number. They must exist in the directory before a vehicle can
                be registered to them.
              </span>
            )}
          </label>

          <div className="block text-[13px] font-600 text-ink-soft">
            Owner
            <div
              className={`mt-1 flex min-h-[42px] items-center rounded-xl border border-line px-3 py-2 text-[14px] ${
                owner ? "bg-paper text-ink" : "bg-paper/50 text-ink-soft"
              }`}
            >
              {owner ? (
                <span>
                  <span className="font-600">{owner.full_name}</span>{" "}
                  <span className="text-ink-soft">· {owner.type}</span>
                </span>
              ) : (
                "Fills in from the ID number"
              )}
            </div>
          </div>

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

        {/*
          Name parts, year level, tel no. and permanent address were removed on
          2026-08-18. The applicant is resolved from the ID number now, so the
          name is read from their record rather than transcribed, and the
          mismatch warnings that used to sit here compared the typed name and ID
          against that same record — a comparison that cannot fail once the
          record IS the source. The server relaxed last_name/first_name to
          optional to match.

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
        */}
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
          <div className="block text-[13px] font-600 text-ink-soft">
            RFID UID — the owner&apos;s own card
            {/* Read-only and derived from the resolved applicant: a vehicle is
                not issued a sticker of its own any more, so there is nothing
                to scan here. The barrier identifies the vehicle by the owner
                tapping their card, which is also why one person may hold only
                one active pass (vehicles.service.assertWithinLimit). */}
            <div
              className={`mt-1 flex min-h-[42px] items-center rounded-xl border border-line px-3 py-2 font-mono text-[14px] ${
                form.rfid_uid ? "bg-paper text-ink" : "bg-paper/50 text-ink-soft"
              }`}
            >
              {form.rfid_uid || (owner ? "No card on file" : "Fills in from the ID number")}
            </div>
            {owner && !form.rfid_uid && (
              <span className="mt-1 block font-sans text-[12px] font-400 text-ink">
                {owner.full_name} has no RFID card yet. Issue them one in the directory first — a
                vehicle pass uses the owner&apos;s card.
              </span>
            )}
          </div>

          <div className="block text-[13px] font-600 text-ink-soft sm:col-span-2">
            Vehicle photo — shown to the guard at the barrier
            {reusedPhotoUrl && !retakePhoto ? (
              <div className="mt-1 flex items-start gap-3 rounded-xl border border-line bg-paper p-3">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={reusedPhotoUrl}
                  alt={`Existing photo for ${reusedFromPlate}`}
                  className="h-20 w-32 shrink-0 rounded-lg border border-line bg-white object-contain"
                />
                <div className="space-y-1">
                  <p className="text-[12px] font-400 text-ink">
                    Reusing the photo already on file for{" "}
                    <span className="font-600">{reusedFromPlate}</span>.
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      setRetakePhoto(true);
                      setVehiclePhoto(null);
                    }}
                    className="text-[12px] font-600 text-blue hover:underline"
                  >
                    Take a new photo instead
                  </button>
                </div>
              </div>
            ) : (
              <PhotoCapture onChange={setVehiclePhoto} />
            )}
          </div>
        </div>

        {/*
          MV file no., make, model, year and colour were removed on 2026-08-18.
          A vehicle is identified by plate, type and photo now. `make` was
          required server-side and was relaxed to optional to match; every
          reader of make/vehicle_model/color was already null-guarded, so they
          simply render nothing when absent.

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
        */}
      </Section>

      {/*
        The LTO, Ownership and Authorization sections were removed on
        2026-08-18. Their fields were already optional server-side except
        registered_owner_name (still sent, derived from the resolved person's
        full_name) and signed_name / signed_date (relaxed to optional).

        Signature capture went with the Authorization section. The
        applicationSignatures module, POST /vehicle-applications/:id/signature,
        and every signature already on file remain live — only this form stopped
        feeding them. toPngBlob and the upload block are commented out above.

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
      */}

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
