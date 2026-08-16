"use client";

import NcstMark from "@/components/NcstMark";
import { PersonAvatar } from "@/components/AuthedImage";

export interface PersonRecord {
  full_name: string;
  type: string;
  id_number: string;
  department_section?: string | null;
  contact_email?: string | null;
  photo_url?: string | null;
  rfid_uid?: string | null;
  status: string;
  createdAt?: string;
  /** Set by POST /persons: whether a login was created alongside the person. */
  login_created?: boolean;
}

function Field({ label, value }: { label: string; value?: string | null }) {
  return (
    <div className="border-b border-line py-2">
      <p className="text-[11px] font-600 uppercase tracking-[0.14em] text-ink-soft">
        {label}
      </p>
      <p className="mt-0.5 text-[15px] text-ink">{value || "—"}</p>
    </div>
  );
}

export default function RegistrationForm({
  person,
  onClose,
}: {
  person: PersonRecord;
  onClose: () => void;
}) {
  const created = person.createdAt
    ? new Date(person.createdAt).toLocaleDateString()
    : new Date().toLocaleDateString();

  return (
    <div className="fixed inset-0 z-50 overflow-auto bg-ink/40 p-4 sm:p-8">
      <div className="mx-auto max-w-2xl">
        {/* Toolbar — hidden when printing */}
        <div className="mb-3 flex justify-end gap-2 print:hidden">
          <button
            onClick={onClose}
            className="rounded-xl border border-line bg-white px-4 py-2 text-sm font-600 text-ink-soft hover:text-ink"
          >
            Close
          </button>
          <button
            onClick={() => window.print()}
            className="rounded-xl bg-navy px-4 py-2 text-sm font-600 text-white hover:bg-navy/90"
          >
            Print
          </button>
        </div>

        {/* Printable record */}
        <div className="print-area rounded-2xl border border-line bg-white p-8">
          <div className="flex items-center gap-3 border-b-2 border-navy pb-4">
            <NcstMark className="h-12 w-12" />
            <div>
              <p className="font-display text-lg font-700 tracking-tight text-ink">
                NCST RFID System
              </p>
              {/* Light blue, not yellow: this is small caps on white, and it
                  gets printed. Yellow on white is 1.6:1. */}
              <p className="text-[12px] font-600 uppercase tracking-[0.18em] text-blue">
                Registration Record
              </p>
            </div>
          </div>

          <div className="mt-6 flex gap-6">
            <div className="grid h-24 w-24 shrink-0 place-items-center overflow-hidden rounded-xl border border-line bg-paper text-ink-soft">
              <PersonAvatar person={person} />
            </div>
            <div className="min-w-0 flex-1">
              <Field label="Full name" value={person.full_name} />
              <Field label="Type" value={person.type} />
              <Field label="ID number" value={person.id_number} />
            </div>
          </div>

          <div className="mt-4 grid gap-x-8 sm:grid-cols-2">
            <Field label="Course / Section" value={person.department_section} />
            <Field label="Email" value={person.contact_email} />
            <Field
              label="RFID UID"
              value={person.rfid_uid || "Not yet assigned"}
            />
            <Field label="Status" value={person.status} />
            <Field label="Date registered" value={created} />
          </div>

          <div className="mt-10 grid grid-cols-2 gap-8">
            <div className="border-t border-ink pt-1 text-[12px] text-ink-soft">
              Registrant signature
            </div>
            <div className="border-t border-ink pt-1 text-[12px] text-ink-soft">
              Admin signature / date
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
