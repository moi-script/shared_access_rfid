"use client";

import { useEffect, useState } from "react";
import { apiDelete, apiGet } from "@/lib/auth";
import Notice from "@/components/Notice";

interface OverviewVehicle {
  status: string;
}

interface AccountRow {
  id: string;
  is_active: boolean;
  person: { id: string } | null;
}

function joinList(items: string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

/**
 * Delete is superadmin-only and irreversible: it cascades to vehicles, the
 * person's login and their card (permanently blocked, not just unassigned).
 * The confirmation names exact counts fetched from the server rather than a
 * generic warning — an operator should never discover the blast radius
 * after confirming. No unblock, no force flag: that is a deliberate ruling,
 * not an oversight, so this dialog does not soften or omit any of it.
 */
export default function DeletePersonDialog({
  personId,
  personName,
  idNumber,
  rfidUid,
  onClose,
  onDeleted,
}: {
  personId: string;
  personName: string;
  idNumber: string;
  rfidUid: string | null;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [loadingImpact, setLoadingImpact] = useState(true);
  const [vehicleCount, setVehicleCount] = useState(0);
  const [hasActiveLogin, setHasActiveLogin] = useState(false);
  const [impactError, setImpactError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    // Dialogs like this one are always freshly mounted per person (the
    // parent conditionally renders it), so the useState(true)/useState(null)
    // initial values below already cover the "just opened" case — setting
    // them again synchronously here would only trip the
    // set-state-in-effect rule for no behavioral benefit.
    let cancelled = false;
    Promise.all([
      apiGet<{ vehicles: OverviewVehicle[] }>(`/persons/${personId}/overview`),
      apiGet<AccountRow[]>(
        `/users?search=${encodeURIComponent(idNumber)}&limit=100`
      ).catch(() => [] as AccountRow[]),
    ])
      .then(([overview, accounts]) => {
        if (cancelled) return;
        const active = overview.vehicles.filter((v) => v.status === "active").length;
        setVehicleCount(active);
        const mine = accounts.find((a) => a.person?.id === personId);
        setHasActiveLogin(Boolean(mine?.is_active));
      })
      .catch((err: Error) => {
        if (!cancelled) setImpactError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoadingImpact(false);
      });
    return () => {
      cancelled = true;
    };
  }, [personId, idNumber]);

  async function confirmDelete() {
    setError(null);
    setDeleting(true);
    try {
      await apiDelete(`/persons/${personId}`);
      onDeleted();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDeleting(false);
    }
  }

  const deactivates: string[] = [];
  if (hasActiveLogin) deactivates.push("their login");
  if (vehicleCount > 0) {
    deactivates.push(`${vehicleCount} vehicle${vehicleCount === 1 ? "" : "s"}`);
  }
  const clauses: string[] = [];
  if (deactivates.length > 0) clauses.push(`deactivates ${joinList(deactivates)}`);
  if (rfidUid) clauses.push("permanently blocks their card");
  const impactSentence =
    clauses.length > 0
      ? `This also ${joinList(clauses)}. This cannot be undone.`
      : "This cannot be undone.";

  return (
    <div className="fixed inset-0 z-40 grid place-items-start overflow-auto bg-ink/40 p-4 sm:p-8">
      <div className="mx-auto w-full max-w-md space-y-3 rounded-2xl border border-line bg-white p-6">
        <div className="flex items-center justify-between">
          <h2 className="font-display text-xl font-700 tracking-tight text-ink">
            Delete person
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
          For <span className="font-600 text-ink">{personName}</span>
        </p>

        {loadingImpact ? (
          <p className="rounded-xl bg-paper px-4 py-3 text-[13px] text-ink-soft">
            Checking what this deletes…
          </p>
        ) : impactError ? (
          <Notice compact className="text-[13px] text-ink">
            Couldn&apos;t confirm the impact: {impactError}
          </Notice>
        ) : (
          <Notice className="text-[13px] font-600 text-ink">{impactSentence}</Notice>
        )}

        {error && (
          <Notice compact className="text-[13px] text-ink">
            {error}
          </Notice>
        )}

        <button
          type="button"
          onClick={confirmDelete}
          disabled={deleting || loadingImpact || Boolean(impactError)}
          className="w-full rounded-xl border-2 border-red bg-red/25 px-4 py-2.5 text-sm font-600 text-ink hover:bg-red/45 disabled:opacity-60"
        >
          {deleting ? "Deleting…" : "Delete person"}
        </button>
      </div>
    </div>
  );
}
