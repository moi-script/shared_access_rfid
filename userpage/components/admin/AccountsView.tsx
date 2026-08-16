"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiGet, apiPatch, apiPost, getStoredUser, type Role } from "@/lib/auth";
import { personTypesFor, rankOf, rolesBelow } from "@/lib/permissions";
import Notice from "@/components/Notice";
import SectionHeading from "@/components/SectionHeading";
import { TfiPlus } from "react-icons/tfi";

interface AccountRow {
  id: string;
  username: string;
  role: Role;
  is_active: boolean;
  deactivated_at: string | null;
  person: {
    id: string;
    full_name: string;
    type: string;
    department_section: string;
    rfid_uid: string | null;
    status: string;
  } | null;
}

const CONFIRM_WORD = "DEACTIVATE";

export default function AccountsView() {
  const [rows, setRows] = useState<AccountRow[]>([]);
  const [type, setType] = useState("");
  const [section, setSection] = useState("");
  const [search, setSearch] = useState("");
  const [preview, setPreview] = useState<{ matched: number; excluded: number } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const gen = useRef(0);
  const me = getStoredUser();
  const selfId = me?.id ?? null;
  // Fails closed: if somehow no stored user is found, "student" has no write
  // domain and outranks nobody, so every row renders protected rather than
  // silently permissive.
  const myRole = (me?.role ?? "student") as Role;
  const allowedTypes = personTypesFor(myRole);
  const creatableRoles = rolesBelow(myRole);

  const [newUsername, setNewUsername] = useState("");
  const [newRole, setNewRole] = useState<Role | "">("");
  const [newPassword, setNewPassword] = useState("");
  const [newPersonId, setNewPersonId] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const query = useCallback(() => {
    const p = new URLSearchParams();
    if (type) p.set("type", type);
    if (section) p.set("department_section", section);
    if (search) p.set("search", search);
    return p;
  }, [type, section, search]);

  const load = useCallback(async () => {
    const mine = ++gen.current;
    setError(null);
    try {
      const p = query();
      p.set("limit", "100");
      const list = await apiGet<AccountRow[]>(`/users?${p.toString()}`);
      const pv = await apiGet<{ matched: number; excluded: number }>(
        `/users/bulk-status/preview?${query().toString()}`,
      );
      if (mine !== gen.current) return; // a newer load started; discard this result
      setRows(list);
      setPreview(pv);
    } catch (err) {
      if (mine !== gen.current) return;
      setError((err as Error).message);
    }
  }, [query]);

  useEffect(() => {
    // Debounce so typing in the filters doesn't fire a request per keystroke.
    const t = setTimeout(() => void load(), 250);
    return () => {
      clearTimeout(t);
      // `gen` is a plain counter ref, not a DOM node, so there is no stale-node
      // hazard here: bumping it on every cleanup is exactly what invalidates
      // in-flight responses after unmount/filter change — the point of this line.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      gen.current++;
    };
  }, [load]);

  async function createAccount(e: React.FormEvent) {
    e.preventDefault();
    setCreateError(null);
    setCreating(true);
    try {
      await apiPost("/users", {
        username: newUsername.trim(),
        password: newPassword,
        role: newRole,
        ...(newPersonId.trim() ? { person_id: newPersonId.trim() } : {}),
      });
      setNewUsername("");
      setNewRole("");
      setNewPassword("");
      setNewPersonId("");
    } catch (err) {
      setCreateError((err as Error).message);
    } finally {
      setCreating(false);
      // Refresh regardless of outcome, not only inside the try block — a
      // failed create can still mean the on-screen list is stale (e.g. a
      // duplicate-username rejection because someone else just created that
      // account), the same reasoning PresenceView's clear() was fixed for.
      await load();
    }
  }

  async function toggleOne(row: AccountRow) {
    setBusy(true);
    try {
      await apiPatch(`/users/${row.id}/status`, { active: !row.is_active });
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function runBulk(active: boolean) {
    setBusy(true);
    try {
      await apiPost("/users/bulk-status", {
        active,
        filter: {
          ...(type ? { type } : {}),
          ...(section ? { department_section: section } : {}),
          ...(search ? { search } : {}),
        },
      });
      setConfirming(false);
      setTyped("");
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const filterWords = [
    type ? `type ${type}` : null,
    section ? `section ${section}` : null,
    search ? `matching "${search}"` : null,
  ].filter(Boolean);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="font-display text-xl font-700 text-navy">Accounts</h1>
        <p className="text-sm text-ink-soft">
          Deactivating an account blocks both the web portal and the person&apos;s RFID
          card at every gate.
        </p>
      </div>

      {error && (
        <Notice className="text-sm text-ink">{error}</Notice>
      )}

      <form
        onSubmit={createAccount}
        className="space-y-3 rounded-2xl border border-line bg-white p-5"
      >
        <SectionHeading icon={TfiPlus}>Create account</SectionHeading>

        {createError && (
          <Notice className="text-sm text-ink">{createError}</Notice>
        )}

        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs font-600 uppercase tracking-[0.12em] text-ink-soft">
            Username
            <input
              required
              value={newUsername}
              onChange={(e) => setNewUsername(e.target.value)}
              disabled={creating}
              className="mt-1 block rounded-xl border border-line bg-white px-3 py-2 text-sm text-ink disabled:opacity-50"
            />
          </label>

          <label className="text-xs font-600 uppercase tracking-[0.12em] text-ink-soft">
            Role
            <select
              required
              value={newRole}
              onChange={(e) => setNewRole(e.target.value as Role)}
              disabled={creating}
              className="mt-1 block rounded-xl border border-line bg-white px-3 py-2 text-sm text-ink capitalize disabled:opacity-50"
            >
              <option value="" disabled>
                Select role
              </option>
              {creatableRoles.map((r) => (
                <option key={r} value={r} className="capitalize">
                  {r[0].toUpperCase() + r.slice(1)}
                </option>
              ))}
            </select>
          </label>

          <label className="text-xs font-600 uppercase tracking-[0.12em] text-ink-soft">
            Temporary password
            <input
              required
              type="text"
              minLength={8}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              disabled={creating}
              placeholder="Min. 8 characters"
              className="mt-1 block rounded-xl border border-line bg-white px-3 py-2 text-sm text-ink disabled:opacity-50"
            />
          </label>

          <label className="flex-1 text-xs font-600 uppercase tracking-[0.12em] text-ink-soft">
            Person ID (optional)
            <input
              value={newPersonId}
              onChange={(e) => setNewPersonId(e.target.value)}
              disabled={creating}
              placeholder="Link this login to an existing person record"
              className="mt-1 block w-full rounded-xl border border-line bg-white px-3 py-2 text-sm text-ink disabled:opacity-50"
            />
          </label>

          <button
            type="submit"
            disabled={creating || !newUsername.trim() || !newRole || newPassword.length < 8}
            className="rounded-xl bg-navy px-4 py-2 text-sm font-600 text-white transition hover:bg-navy/90 disabled:opacity-40"
          >
            {creating ? "Creating…" : "Create account"}
          </button>
        </div>
      </form>

      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs font-600 uppercase tracking-[0.12em] text-ink-soft">
          Type
          <select
            value={type}
            onChange={(e) => setType(e.target.value)}
            disabled={confirming}
            className="mt-1 block rounded-xl border border-line bg-white px-3 py-2 text-sm text-ink disabled:opacity-50"
          >
            <option value="">All</option>
            <option value="student">Student</option>
            <option value="staff">Staff</option>
            <option value="employee">Employee</option>
          </select>
        </label>

        <label className="text-xs font-600 uppercase tracking-[0.12em] text-ink-soft">
          Section
          <input
            value={section}
            onChange={(e) => setSection(e.target.value)}
            placeholder="e.g. BSIT - 4A"
            disabled={confirming}
            className="mt-1 block rounded-xl border border-line bg-white px-3 py-2 text-sm text-ink disabled:opacity-50"
          />
        </label>

        <label className="flex-1 text-xs font-600 uppercase tracking-[0.12em] text-ink-soft">
          Search
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Name, ID number or RFID"
            disabled={confirming}
            className="mt-1 block w-full rounded-xl border border-line bg-white px-3 py-2 text-sm text-ink disabled:opacity-50"
          />
        </label>

        <button
          onClick={() => setConfirming(true)}
          disabled={busy || !preview || preview.matched === 0}
          className="rounded-xl border-2 border-red bg-red/25 px-4 py-2 text-sm font-600 text-ink transition hover:bg-red/45 disabled:opacity-40"
        >
          Deactivate all ({preview?.matched ?? 0})
        </button>
        <button
          onClick={() => void runBulk(true)}
          disabled={busy || !preview || preview.matched === 0}
          className="rounded-xl border border-line bg-white px-4 py-2 text-sm font-600 text-ink-soft transition hover:text-navy disabled:opacity-40"
        >
          Activate all
        </button>
      </div>

      {rows.length >= 100 && (
        <p className="text-xs text-ink-soft">
          Showing first 100{preview ? ` of ${preview.matched + preview.excluded}` : ""} matching
          accounts. Narrow the filters to see the rest.
        </p>
      )}

      <div className="overflow-x-auto rounded-2xl border border-line bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs uppercase tracking-[0.12em] text-ink-soft">
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Username</th>
              <th className="px-4 py-3">Role</th>
              <th className="px-4 py-3">Section</th>
              <th className="px-4 py-3">RFID</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              // Mirrors the server: rank, self, AND domain. Without the domain
              // half, HR sees an enabled toggle on every student row that the
              // server then rejects with a 403 — an interface inviting an
              // action it cannot perform. An office account (person === null)
              // has no type, so this clause doesn't apply to it; rank/self
              // already cover those rows.
              const protectedRow =
                rankOf(r.role) >= rankOf(myRole) ||
                r.id === selfId ||
                (r.person?.type !== undefined &&
                  !(allowedTypes as string[]).includes(r.person.type));
              return (
              <tr key={r.id} className="border-b border-line/60 last:border-0">
                <td className="px-4 py-3 font-500 text-ink">
                  {r.person?.full_name ?? "—"}
                </td>
                <td className="px-4 py-3 text-ink-soft">{r.username}</td>
                <td className="px-4 py-3 text-ink-soft">
                  {r.role}
                  {protectedRow && (
                    <span className="ml-2 rounded-full bg-navy/5 px-2 py-0.5 text-[10px] font-600 uppercase tracking-[0.08em] text-ink-soft">
                      Protected
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 text-ink-soft">
                  {r.person?.department_section ?? "—"}
                </td>
                <td className="px-4 py-3 font-mono text-xs text-ink-soft">
                  {r.person?.rfid_uid ?? "—"}
                </td>
                <td className="px-4 py-3">
                  <span
                    className={
                      r.is_active
                        ? "rounded-full border border-blue bg-blue/25 px-2 py-1 text-xs font-600 text-ink"
                        : "rounded-full border border-red bg-red/25 px-2 py-1 text-xs font-600 text-ink"
                    }
                  >
                    {r.is_active ? "Active" : "Inactive"}
                  </span>
                </td>
                <td className="px-4 py-3 text-right">
                  <button
                    onClick={() => void toggleOne(r)}
                    disabled={busy || protectedRow}
                    title={
                      protectedRow
                        ? "Protected: equal/higher rank, your own account, or outside your write domain"
                        : undefined
                    }
                    className="rounded-lg border border-line px-3 py-1.5 text-xs font-600 text-ink-soft transition hover:text-navy disabled:opacity-40"
                  >
                    {r.is_active ? "Deactivate" : "Activate"}
                  </button>
                </td>
              </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-ink-soft">
                  No accounts match this filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {confirming && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-navy/40 p-6">
          <div className="w-full max-w-md rounded-2xl border border-line bg-white p-6">
            <h2 className="font-display text-lg font-700 text-navy">
              Deactivate {preview?.matched ?? 0} account
              {preview?.matched === 1 ? "" : "s"}?
            </h2>
            <p className="mt-2 text-sm text-ink-soft">
              {filterWords.length
                ? `This affects accounts with ${filterWords.join(", ")}.`
                : "This affects every student, staff, and employee account."}{" "}
              They will not be able to sign in, and their RFID cards will be refused at
              every gate.
            </p>
            <p className="mt-2 text-sm text-ink-soft">
              Office accounts (superadmin, registrar, HR, OSS) are never affected
              {preview?.excluded ? ` (${preview.excluded} excluded)` : ""}.
            </p>

            <label className="mt-4 block text-xs font-600 uppercase tracking-[0.12em] text-ink-soft">
              Type {CONFIRM_WORD} to confirm
              <input
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                className="mt-1 block w-full rounded-xl border border-line px-3 py-2 text-sm text-ink"
                autoFocus
              />
            </label>

            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => {
                  setConfirming(false);
                  setTyped("");
                }}
                className="rounded-xl border border-line px-4 py-2 text-sm font-600 text-ink-soft"
              >
                Cancel
              </button>
              <button
                onClick={() => void runBulk(false)}
                disabled={typed !== CONFIRM_WORD || busy}
                className="rounded-xl border-2 border-red bg-red/25 px-4 py-2 text-sm font-600 text-ink disabled:opacity-40"
              >
                Deactivate
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
