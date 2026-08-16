"use client";

import { useState } from "react";
import { apiPatch } from "@/lib/auth";
import Notice from "@/components/Notice";

interface ApiErrorLike extends Error {
  code?: string;
}

export default function ReplaceCardDialog({
  personId,
  personName,
  currentUid,
  onClose,
  onReplaced,
}: {
  personId: string;
  personName: string;
  currentUid: string | null;
  onClose: () => void;
  onReplaced: (newUid: string) => void;
}) {
  const [newUid, setNewUid] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const uid = newUid.trim();
    if (!uid) return;
    setSaving(true);
    try {
      await apiPatch<{ rfid_uid: string }>(`/persons/${personId}/rfid`, { rfid_uid: uid });
      onReplaced(uid);
    } catch (err) {
      // DUPLICATE_RFID and CARD_BLOCKED mean different things to an
      // operator — one card is in use elsewhere, the other is dead and can
      // never be reused by anyone. Show the server's message verbatim
      // rather than collapsing both into one generic failure.
      const apiErr = err as ApiErrorLike;
      setError(apiErr.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40 grid place-items-start overflow-auto bg-ink/40 p-4 sm:p-8">
      <form
        onSubmit={submit}
        className="mx-auto w-full max-w-md space-y-3 rounded-2xl border border-line bg-white p-6"
      >
        <div className="flex items-center justify-between">
          <h2 className="font-display text-xl font-700 tracking-tight text-ink">
            Replace card
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

        <div className="rounded-xl border border-line bg-paper px-3 py-2">
          <p className="text-[11px] font-600 uppercase tracking-[0.14em] text-ink-soft">
            Current card
          </p>
          <p className="mt-0.5 font-mono text-[14px] text-ink">{currentUid || "—"}</p>
        </div>

        <label className="block text-[13px] font-600 text-ink-soft">
          New RFID UID (hex) — scan the new card now
          <input
            required
            autoFocus
            value={newUid}
            onChange={(e) => setNewUid(e.target.value)}
            placeholder="e.g. A3F19C24"
            className="mt-1 w-full rounded-xl border border-line bg-white px-3 py-2 font-mono text-[14px] text-ink outline-none focus:border-blue focus:ring-4 focus:ring-blue/12"
          />
        </label>

        <Notice className="text-[13px] font-600 text-ink">
          The current card will be permanently blocked and can never be used again. This
          cannot be undone.
        </Notice>

        {error && (
          <Notice compact className="text-[13px] text-ink">
            {error}
          </Notice>
        )}

        <button
          type="submit"
          disabled={saving || !newUid.trim()}
          className="w-full rounded-xl bg-navy px-4 py-2.5 text-sm font-600 text-white hover:bg-navy/90 disabled:opacity-60"
        >
          {saving ? "Replacing…" : "Replace card"}
        </button>
      </form>
    </div>
  );
}
