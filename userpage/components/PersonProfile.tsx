"use client";

import { useCallback, useEffect, useState } from "react";
import { apiGet, getStoredUser } from "@/lib/auth";
import ProfileView, { InfoBanner, type PersonOverview } from "@/components/ProfileView";
import RegistrationForm, { type PersonRecord } from "@/components/RegistrationForm";
import DeletePersonDialog from "@/components/DeletePersonDialog";
import GadgetForm from "@/components/gadgets/GadgetForm";
import { canRegisterGadgets } from "@/lib/permissions";
import type { Role } from "@/lib/auth";

export default function PersonProfile({
  personId,
  name,
  onBack,
}: {
  personId: string;
  name?: string;
  onBack: () => void;
}) {
  const [data, setData] = useState<PersonOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [showDelete, setShowDelete] = useState(false);
  // Delete is superadmin-only in the UI; the server enforces this
  // regardless (personRoutes.delete is authorize(ROLES.SUPERADMIN)).
  const isSuperadmin = getStoredUser()?.role === "superadmin";
  const [showGadget, setShowGadget] = useState(false);
  const myRole = (getStoredUser()?.role ?? "staff") as Role;
  const canGadget = canRegisterGadgets(myRole);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    apiGet<PersonOverview>(`/persons/${personId}/overview`)
      .then(setData)
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, [personId]);

  useEffect(() => {
    load();
  }, [load]);

  const record: PersonRecord | null = data?.person
    ? {
        full_name: data.person.full_name,
        type: data.person.type,
        id_number: data.person.id_number,
        department_section: data.person.department_section,
        contact_email: data.person.contact_email,
        photo_url: data.person.photo_url,
        rfid_uid: data.person.rfid_uid,
        status: data.person.status,
        createdAt: data.person.createdAt,
      }
    : null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <button
          onClick={onBack}
          className="inline-flex items-center gap-1.5 text-[14px] font-600 text-blue hover:underline"
        >
          <span aria-hidden>←</span> Back to directory
        </button>
        {record && (
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowForm(true)}
              className="rounded-xl border border-line bg-white px-3 py-1.5 text-[13px] font-600 text-ink-soft hover:text-ink"
            >
              Print form
            </button>
            {canGadget && (
              <button
                onClick={() => setShowGadget(true)}
                className="rounded-xl border border-line bg-white px-3 py-1.5 text-[13px] font-600 text-ink-soft hover:text-ink"
              >
                Register device
              </button>
            )}
            {isSuperadmin && (
              <button
                onClick={() => setShowDelete(true)}
                className="rounded-xl border-2 border-red bg-white px-3 py-1.5 text-[13px] font-600 text-ink hover:bg-red/25 hover:text-ink"
              >
                Delete
              </button>
            )}
          </div>
        )}
      </div>

      {loading && <p className="text-ink-soft">Loading {name ?? "profile"}…</p>}
      {error && <InfoBanner>Couldn&apos;t load profile: {error}</InfoBanner>}
      {data && <ProfileView data={data} />}

      {showForm && record && (
        <RegistrationForm person={record} onClose={() => setShowForm(false)} />
      )}

      {showDelete && record && (
        <DeletePersonDialog
          personId={personId}
          personName={record.full_name}
          idNumber={record.id_number}
          rfidUid={record.rfid_uid || null}
          onClose={() => setShowDelete(false)}
          onDeleted={() => {
            setShowDelete(false);
            onBack();
          }}
        />
      )}

      {showGadget && record && (
        <GadgetForm
          initialOwner={{
            _id: personId,
            full_name: record.full_name,
            id_number: record.id_number,
          }}
          onCreated={() => {
            setShowGadget(false);
            load();
          }}
          onClose={() => setShowGadget(false)}
        />
      )}
    </div>
  );
}
