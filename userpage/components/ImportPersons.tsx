"use client";

import { useState } from "react";
import { apiPost } from "@/lib/auth";
import { parseCsv } from "@/lib/csv";
import Notice from "@/components/Notice";

const TEMPLATE =
  "full_name,type,id_number,department_section,contact_email,photo_url,rfid_uid\n" +
  "Juan Dela Cruz,student,2024-0001,BSIT 3A,juan@example.com,,A3F19C24\n" +
  "Maria Santos,student,2024-0002,BSIT 3A,,,\n";

interface Parsed {
  full_name: string;
  type: string;
  id_number: string;
  department_section?: string;
  contact_email?: string;
  photo_url?: string;
  rfid_uid?: string;
}

const VALID_TYPES = ["student", "staff", "employee"];

// Validate one parsed row; return an error string or null if valid.
function rowError(r: Record<string, string>): string | null {
  if (!r.full_name) return "missing full_name";
  if (!VALID_TYPES.includes(r.type)) return `invalid type "${r.type}"`;
  if (!r.id_number) return "missing id_number";
  if (r.rfid_uid && !/^[0-9A-Fa-f]{6,32}$/.test(r.rfid_uid)) return "rfid_uid must be 6-32 hex characters";
  return null;
}

function toPayload(r: Record<string, string>): Parsed {
  const p: Parsed = {
    full_name: r.full_name,
    type: r.type,
    id_number: r.id_number,
  };
  for (const k of ["department_section", "contact_email", "photo_url", "rfid_uid"] as const) {
    if (r[k]) p[k] = r[k];
  }
  return p;
}

export default function ImportPersons({
  onDone,
  onClose,
}: {
  onDone: () => void;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<Record<string, string>[]>([]);
  const [errors, setErrors] = useState<(string | null)[]>([]);
  const [result, setResult] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function downloadTemplate() {
    const url = URL.createObjectURL(new Blob([TEMPLATE], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "persons-template.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setResult(null);
    setError(null);
    const text = await file.text();
    const parsed = parseCsv(text);
    setRows(parsed);
    const seen = new Set<string>();
    setErrors(
      parsed.map((r) => {
        const base = rowError(r);
        if (base) return base;
        if (r.id_number && seen.has(r.id_number)) return "duplicate id_number in file";
        if (r.id_number) seen.add(r.id_number);
        return null;
      })
    );
  }

  const validRows = rows.filter((_, i) => errors[i] === null);

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const data = await apiPost<{ created: number; skipped: { row: number; reason: string }[] }>(
        "/persons/import",
        { rows: validRows.map(toPayload) }
      );
      const skippedMsg =
        data.skipped.length > 0
          ? ` Skipped ${data.skipped.length}: ` +
            data.skipped.map((s) => `row ${s.row} (${s.reason})`).join("; ")
          : "";
      setResult(`Created ${data.created}.${skippedMsg}`);
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40 grid place-items-start overflow-auto bg-ink/40 p-4 sm:p-8">
      <div className="mx-auto w-full max-w-2xl space-y-4 rounded-2xl border border-line bg-white p-6">
        <div className="flex items-center justify-between">
          <h2 className="font-display text-xl font-700 tracking-tight text-ink">
            Import from CSV
          </h2>
          <button
            onClick={onClose}
            className="text-[14px] font-600 text-ink-soft hover:text-ink"
          >
            Close
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={downloadTemplate}
            className="rounded-xl border border-line bg-white px-3 py-1.5 text-[13px] font-600 text-blue hover:bg-paper"
          >
            Download template
          </button>
          <input type="file" accept=".csv,text/csv" onChange={onFile} className="text-[13px]" />
        </div>

        {error && (
          <Notice compact className="text-[13px] text-ink">
            {error}
          </Notice>
        )}
        {result && (
          <Notice tone="info" compact className="text-[13px] text-ink">
            {result}
          </Notice>
        )}

        {rows.length > 0 && (
          <>
            <p className="text-[13px] text-ink-soft">
              {validRows.length} valid / {rows.length} rows
            </p>
            <div className="max-h-72 overflow-auto rounded-xl border border-line">
              <table className="w-full text-left text-[13px]">
                <thead className="sticky top-0 bg-paper">
                  <tr className="text-[11px] uppercase tracking-wide text-ink-soft">
                    <th className="px-3 py-2 font-600">#</th>
                    <th className="px-3 py-2 font-600">Name</th>
                    <th className="px-3 py-2 font-600">Type</th>
                    <th className="px-3 py-2 font-600">ID</th>
                    <th className="px-3 py-2 font-600">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i} className="border-t border-line/60">
                      <td className="px-3 py-1.5 text-ink-soft">{i + 1}</td>
                      <td className="px-3 py-1.5 text-ink">{r.full_name || "—"}</td>
                      <td className="px-3 py-1.5 text-ink-soft">{r.type || "—"}</td>
                      <td className="px-3 py-1.5 font-mono text-ink-soft">{r.id_number || "—"}</td>
                      <td className="px-3 py-1.5">
                        {errors[i] ? (
                          <span className="rounded border border-red bg-red/25 px-1.5 py-0.5 text-ink">{errors[i]}</span>
                        ) : (
                          <span className="text-blue">ok</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <button
              onClick={submit}
              disabled={submitting || validRows.length === 0}
              className="w-full rounded-xl bg-navy px-4 py-2.5 text-sm font-600 text-white hover:bg-navy/90 disabled:opacity-60"
            >
              {submitting ? "Importing…" : `Import ${validRows.length} valid rows`}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
