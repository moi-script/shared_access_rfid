"use client";

import { useCallback, useEffect, useState } from "react";
import { apiGet, apiGetList, apiGetBlob, getStoredUser } from "@/lib/auth";
import PersonForm from "@/components/PersonForm";
import PersonEditForm from "@/components/PersonEditForm";
import ReplaceCardDialog from "@/components/ReplaceCardDialog";
// Unused while the directory's Delete button is commented out; the component
// itself is still live and used by PersonProfile.
// import DeletePersonDialog from "@/components/DeletePersonDialog";
import RestorePersonDialog from "@/components/RestorePersonDialog";
import RegistrationForm, { type PersonRecord } from "@/components/RegistrationForm";
import ImportPersons from "@/components/ImportPersons";
import Notice from "@/components/Notice";
import SectionHeading from "@/components/SectionHeading";
import { TfiDownload, TfiIdBadge, TfiImport, TfiPlus, TfiTrash } from "react-icons/tfi";

interface Person {
  _id: string;
  full_name: string;
  type: "student" | "staff" | "employee";
  id_number: string;
  department_section: string | null;
  contact_email: string | null;
  rfid_uid: string;
  status: "active" | "inactive";
  createdAt?: string;
}

type TypeFilter = "all" | "student" | "staff" | "employee";

const TYPES: { value: TypeFilter; label: string }[] = [
  { value: "all", label: "All types" },
  { value: "student", label: "Students" },
  { value: "staff", label: "Staff" },
  { value: "employee", label: "Employees" },
];

