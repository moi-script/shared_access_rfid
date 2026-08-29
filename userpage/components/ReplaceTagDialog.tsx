"use client";

import { useState } from "react";
import { apiPatch } from "@/lib/auth";
import Notice from "@/components/Notice";

interface ApiErrorLike extends Error {
  code?: string;
}

export type TagKind = "vehicle" | "gadget";

/**
 * Assigns or replaces the RFID sticker on a VEHICLE or a GADGET.
 *
 * The sibling of ReplaceCardDialog, which does the same job for a person's ID
 * card. Kept as a separate component rather than folded into that one: a person
 * always HAS a card, so that dialog can say "Replace" unconditionally, while a
 * device may have no sticker yet (gadgets.schema.ts makes rfid_uid optional) and
 * this one has to read as "Assign" in that case. Two words on screen, but they
 * are the difference between an operator looking for a sticker to peel off and
 * one who knows there is nothing there yet.
 *
 * Both /vehicles/:id/rfid and /gadgets/:id/rfid take the same body and enforce
 * the same three rules server-side — hex format, the three-way UID namespace,
 * and the blocklist — so the only thing that varies here is the path and the
 * noun. Server error messages are shown verbatim: DUPLICATE_RFID names which
 * entity already holds the tag, which is what tells the operator where to look.
 */
export default function ReplaceTagDialog({
  kind,
  id,
  label,
  currentUid,
  onClose,
  onReplaced,
}: {
  kind: TagKind;
  id: string;
  /** What the operator is looking at — a plate number, or a brand and model. */
  label: string;
  currentUid: string | null;
  onClose: () => void;
  onReplaced: (newUid: string) => void;
}) {
  const [newUid, setNewUid] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const noun = kind === "vehicle" ? "vehicle" : "device";
  const assigning = !currentUid;
  const title = assigning ? "Assign RFID tag" : "Replace RFID tag";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const uid = newUid.trim();
    if (!uid) return;
    // Checked here as well as on the server so a mistyped tag costs no round
    // trip — the same regex both create forms already use.
    if (!/^[0-9A-Fa-f]{6,32}$/.test(uid)) {
      setError("RFID must be 6-32 hex characters");
      return;
    }
    setSaving(true);
    try {
      await apiPatch<{ rfid_uid: string }>(`/${kind}s/${id}/rfid`, { rfid_uid: uid });
      onReplaced(uid.toUpperCase());
    } catch (err) {
      setError((err as ApiErrorLike).message);
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
          <h2 className="font-display text-xl font-700 tracking-tight text-ink">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-[14px] font-600 text-ink-soft hover:text-ink"
          >
            Cancel
          </button>
        </div>

        <p className="text-[13px] text-ink-soft">
          For the {noun} <span className="font-600 text-ink">{label}</span>
        </p>

        <div className="rounded-xl border border-line bg-paper px-3 py-2">
          <p className="text-[11px] font-600 uppercase tracking-[0.14em] text-ink-soft">
            Current tag
          </p>
          <p className="mt-0.5 font-mono text-[14px] text-ink">
            {currentUid || "None assigned yet"}
          </p>
        </div>

        <label className="block text-[13px] font-600 text-ink-soft">
          New RFID UID (hex) — scan the sticker now
          <input
            required
            autoFocus
            value={newUid}
            onChange={(e) => setNewUid(e.target.value)}
            placeholder="e.g. A3F19C24"
            className="mt-1 w-full rounded-xl border border-line bg-white px-3 py-2 font-mono text-[14px] text-ink outline-none focus:border-blue focus:ring-4 focus:ring-blue/12"
          />
        </label>

        {/* Shown only when there is actually an old tag to retire. On a first
            assignment nothing gets blocked, and warning about it would describe
            a consequence that does not happen. */}
        {!assigning && (
          <Notice className="text-[13px] font-600 text-ink">
            The current tag will be permanently blocked and can never be used again. This
            cannot be undone.
          </Notice>
        )}

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
          {saving ? "Saving…" : title}
        </button>
      </form>
    </div>
  );
}
