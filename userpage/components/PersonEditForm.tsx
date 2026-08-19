"use client";

import { useState } from "react";
import { apiPatch, getStoredUser, type Role } from "@/lib/auth";
import { personTypesFor } from "@/lib/permissions";
import Notice from "@/components/Notice";

export interface EditablePerson {
  _id: string;
  full_name: string;
  type: string;
  id_number: string;
  department_section: string | null;
  contact_email: string | null;
}

const inputCls =
  "w-full rounded-xl border border-line bg-white px-3 py-2 text-[14px] text-ink outline-none focus:border-blue focus:ring-4 focus:ring-blue/12";

export default function PersonEditForm({
  person,
  onSaved,
  onClose,
}: {
  person: EditablePerson;
  onSaved: (updated: EditablePerson) => void;
  onClose: () => void;
}) {
  // A usability layer only — the server re-checks both the existing and the
  // incoming type's write domain (assertCanWrite on both sides), so a
  // registrar cannot claim a staff record or push a student out of their
  // own domain even if this list were somehow bypassed client-side.
  const myRole = (getStoredUser()?.role ?? "staff") as Role;
  const allowedTypes = personTypesFor(myRole);
  // The record's own type must stay selectable even if it isn't in this
  // actor's allowed set, otherwise the field would render with a value the
  // <select> has no matching <option> for.
  const typeOptions: string[] = (allowedTypes as string[]).includes(person.type)
    ? allowedTypes
    : [person.type, ...allowedTypes];

  const [form, setForm] = useState({
    full_name: person.full_name,
    type: person.type,
    department_section: person.department_section ?? "",
    contact_email: person.contact_email ?? "",
  });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function set(k: keyof typeof form, v: string) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    const payload: Record<string, string> = {
      full_name: form.full_name.trim(),
      type: form.type,
    };
    // contact_email is z.string().email().optional() server-side: absence is
    // fine, but an empty string is not — it 422s the .email() check, so it is
    // only sent when non-empty. Mirrors PersonForm's create-side pattern.
    const email = form.contact_email.trim();
    if (email) payload.contact_email = email;

    // department_section is z.string().optional() with NO .email()-style
    // validator and no required flag on the Mongo field, so "" is accepted
    // and clears it — the same guard as contact_email would silently drop an
    // emptied section from the payload and no-op the save. Send it
    // unconditionally so a wrongly-entered section can be blanked out again.
    payload.department_section = form.department_section.trim();
    try {
      const updated = await apiPatch<EditablePerson>(`/persons/${person._id}`, payload);
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
            Edit person
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
          {typeOptions.length <= 1 ? (
            <label className="block text-[13px] font-600 text-ink-soft">
              Type
              <input
                value={form.type}
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
                {typeOptions.map((t) => (
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
              value={person.id_number}
              disabled
              readOnly
              className="mt-1 w-full rounded-xl border border-line bg-paper px-3 py-2 font-mono text-ink-soft"
            />
            <span className="mt-1 block text-[12px] text-ink-soft">
              Read-only — this is also their login username.
            </span>
          </label>
        </div>

        <label className="block text-[13px] font-600 text-ink-soft">
          Department
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
