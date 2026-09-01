"use client";

import { useCallback, useEffect, useState } from "react";
import { apiGet, getStoredUser } from "@/lib/auth";
import ProfileView, { InfoBanner, type PersonOverview } from "@/components/ProfileView";
import RegistrationForm, { type PersonRecord } from "@/components/RegistrationForm";
// Unused while the profile's Delete button is commented out; the component file
// itself is left in place.
// import DeletePersonDialog from "@/components/DeletePersonDialog";
import ErasePersonDialog from "@/components/ErasePersonDialog";
import GadgetForm from "@/components/gadgets/GadgetForm";
import GadgetEditForm, { type EditableGadget } from "@/components/gadgets/GadgetEditForm";
import VehicleEditForm, { type EditableVehicle } from "@/components/vehicles/VehicleEditForm";
import PersonEditForm, { type EditablePerson } from "@/components/PersonEditForm";
import ReplaceCardDialog from "@/components/ReplaceCardDialog";
import { canRegisterGadgets } from "@/lib/permissions";
import ReplaceTagDialog, { type TagKind } from "@/components/ReplaceTagDialog";
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
  // Commented out with the Delete button below; kept for re-arming. isSuperadmin
  // had no other reader in this file, so it is parked here rather than left unused.
  // const [showDelete, setShowDelete] = useState(false);
  // // Delete is superadmin-only in the UI; the server enforces this
  // // regardless (personRoutes.delete is authorize(ROLES.SUPERADMIN)).
  // const isSuperadmin = getStoredUser()?.role === "superadmin";
  const [showGadget, setShowGadget] = useState(false);
  // Editing the person's own fields (name, type, department, email, photo) and
  // replacing their card — the same two entry points StudentsDirectory already
  // offers per row, added here so a profile visit doesn't require a trip back
  // to the directory just to fix a typo. Unconditional like Print form above:
  // the server is what actually enforces write authority (assertCanWrite on
  // both the current and incoming type for edits), this is only a usability
  // layer, matching PersonEditForm's own header comment.
  const [showEdit, setShowEdit] = useState(false);
  const [showCard, setShowCard] = useState(false);
  // The gadget/vehicle row being edited, or null. Holds the current field
  // values (not just an id) so the edit dialog can prefill without a second
  // fetch — mirrors tagTarget below.
  const [editGadget, setEditGadget] = useState<EditableGadget | null>(null);
  const [editVehicle, setEditVehicle] = useState<EditableVehicle | null>(null);
  const [showErase, setShowErase] = useState(false);
  const myRole = (getStoredUser()?.role ?? "staff") as Role;
  const canGadget = canRegisterGadgets(myRole);
  // Erase is superadmin-only in the UI; the server enforces this regardless
  // (personRoutes.delete('/:id/erase', authorize(ROLES.SUPERADMIN))). This is
  // a separate flag from the commented-out Delete button's isSuperadmin
  // above, kept live because erase is a live, independent feature.
  const isSuperadmin = myRole === "superadmin";
  // The row whose sticker is being swapped, or null. Holds the whole target
  // rather than an id: the dialog shows the plate/model and the current tag,
  // and re-deriving those from `data` after a refresh would race the reload.
  const [tagTarget, setTagTarget] = useState<
    { kind: TagKind; id: string; label: string; currentUid: string | null } | null
  >(null);

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
              onClick={() => setShowEdit(true)}
              className="rounded-xl border border-line bg-white px-3 py-1.5 text-[13px] font-600 text-ink-soft hover:text-ink"
            >
              Edit
            </button>
            <button
              onClick={() => setShowCard(true)}
              className="rounded-xl border border-line bg-white px-3 py-1.5 text-[13px] font-600 text-ink-soft hover:text-ink"
            >
              Replace card
            </button>
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
            {/* Delete button — see the note by the DeletePersonDialog mount below.
            {isSuperadmin && (
              <button
                onClick={() => setShowDelete(true)}
                className="rounded-xl border-2 border-red bg-white px-3 py-1.5 text-[13px] font-600 text-ink hover:bg-red/25 hover:text-ink"
              >
                Delete
              </button>
            )}
            */}
            {/* Erase — the hard delete, separate from Delete above. See
                ErasePersonDialog's own header comment. This runs in
                production: the real gate is the superadmin-only route plus
                the typed-name confirmation in the dialog, not this button
                being hard to find. */}
            {isSuperadmin && (
              <button
                onClick={() => setShowErase(true)}
                className="rounded-xl border-2 border-red bg-white px-3 py-1.5 text-[13px] font-600 text-ink hover:bg-red/25 hover:text-ink"
              >
                Erase Data
              </button>
            )}
          </div>
        )}
      </div>

      {loading && <p className="text-ink-soft">Loading {name ?? "profile"}…</p>}
      {error && <InfoBanner>Couldn&apos;t load profile: {error}</InfoBanner>}
      {data && (
        <ProfileView
          data={data}
          // Passed only when this operator may actually write to that domain.
          // Omitted entirely otherwise, which is also what hides these controls
          // on a student's own dashboard — it renders ProfileView with no
          // callback at all. The API enforces the real boundary either way.
          onReplaceTag={
            canGadget
              ? (kind, id, label, currentUid) => setTagTarget({ kind, id, label, currentUid  })
              : undefined
          }
          onEditGadget={
            canGadget ? (id, current) => setEditGadget({ _id: id, ...current }) : undefined
          }
          // Not gated on canGadget — vehicle write authority is a separate
          // domain from gadgets. Left ungated here, the same way Print form
          // above is: the server's assertCanWrite('vehicle') is the real
          // check, this only decides whether the button is worth showing.
          onEditVehicle={(id, current) => setEditVehicle({ _id: id, ...current })}
        />
      )}

      {tagTarget && (
        <ReplaceTagDialog
          kind={tagTarget.kind}
          id={tagTarget.id}
          label={tagTarget.label}
          currentUid={tagTarget.currentUid}
          onClose={() => setTagTarget(null)}
          onReplaced={() => {
            setTagTarget(null);
            // Refetch rather than patching state: the swap also blocks the old
            // tag, and the profile should show what the server now holds.
            load();
          }}
        />
      )}

      {showForm && record && (
        <RegistrationForm person={record} onClose={() => setShowForm(false)} />
      )}

      {showEdit && data?.person && (
        <PersonEditForm
          person={
            {
              _id: personId,
              full_name: data.person.full_name,
              type: data.person.type,
              id_number: data.person.id_number,
              department_section: data.person.department_section,
              contact_email: data.person.contact_email,
              photo_url: data.person.photo_url,
            } satisfies EditablePerson
          }
          onClose={() => setShowEdit(false)}
          onSaved={() => {
            setShowEdit(false);
            load();
          }}
        />
      )}

      {showCard && record && (
        <ReplaceCardDialog
          personId={personId}
          personName={record.full_name}
          currentUid={record.rfid_uid || null}
          onClose={() => setShowCard(false)}
          onReplaced={() => {
            setShowCard(false);
            load();
          }}
        />
      )}

      {/*
        Delete was removed from the profile by request, matching the directory
        table. It is commented out rather than deleted so it can be re-armed in
        one edit: nothing underneath it changed. DeletePersonDialog,
        persons.service.softDelete with its vehicle/gadget/login cascade and
        card block, and the superadmin-only DELETE /persons/:id route are all
        still live. With the directory's button also commented out, this was the
        last Delete entry point in the UI — DeletePersonDialog now has no
        importer and is kept deliberately, not by accident.
      */}
      {/*
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
      */}

      {showErase && record && (
        <ErasePersonDialog
          personId={personId}
          personName={record.full_name}
          rfidUid={record.rfid_uid || null}
          onClose={() => setShowErase(false)}
          onPurged={() => {
            setShowErase(false);
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

      {editGadget && (
        <GadgetEditForm
          gadget={editGadget}
          onClose={() => setEditGadget(null)}
          onSaved={() => {
            setEditGadget(null);
            load();
          }}
        />
      )}

      {editVehicle && (
        <VehicleEditForm
          vehicle={editVehicle}
          onClose={() => setEditVehicle(null)}
          onSaved={() => {
            setEditVehicle(null);
            load();
          }}
        />
      )}
    </div>
  );
}