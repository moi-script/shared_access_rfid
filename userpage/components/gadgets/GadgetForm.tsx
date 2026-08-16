"use client";

import { useEffect, useRef, useState } from "react";
import { apiGetList, apiPost, apiUpload } from "@/lib/auth";
import PhotoCapture from "@/components/PhotoCapture";
import Notice from "@/components/Notice";
import { GADGET_TYPES, GADGET_LIMITS, gadgetTypeLabel } from "@/lib/gadgetTypes";

const inputCls =
  "w-full rounded-xl border border-line bg-white px-3 py-2 text-[14px] text-ink outline-none focus:border-blue focus:ring-4 focus:ring-blue/12";

interface OwnerHit {
  _id: string;
  full_name: string;
  id_number: string;
  type: string;
  department_section?: string;
}

export interface GadgetRecord {
  _id: string;
  gadget_type: string;
  brand_model: string;
  serial_number: string;
  photo_url?: string;
}

export interface GadgetFormInitialOwner {
  _id: string;
  full_name: string;
  id_number: string;
}

export default function GadgetForm({
  onCreated,
  onClose,
  initialOwner,
}: {
  onCreated: (gadget: GadgetRecord) => void;
  onClose: () => void;
  /** When supplied, the owner is pre-selected and the search field is locked
   * — e.g. opened from a person's own profile, where the owner is already
   * known and re-searching for them risks picking the wrong hit. Leave
   * undefined for the Register-tab usage, which keeps today's open search. */
  initialOwner?: GadgetFormInitialOwner;
}) {
  const [form, setForm] = useState({
    gadget_type: GADGET_TYPES[0] as string,
    brand_model: "",
    serial_number: "",
  });

  // Owner search — the same debounced generation-ref pattern
  // VehicleApplicationForm and AccountsView use, so a slow first keystroke's
  // response can never clobber a faster later one.
  const [ownerQuery, setOwnerQuery] = useState(initialOwner ? initialOwner.full_name : "");
  const [ownerResults, setOwnerResults] = useState<OwnerHit[]>([]);
  const [owner, setOwner] = useState<OwnerHit | null>(
    initialOwner
      ? { _id: initialOwner._id, full_name: initialOwner.full_name, id_number: initialOwner.id_number, type: "" }
      : null
  );
  const [searching, setSearching] = useState(false);
  const gen = useRef(0);
  const ownerLocked = Boolean(initialOwner);

  const [photo, setPhoto] = useState<Blob | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set when the gadget saved but its photo did not. The registration exists
  // and must not be rolled back — serial_number is unique, so a retry of the
  // whole POST would collide with the row just written. Same reasoning as
  // PersonForm's photoRetry.
  const [photoRetry, setPhotoRetry] = useState<GadgetRecord | null>(null);

  function set(k: keyof typeof form, v: string) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  useEffect(() => {
    // Every state update below happens inside the timeout callback (or the
    // fetch it kicks off), never synchronously in the effect body — this is the
    // debounce itself, not a stylistic echo of it.
    const mine = ++gen.current;
    const t = setTimeout(() => {
      if (owner || !ownerQuery.trim()) {
        if (mine === gen.current) setOwnerResults([]);
        return;
      }
      if (mine === gen.current) setSearching(true);
      apiGetList<OwnerHit>(`/persons?search=${encodeURIComponent(ownerQuery.trim())}&limit=8`)
        .then(({ items }) => {
          if (mine !== gen.current) return; // a newer search started; discard this
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
      // `gen` is a plain counter ref, not a DOM node, so there is no stale-node
      // hazard here — bumping it on every cleanup is exactly what invalidates
      // in-flight responses after unmount or query change.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      gen.current++;
    };
  }, [ownerQuery, owner]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!owner) {
      setError("Select the owner from the directory first.");
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const created = await apiPost<GadgetRecord>("/gadgets", {
        owner_person_id: owner._id,
        gadget_type: form.gadget_type,
        brand_model: form.brand_model.trim(),
        // Sent as typed. The server normalizes (trim + uppercase) so that the
        // value checked against the unique index and the value stored are
        // produced by one expression — doing it here as well would put a second
        // normalizer on a client that cannot be the authority for it.
        serial_number: form.serial_number,
      });
      if (photo) {
        try {
          const fd = new FormData();
          fd.append("photo", photo, "gadget.jpg");
          const uploaded = await apiUpload<{ photo_url: string }>(
            `/gadgets/${created._id}/photo`,
            fd
          );
          created.photo_url = uploaded.photo_url;
        } catch {
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

  const limit = GADGET_LIMITS[form.gadget_type as keyof typeof GADGET_LIMITS];

  return (
    <div className="fixed inset-0 z-40 grid place-items-start overflow-auto bg-ink/40 p-4 sm:p-8">
      <form
        onSubmit={submit}
        className="mx-auto w-full max-w-lg space-y-3 rounded-2xl border border-line bg-white p-6"
      >
        <div className="flex items-center justify-between">
          <h2 className="font-display text-xl font-700 tracking-tight text-ink">
            Register a device
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
          The device is identified at the gate by its owner&apos;s ID card. When they tap,
          the terminal shows this serial so the guard can check it against the device.
        </p>

        {error && (
          <Notice compact className="text-[13px] text-ink">
            {error}
          </Notice>
        )}

        {photoRetry && (
          <div className="rounded-xl bg-gold/10 px-4 py-3 text-[13px] text-ink">
            <p className="font-600">
              Registered {photoRetry.brand_model} — the photo didn&apos;t upload.
            </p>
            <p className="mt-0.5 text-ink-soft">
              The registration is saved. You can retry the photo now.
            </p>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                disabled={!photo || saving}
                onClick={async () => {
                  if (!photo) return;
                  setSaving(true);
                  try {
                    const fd = new FormData();
                    fd.append("photo", photo, "gadget.jpg");
                    const uploaded = await apiUpload<{ photo_url: string }>(
                      `/gadgets/${photoRetry._id}/photo`,
                      fd
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

        <div className="relative">
          <label className="block text-[13px] font-600 text-ink-soft">
            Owner — search by name or ID number
            <input
              required
              value={ownerQuery}
              disabled={ownerLocked}
              readOnly={ownerLocked}
              onChange={(e) => {
                if (ownerLocked) return;
                setOwner(null);
                setOwnerQuery(e.target.value);
              }}
              placeholder="Start typing to search the directory…"
              className={`mt-1 ${inputCls} ${ownerLocked ? "bg-paper text-ink-soft" : ""}`}
            />
          </label>
          {owner && (
            <p className="mt-1 flex items-center gap-2 text-[12px] text-ink-soft">
              Selected: <span className="font-600 text-ink">{owner.full_name}</span> (
              {owner.id_number})
              {!ownerLocked && (
                <button
                  type="button"
                  onClick={() => {
                    setOwner(null);
                    setOwnerQuery("");
                  }}
                  className="font-600 text-blue hover:underline"
                >
                  Change
                </button>
              )}
            </p>
          )}
          {!ownerLocked && !owner && (searching || ownerResults.length > 0) && ownerQuery.trim() && (
            <ul className="absolute z-10 mt-1 max-h-56 w-full overflow-auto rounded-xl border border-line bg-white shadow-lg">
              {searching && ownerResults.length === 0 && (
                <li className="px-3 py-2 text-[13px] text-ink-soft">Searching…</li>
              )}
              {ownerResults.map((o) => (
                <li key={o._id}>
                  <button
                    type="button"
                    onClick={() => {
                      setOwner(o);
                      setOwnerQuery(o.full_name);
                      setOwnerResults([]);
                    }}
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
        </div>

        <div className="grid grid-cols-2 gap-3">
          {/* Bound to GADGET_TYPES rather than hardcoded, so it renders one
              locked option today and needs no change when a second type is
              added to lib/gadgetTypes.ts. */}
          {GADGET_TYPES.length === 1 ? (
            <label className="block text-[13px] font-600 text-ink-soft">
              Device
              <input
                value={gadgetTypeLabel(GADGET_TYPES[0])}
                disabled
                readOnly
                className="mt-1 w-full rounded-xl border border-line bg-paper px-3 py-2 text-ink-soft"
              />
            </label>
          ) : (
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
            </label>
          )}
          <label className="block text-[13px] font-600 text-ink-soft">
            Brand and model
            <input
              required
              value={form.brand_model}
              onChange={(e) => set("brand_model", e.target.value)}
              placeholder="e.g. Dell Latitude 5420"
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
            placeholder="Printed on the underside or under the battery"
            className={`mt-1 font-mono ${inputCls}`}
          />
        </label>
        <p className="text-[12px] text-ink-soft">
          Case and spacing don&apos;t matter — the serial is stored uppercase. One device
          can only be registered to one person.
        </p>

        <PhotoCapture onChange={setPhoto} />

        <p className="text-[12px] text-ink-soft">
          {limit === 1
            ? "One active device per person. If they already have one, deactivate it first."
            : `Up to ${limit} active devices of this kind per person.`}
        </p>

        <button
          type="submit"
          disabled={saving}
          className="w-full rounded-xl bg-navy px-4 py-2.5 text-sm font-600 text-white hover:bg-navy/90 disabled:opacity-60"
        >
          {saving ? "Saving…" : "Register device"}
        </button>
      </form>
    </div>
  );
}
