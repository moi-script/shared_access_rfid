"use client";

import { useCallback, useEffect, useState } from "react";
import { apiGet, apiGetList, apiGetBlob, apiPatch, apiPost, getStoredUser } from "@/lib/auth";
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
  // 'pending' is real and reachable: personService.create assigns it to anyone
  // registered without a card. It was missing here, which made the row toggle
  // look total when it was not — the badge renders every non-active state the
  // same way, and the toggle offers "Activate" for all of them.
  status: "active" | "inactive" | "pending";
  createdAt?: string;
  /** Most recent passage admitted on a hand-typed ID number instead of a card,
   *  within the server's 30-day window. Null for everyone who has only ever
   *  tapped. See personService's MANUAL_ENTRY_WINDOW_DAYS. */
  manual_entry_at?: string | null;
  manual_entry_count?: number;
}

type TypeFilter = "all" | "student" | "staff" | "employee";

interface Preview {
  matched: number;
  excluded: number;
}

const CONFIRM_WORD = "DEACTIVATE";

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

  // Status changes — the per-row toggle and the whole-filter sweep. `busy`
  // covers both so a second click cannot race the first, and `result` reports
  // what a sweep actually did (a filter can match people this actor may not
  // write, and those are silently excluded server-side).
  const [busy, setBusy] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<Preview | null>(null);
  // Which direction the open confirm dialog is for. Held separately from
  // `confirming` because the preview count alone does not say which way it
  // points, and the dialog wording and the write both depend on it.
  const [sweepStatus, setSweepStatus] = useState<"active" | "inactive">("inactive");
  const [typed, setTyped] = useState("");

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
  // The OSS follow-up view: only people admitted without a card recently.
  const [noCardOnly, setNoCardOnly] = useState(false);

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
    if (noCardOnly) params.set("manual_entry", "true");

    setLoading(true);
    setError(null);
    apiGetList<Person>(`/persons?${params.toString()}`)
      .then(({ items, total }) => {
        setRows(items);
        setTotal(total);
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, [type, section, search, noCardOnly]);

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

  /**
   * The filter the sweep acts on: whatever the directory is currently showing.
   * Shared with exportCsv below rather than rebuilt, so "Deactivate all" can
   * never act on a different set than the one on screen — the failure that
   * would make this control genuinely dangerous.
   */
  const bulkFilter = useCallback(() => {
    const f: Record<string, string> = {};
    if (type !== "all") f.type = type;
    if (section !== "all") f.section = section;
    if (search.trim()) f.search = search.trim();
    return f;
  }, [type, section, search]);

  // The same three filters in words, so the confirm dialog names what it is
  // about to sweep instead of only counting it. An empty list is the dangerous
  // case (no filter = everyone) and the dialog says so explicitly.
  const filterWords = [
    type !== "all" ? `type ${type}` : null,
    section !== "all" ? `section ${section}` : null,
    search.trim() ? `matching "${search.trim()}"` : null,
  ].filter(Boolean);

  async function toggleOne(p: Person) {
    setBusy(true);
    setStatusError(null);
    setResult(null);
    try {
      const status = p.status === "active" ? "inactive" : "active";
      await apiPatch(`/persons/${p._id}/status`, { status });
      fetchRows();
    } catch (err) {
      setStatusError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  /**
   * Fetched on click rather than alongside every directory load, because the
   * count depends on the DIRECTION: reactivation excludes people whose linked
   * login an administrator deactivated, deactivation excludes nobody on that
   * ground. One preview rendered on the button would therefore be right for at
   * most one of the two actions — and wrong silently.
   */
  async function openSweep(status: "active" | "inactive") {
    setBusy(true);
    setStatusError(null);
    setResult(null);
    try {
      const params = new URLSearchParams({ ...bulkFilter(), status });
      const pv = await apiGet<Preview>(`/persons/bulk-status/preview?${params.toString()}`);
      setConfirming(pv);
      setSweepStatus(status);
    } catch (err) {
      setStatusError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function runSweep(status: "active" | "inactive") {
    setBusy(true);
    setStatusError(null);
    try {
      const res = await apiPost<{ matched: number; modified: number; excluded: number }>(
        "/persons/bulk-status",
        { status, filter: bulkFilter() },
      );
      setConfirming(null);
      setTyped("");
      const verb = status === "active" ? "Activated" : "Deactivated";
      setResult(
        `${verb} ${res.modified} of ${res.matched} matching ${
          res.matched === 1 ? "person" : "people"
        }` +
          (res.excluded
            ? `. ${res.excluded} outside your authority ${
                res.excluded === 1 ? "was" : "were"
              } left unchanged.`
            : "."),
      );
      fetchRows();
    } catch (err) {
      setStatusError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function exportCsv() {
    const params = new URLSearchParams();
    if (type !== "all") params.set("type", type);
    if (section !== "all") params.set("section", section);
    if (search.trim()) params.set("search", search.trim());
    if (noCardOnly) params.set("manual_entry", "true");
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

            {/* The OSS follow-up list. A filter rather than a screen of its
                own: whoever is chasing a lost card needs Replace card and the
                profile link, which are already on this row. */}
            <button
              type="button"
              onClick={() => setNoCardOnly((v) => !v)}
              aria-pressed={noCardOnly}
              className={
                noCardOnly
                  ? "rounded-xl border-2 border-red bg-red/45 px-4 py-2 text-[13px] font-600 text-ink transition"
                  : "rounded-xl border border-line bg-white px-4 py-2 text-[13px] font-600 text-ink-soft transition hover:text-navy"
              }
            >
              No-card entries
            </button>

            {/* Acts on the filter above, not on a selection — so what the two
                buttons reach is always exactly what the table is showing.
                That invariant is why both are disabled under the no-card
                filter: bulk-status has no such filter, so a sweep run here
                would silently reach every person the OTHER filters match,
                including everyone whose card works. */}
            <button
              type="button"
              onClick={() => void openSweep("inactive")}
              disabled={busy || noCardOnly}
              className="rounded-xl border-2 border-red bg-red/25 px-4 py-2 text-[13px] font-600 text-ink transition hover:bg-red/45 disabled:opacity-40"
            >
              Deactivate all
            </button>
            <button
              type="button"
              onClick={() => void openSweep("active")}
              disabled={busy || noCardOnly}
              className="rounded-xl border border-line bg-white px-4 py-2 text-[13px] font-600 text-ink-soft transition hover:text-navy disabled:opacity-40"
            >
              Activate all
            </button>
          </div>

          <p className="mt-2 text-[12px] text-ink-soft">
            {noCardOnly ? (
              <>
                Showing only people a guard admitted by typing their ID number in the last
                30 days — they were let through without a card and owe OSS the paperwork.
                Bulk activate and deactivate are off under this filter, because they would
                reach more people than are listed here.
              </>
            ) : (
              <>
                Deactivating refuses a person&rsquo;s card at every gate and blocks any new
                vehicle or gadget registration in their name. Their existing registrations
                are left as they are.
              </>
            )}
          </p>

          {error && (
            <Notice compact className="mt-3 text-[13px] text-ink">
              {error}
            </Notice>
          )}
          {statusError && (
            <Notice compact className="mt-3 text-[13px] text-ink">
              {statusError}
            </Notice>
          )}
          {result && (
            <p className="mt-3 rounded-xl bg-paper px-4 py-2 text-[13px] text-ink-soft">
              {result}
            </p>
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
                      // Red row: admitted without a card recently. Tinted rather
                      // than badged alone so it is visible while scanning the
                      // list for something else entirely, which is the whole
                      // point — nobody thinks to filter for a student whose
                      // card they did not know was missing. The hover tint is
                      // deepened to match, or the row would lose its meaning
                      // under the cursor.
                      className={`cursor-pointer border-b border-line/60 transition ${
                        p.manual_entry_at
                          ? "bg-red/25 hover:bg-red/45"
                          : "hover:bg-paper"
                      }`}
                    >
                      <td className="py-2.5 font-600 text-ink">
                        {p.full_name}
                        {p.manual_entry_at && (
                          <span
                            title={`Last admitted by ID number on ${new Date(
                              p.manual_entry_at
                            ).toLocaleString()}`}
                            className="ml-2 whitespace-nowrap rounded-md border border-red bg-white px-1.5 py-0.5 text-[11px] font-600 uppercase tracking-wide text-ink"
                          >
                            No card
                            {(p.manual_entry_count ?? 0) > 1 && ` ×${p.manual_entry_count}`}
                          </span>
                        )}
                      </td>
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
                          {/* stopPropagation because the whole row is a link
                              into the profile — without it, deactivating
                              someone also navigates away from the list. */}
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              void toggleOne(p);
                            }}
                            disabled={busy}
                            className={
                              p.status === "active"
                                ? "text-ink underline decoration-red decoration-2 underline-offset-2 hover:decoration-[3px] disabled:opacity-40"
                                : "text-blue hover:underline disabled:opacity-40"
                            }
                          >
                            {p.status === "active" ? "Deactivate" : "Activate"}
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

      {confirming && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-navy/40 p-6">
          <div className="w-full max-w-md rounded-2xl border border-line bg-white p-6">
            <h2 className="font-display text-lg font-700 text-navy">
              {sweepStatus === "inactive" ? "Deactivate" : "Activate"} {confirming.matched}{" "}
              {confirming.matched === 1 ? "person" : "people"}?
            </h2>
            <p className="mt-2 text-sm text-ink-soft">
              {filterWords.length
                ? `This affects everyone in the directory with ${filterWords.join(", ")}.`
                : "This affects every student, staff member, and employee in the directory."}
            </p>
            <p className="mt-2 text-sm text-ink-soft">
              {sweepStatus === "inactive"
                ? "Their cards will be refused at every gate, and no new vehicle or gadget can be registered to them. Vehicles and gadgets they already have are not changed."
                : "Their cards will be accepted at the gates again, and they can register vehicles and gadgets."}
              {confirming.excluded
                ? ` ${confirming.excluded} ${
                    confirming.excluded === 1 ? "person is" : "people are"
                  } outside your authority and will be left unchanged.`
                : ""}
            </p>

            {/* Typed confirmation on the closing direction only. Reactivation
                is the recoverable one — a wrong deactivation locks real people
                out of the campus until someone notices. */}
            {sweepStatus === "inactive" && (
              <label className="mt-4 block text-xs font-600 uppercase tracking-[0.12em] text-ink-soft">
                Type {CONFIRM_WORD} to confirm
                <input
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  className="mt-1 block w-full rounded-xl border border-line px-3 py-2 text-sm text-ink"
                  autoFocus
                />
              </label>
            )}

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setConfirming(null);
                  setTyped("");
                }}
                className="rounded-xl border border-line px-4 py-2 text-sm font-600 text-ink-soft"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void runSweep(sweepStatus)}
                disabled={
                  busy ||
                  confirming.matched === 0 ||
                  (sweepStatus === "inactive" && typed !== CONFIRM_WORD)
                }
                className={
                  sweepStatus === "inactive"
                    ? "rounded-xl border-2 border-red bg-red/25 px-4 py-2 text-sm font-600 text-ink disabled:opacity-40"
                    : "rounded-xl bg-navy px-4 py-2 text-sm font-600 text-white disabled:opacity-40"
                }
              >
                {sweepStatus === "inactive" ? "Deactivate" : "Activate"}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
