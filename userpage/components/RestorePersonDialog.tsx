"use client";

import { useState } from "react";
import { apiPost } from "@/lib/auth";
import Notice from "@/components/Notice";

interface RestoredPerson {
  _id: string;
  full_name: string;
  status: string;
  rfid_uid?: string | null;
}

/**
 * Restore is a record-only undo: it clears deleted_at and puts the person
 * back at 'inactive', but it does not unblock the old card, reactivate their
 * vehicles, or reactivate their login (persons.service.ts restore()). Saying
 * anything less than that here would let an operator restore someone, watch
 * them get refused at the barrier, and conclude the restore failed.
 */
export default function RestorePersonDialog({
  personId,
  personName,
  onClose,
  onRestored,
}: {
  personId: string;
  personName: string;
  onClose: () => void;
  onRestored: (person: RestoredPerson) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);

  async function confirmRestore() {
    setError(null);
    setRestoring(true);
    try {
      const person = await apiPost<RestoredPerson>(`/persons/${personId}/restore`, {});
      onRestored(person);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRestoring(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40 grid place-items-start overflow-auto bg-ink/40 p-4 sm:p-8">
      <div className="mx-auto w-full max-w-md space-y-3 rounded-2xl border border-line bg-white p-6">
        <div className="flex items-center justify-between">
          <h2 className="font-display text-xl font-700 tracking-tight text-ink">
            Restore person
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

        <Notice tone="warn" className="text-[13px] font-600 text-ink">
          This brings back the record only, as inactive. Their old card stays
          permanently blocked — they come back with no working card and need a
          new one issued before they can tap in. Their vehicles and login stay
          deactivated too; reactivate those separately if needed.
        </Notice>

        {error && (
          <Notice compact className="text-[13px] text-ink">
            {error}
          </Notice>
        )}

        <button
          type="button"
          onClick={confirmRestore}
          disabled={restoring}
          className="w-full rounded-xl bg-navy px-4 py-2.5 text-sm font-600 text-white hover:bg-navy/90 disabled:opacity-60"
        >
          {restoring ? "Restoring…" : "Restore person"}
        </button>
      </div>
    </div>
  );
}