export default function StudentsDirectory({
  onView,
}: {
  onView: (personId: string, name: string) => void;
}) {
  const [search, setSearch] = useState("");
  const [type, setType] = useState<TypeFilter>("student");
  const [section, setSection] = useState("all");
  const [sections, setSections] = useState<string[]>([]);
  const [rows, setRows] = useState<Person[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [printPerson, setPrintPerson] = useState<PersonRecord | null>(null);
  const [editPerson, setEditPerson] = useState<Person | null>(null);
  const [cardPerson, setCardPerson] = useState<Person | null>(null);
  // Unused while the Delete button above is commented out; kept for re-arming.
  // const [deletePerson, setDeletePerson] = useState<Person | null>(null);
  const [restorePerson, setRestorePerson] = useState<Person | null>(null);

  // Delete and restore are superadmin-only in the UI; the server enforces
  // this regardless, this is only a usability layer.
  const isSuperadmin = getStoredUser()?.role === "superadmin";

  // GET /persons/deleted is a real, server-backed, superadmin-only read (the
  // deliberate counterpart to findPaginated's unconditional `deleted_at:
  // null`), so this view survives a reload instead of only reflecting people
  // this browser session happened to delete itself — a session-only view
  // meant restore was unreachable for anyone whose deletion predates the
  // current page load.
  const [deletedRows, setDeletedRows] = useState<Person[]>([]);
  const [deletedTotal, setDeletedTotal] = useState(0);
  const [deletedLoading, setDeletedLoading] = useState(false);
  const [deletedError, setDeletedError] = useState<string | null>(null);
  const [showDeleted, setShowDeleted] = useState(false);

  // Load the section list for the chosen type; reset section when type changes.
  useEffect(() => {
    const qs = type === "all" ? "" : `?type=${encodeURIComponent(type)}`;
    apiGet<string[]>(`/persons/sections${qs}`)
      .then(setSections)
      .catch(() => setSections([]));
    setSection("all");
  }, [type]);

  const fetchRows = useCallback(() => {
    const params = new URLSearchParams({ limit: "100" });
    if (type !== "all") params.set("type", type);
    if (section !== "all") params.set("section", section);
    if (search.trim()) params.set("search", search.trim());

    setLoading(true);
    setError(null);
    apiGetList<Person>(`/persons?${params.toString()}`)
      .then(({ items, total }) => {
        setRows(items);
        setTotal(total);
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, [type, section, search]);

  // Debounce so typing in the search box doesn't fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(fetchRows, 250);
    return () => clearTimeout(t);
  }, [fetchRows]);

  // Deliberately does NOT inherit type/section/search from the live-directory
  // filters above: those controls render only in the non-deleted view (type
  // defaults to "student"), so applying them here silently hid deleted staff/
  // employee records and any leftover search text — on the one screen whose
  // entire purpose is finding a record to restore. This view always shows
  // every deleted person.
  const fetchDeletedRows = useCallback(() => {
    const params = new URLSearchParams({ limit: "100" });

    setDeletedLoading(true);
    setDeletedError(null);
    apiGetList<Person>(`/persons/deleted?${params.toString()}`)
      .then(({ items, total }) => {
        setDeletedRows(items);
        setDeletedTotal(total);
      })
      .catch((err: Error) => setDeletedError(err.message))
      .finally(() => setDeletedLoading(false));
  }, []);

  // Only fetched while the deleted view is open — a superadmin-only read
  // there is no reason to run on every directory load. Deferred via
  // setTimeout (0ms; no debounce need remains now that this has no filter
  // inputs) rather than called synchronously in the effect body, matching
  // the pattern fetchRows above already uses and avoiding a
  // react-hooks/set-state-in-effect lint error.
  useEffect(() => {
    if (!showDeleted) return;
    const t = setTimeout(fetchDeletedRows, 0);
    return () => clearTimeout(t);
  }, [showDeleted, fetchDeletedRows]);

  async function exportCsv() {
    const params = new URLSearchParams();
    if (type !== "all") params.set("type", type);
    if (section !== "all") params.set("section", section);
    if (search.trim()) params.set("search", search.trim());
    const blob = await apiGetBlob(`/persons/export?${params.toString()}`);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `persons-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const selectCls =
    "rounded-xl border border-line bg-white px-3 py-2 text-[14px] text-ink outline-none focus:border-blue focus:ring-4 focus:ring-blue/12";

  return (
    <section className="rounded-2xl border border-line bg-white p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SectionHeading icon={TfiIdBadge}>Directory</SectionHeading>
        <div className="flex items-center gap-3">
          <span className="text-[12px] text-ink-soft">
            {showDeleted
              ? deletedLoading
                ? "Loading…"
                : `${deletedTotal} deleted`
              : loading
                ? "Loading…"
                : `${total} ${total === 1 ? "person" : "people"}`}
          </span>
          {isSuperadmin && (
            <button
              onClick={() => setShowDeleted((v) => !v)}
              aria-pressed={showDeleted}
              title="People soft-deleted by a superadmin; restoring returns the record only, the card stays permanently blocked"
              className={`flex items-center gap-2 rounded-xl border px-3 py-1.5 text-[13px] font-600 ${
                showDeleted
                  ? "border-red bg-red/25 text-ink"
                  : "border-line bg-white text-ink-soft hover:text-ink"
              }`}
            >
              <TfiTrash aria-hidden className="h-3 w-3" />
              {showDeleted ? "Showing deleted" : "Show deleted"}
            </button>
          )}
          <button
            onClick={exportCsv}
            className="flex items-center gap-2 rounded-xl border border-line bg-white px-3 py-1.5 text-[13px] font-600 text-ink-soft hover:text-ink"
          >
            <TfiDownload aria-hidden className="h-3 w-3" />
            Export CSV
          </button>
          <button
            onClick={() => setShowImport(true)}
            className="flex items-center gap-2 rounded-xl border border-line bg-white px-3 py-1.5 text-[13px] font-600 text-ink-soft hover:text-ink"
          >
            <TfiImport aria-hidden className="h-3 w-3" />
            Import CSV
          </button>
          <button
            onClick={() => setShowForm(true)}
            className="flex items-center gap-2 rounded-xl bg-navy px-3 py-1.5 text-[13px] font-600 text-white hover:bg-navy/90"
          >
            <TfiPlus aria-hidden className="h-3 w-3" />
            Add person
          </button>
        </div>
      </div>

      {showDeleted && (
        <p className="mt-3 rounded-xl bg-paper px-4 py-2 text-[12px] text-ink-soft">
          Restoring returns a record only; the card stays permanently blocked.
        </p>
      )}
      {showDeleted && deletedError && (
        <Notice compact className="mt-3 text-[13px] text-ink">
          {deletedError}
        </Notice>
      )}

      {!showDeleted && (
        <>
          {/* Controls */}
          <div className="mt-3 flex flex-wrap gap-2">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name or ID number…"
              className="min-w-[200px] flex-1 rounded-xl border border-line bg-white px-4 py-2 text-[14px] text-ink outline-none placeholder:text-ink-soft/50 focus:border-blue focus:ring-4 focus:ring-blue/12"
            />
            <select
              value={type}
              onChange={(e) => setType(e.target.value as TypeFilter)}
              className={selectCls}
              aria-label="Filter by type"
            >
              {TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
            <select
              value={section}
              onChange={(e) => setSection(e.target.value)}
              className={selectCls}
              aria-label="Filter by course and section"
            >
              <option value="all">All courses / sections</option>
              {sections.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>

          {error && (
            <Notice compact className="mt-3 text-[13px] text-ink">
              {error}
            </Notice>
          )}

          {/* Table */}
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-[14px]">
              <thead>
                <tr className="border-b border-line text-[12px] uppercase tracking-wide text-ink-soft">
                  <th className="py-2 font-600">Name</th>
                  <th className="py-2 font-600">ID number</th>
                  <th className="py-2 font-600">Type</th>
                  <th className="py-2 font-600">Department</th>
                  <th className="py-2 font-600">Status</th>
                  <th className="py-2 font-600">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && !loading ? (
                  <tr>
                    <td colSpan={6} className="py-6 text-center text-[14px] text-ink-soft">
                      No people match your filters.
                    </td>
                  </tr>
                ) : (
                  rows.map((p) => (
                    <tr
                      key={p._id}
                      onClick={() => onView(p._id, p.full_name)}
                      className="cursor-pointer border-b border-line/60 transition hover:bg-paper"
                    >
                      <td className="py-2.5 font-600 text-ink">{p.full_name}</td>
                      <td className="py-2.5 font-mono text-[13px] text-ink-soft">{p.id_number}</td>
                      <td className="py-2.5 capitalize text-ink-soft">{p.type}</td>
                      <td className="py-2.5 text-ink-soft">{p.department_section ?? "—"}</td>
                      <td className="py-2.5">
                        <span
                          className={`rounded-md px-2 py-0.5 text-[12px] font-600 capitalize ${
                            p.status === "active"
                              ? "border border-blue bg-blue/25 text-ink"
                              : "border border-red bg-red/25 text-ink"
                          }`}
                        >
                          {p.status}
                        </span>
                      </td>
                      <td className="py-2.5 text-right text-[13px] font-600">
                        <div className="flex items-center justify-end gap-3">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setEditPerson(p);
                            }}
                            className="text-blue hover:underline"
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setCardPerson(p);
                            }}
                            className="text-blue hover:underline"
                          >
                            Replace card
                          </button>
                          {/* Delete button — see the note by the DeletePersonDialog mount below.
                          {isSuperadmin && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setDeletePerson(p);
                              }}
                              className="font-600 text-ink underline decoration-red decoration-2 underline-offset-2 hover:decoration-[3px]"
                            >
                              Delete
                            </button>
                          )}
                          */}
                          <span className="text-ink-soft">View →</span>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {showDeleted && (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-[14px]">
            <thead>
              <tr className="border-b border-line text-[12px] uppercase tracking-wide text-ink-soft">
                <th className="py-2 font-600">Name</th>
                <th className="py-2 font-600">ID number</th>
                <th className="py-2 font-600">Type</th>
                <th className="py-2 font-600">Status</th>
                <th className="py-2 font-600">Actions</th>
              </tr>
            </thead>
            <tbody>
              {deletedRows.length === 0 && !deletedLoading ? (
                <tr>
                  <td colSpan={5} className="py-6 text-center text-[14px] text-ink-soft">
                    No deleted people.
                  </td>
                </tr>
              ) : (
                deletedRows.map((p) => (
                  <tr
                    key={p._id}
                    className="border-b border-line/60 bg-red/[0.04]"
                  >
                    <td className="py-2.5 font-600 text-ink/70 line-through decoration-red/60">
                      {p.full_name}
                    </td>
                    <td className="py-2.5 font-mono text-[13px] text-ink-soft">{p.id_number}</td>
                    <td className="py-2.5 capitalize text-ink-soft">{p.type}</td>
                    <td className="py-2.5">
                      <span className="rounded-md bg-ink px-2 py-0.5 text-[12px] font-600 uppercase tracking-wide text-white">
                        Deleted
                      </span>
                    </td>
                    <td className="py-2.5 text-right text-[13px] font-600">
                      <button
                        type="button"
                        onClick={() => setRestorePerson(p)}
                        className="text-blue hover:underline"
                      >
                        Restore
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {showForm && (
        <PersonForm
          onClose={() => setShowForm(false)}
          onCreated={(person) => {
            setShowForm(false);
            setPrintPerson(person);
            fetchRows();
          }}
        />
      )}
      {printPerson && (
        <RegistrationForm
          person={printPerson}
          onClose={() => setPrintPerson(null)}
        />
      )}
      {showImport && (
        <ImportPersons
          onClose={() => setShowImport(false)}
          onDone={fetchRows}
        />
      )}
      {editPerson && (
        <PersonEditForm
          person={editPerson}
          onClose={() => setEditPerson(null)}
          onSaved={() => {
            setEditPerson(null);
            fetchRows();
          }}
        />
      )}
      {cardPerson && (
        <ReplaceCardDialog
          personId={cardPerson._id}
          personName={cardPerson.full_name}
          currentUid={cardPerson.rfid_uid}
          onClose={() => setCardPerson(null)}
          onReplaced={() => {
            setCardPerson(null);
            fetchRows();
          }}
        />
      )}
      {/*
        Delete was removed from the directory table by request. It is commented
        out rather than deleted so it can be re-armed in one edit: nothing
        underneath it changed. DeletePersonDialog, persons.service.softDelete
        with its vehicle/gadget/login cascade and card block, and the
        superadmin-only DELETE /persons/:id route are all still live, and Delete
        is still reachable from a person's profile page. This hides the
        row-level entry point, nothing more.
      */}
      {/*
      {deletePerson && (
        <DeletePersonDialog
          personId={deletePerson._id}
          personName={deletePerson.full_name}
          idNumber={deletePerson.id_number}
          rfidUid={deletePerson.rfid_uid || null}
          onClose={() => setDeletePerson(null)}
          onDeleted={() => {
            setDeletePerson(null);
            fetchRows();
            if (showDeleted) fetchDeletedRows();
          }}
        />
      )}
      */}
      {restorePerson && (
        <RestorePersonDialog
          personId={restorePerson._id}
          personName={restorePerson.full_name}
          onClose={() => setRestorePerson(null)}
          onRestored={() => {
            setRestorePerson(null);
            fetchRows();
            fetchDeletedRows();
          }}
        />
      )}
    </section>
  );
}
