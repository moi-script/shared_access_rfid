# Admin Person Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the admin create persons one at a time (auto-printing a registration form), bulk-import from CSV, export the filtered directory to CSV, and print a per-person registration record — all admin-only, reusing existing patterns.

**Architecture:** Backend adds two routes (`POST /persons/import`, `GET /persons/export`) to the existing persons module and relaxes the `rfid_uid` requirement so card-less ("pending") persons are allowed. Frontend adds a create form, CSV import panel, export button, and a print-styled registration form to the existing admin console, wired through new `apiPost`/`apiGetBlob` helpers.

**Tech Stack:** Backend — Express 4, Mongoose 8, Zod 3, TypeScript. Frontend — Next.js 16, React 19, Tailwind v4, TypeScript.

## Global Constraints

- **No test framework exists** in either project (no jest/vitest, no `test` script). Do NOT add one. Verify every backend task with `npm run build` (tsc typecheck) + `npm run lint` in `serverside/`, plus a `curl` call against the already-running API at `http://localhost:3000/api`. Verify every frontend task with `npm run lint` + `npm run build` in `userpage/`.
- **Do not start any dev server or change any port.** Client and server are already running (`serverside` on `:3000`, `userpage` on `:5173`).
- **Admin token for curl:** open the running admin app in the browser, sign in as admin, then in DevTools run `localStorage.getItem('ncst_access_token')`. Export it in the shell as `TOKEN` for the curl steps below.
- **API response envelope:** success = `{ success: true, data, meta? }`, failure = `{ success: false, code, message }`. Use `sendSuccess(res, data, status?, meta?)` and `throw new ApiError(code, message?)`.
- **Two git repos:** `serverside/` is its own git repo; `userpage/` is its own git repo. Commit backend tasks in `serverside/`, frontend tasks in `userpage/`. Each commit message ends with:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- **CSV column order (canonical, shared by import + export):**
  `full_name,type,id_number,department_section,contact_email,photo_url,rfid_uid`
- **No new dependencies.** CSV parsing is hand-rolled on the client; CSV generation is hand-rolled on the server.

---

### Task 1: Allow card-less ("pending") persons — backend schema change

**Files:**
- Modify: `serverside/src/modules/persons/persons.model.ts`
- Modify: `serverside/src/modules/persons/persons.schema.ts`
- Modify: `serverside/src/modules/persons/persons.service.ts:41-45` (`create`)

**Interfaces:**
- Produces: `createPersonSchema` with optional `rfid_uid`; `IPerson.rfid_uid?: string`; `IPerson.status: 'active' | 'inactive' | 'pending'`. Later tasks (import, export, frontend) rely on `rfid_uid` being optional and `pending` being a valid status.

- [ ] **Step 1: Relax the model**

In `persons.model.ts`, change the interface and schema so a person can exist without a card:

```typescript
export interface IPerson extends Document {
  _id: Types.ObjectId;
  full_name: string;
  type: 'student' | 'staff' | 'employee';
  id_number: string;
  department_section: string;
  contact_email?: string;
  photo_url?: string;
  rfid_uid?: string;
  status: 'active' | 'inactive' | 'pending';
  createdAt: Date;
  updatedAt: Date;
}
```

And in the schema definition change these two fields:

```typescript
    rfid_uid: { type: String, unique: true, sparse: true },
    status: {
      type: String,
      enum: ['active', 'inactive', 'pending'],
      default: 'active',
      index: true,
    },
```

- [ ] **Step 2: Make the create schema accept an optional UID**

In `persons.schema.ts`, change the `rfid_uid` line inside `createPersonSchema` to optional (keep the hex check when present):

```typescript
  rfid_uid: z
    .string()
    .regex(/^[0-9A-Fa-f]+$/, 'rfid_uid must be hex')
    .optional(),
```

Leave `updatePersonSchema`, `statusSchema`, and `reassignRfidSchema` unchanged.

- [ ] **Step 3: Guard the duplicate-UID check + default status in the service**

In `persons.service.ts`, replace the `create` method (lines 41-45) with:

```typescript
  async create(data: Partial<IPerson>) {
    if (data.rfid_uid) {
      const existing = await personRepo.findByRfid(data.rfid_uid);
      if (existing) throw new ApiError('DUPLICATE_RFID');
    } else {
      data.status = data.status ?? 'pending';
    }
    return personRepo.create(data);
  },
```

- [ ] **Step 4: Typecheck and lint**

Run in `serverside/`: `npm run build && npm run lint`
Expected: no TypeScript errors, no lint errors.

- [ ] **Step 5: Verify card-less create works, card-ful still works**

With `TOKEN` set (see Global Constraints), run:

```bash
# Card-less -> should return status "pending"
curl -s -X POST http://localhost:3000/api/persons \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"full_name":"Pending Test","type":"student","id_number":"PENDING-001"}'

# With a card -> should return status "active"
curl -s -X POST http://localhost:3000/api/persons \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"full_name":"Card Test","type":"student","id_number":"CARD-001","rfid_uid":"AABBCCDD"}'
```

Expected: first response `data.status` is `"pending"` and has no `rfid_uid`; second is `"active"` with `rfid_uid":"AABBCCDD"`. Both `success:true`.

- [ ] **Step 6: Commit**

```bash
cd serverside
git add src/modules/persons/persons.model.ts src/modules/persons/persons.schema.ts src/modules/persons/persons.service.ts
git commit -m "feat(persons): allow card-less pending persons"
```

---

### Task 2: Bulk import endpoint — `POST /persons/import`

**Files:**
- Modify: `serverside/src/modules/persons/persons.schema.ts`
- Modify: `serverside/src/modules/persons/persons.service.ts`
- Modify: `serverside/src/modules/persons/persons.controller.ts`
- Modify: `serverside/src/modules/persons/persons.routes.ts`

**Interfaces:**
- Consumes: `createPersonSchema` (Task 1).
- Produces: `POST /persons/import` accepting `{ rows: CreatePersonInput[] }`, returning `data: { created: number; skipped: { row: number; reason: string }[] }`. The frontend import panel (Task 7) relies on this exact response shape (`row` is the 1-based index within the submitted `rows` array).

- [ ] **Step 1: Add the import schema**

Append to `persons.schema.ts`:

```typescript
export const importPersonsSchema = z.object({
  rows: z.array(createPersonSchema).min(1).max(500),
});
```

- [ ] **Step 2: Add the import service method**

In `persons.service.ts`, add this method to the `personService` object (after `create`). It inserts rows one at a time so one bad row never aborts the batch:

```typescript
  async import(rows: Partial<IPerson>[]) {
    const skipped: { row: number; reason: string }[] = [];
    let created = 0;
    for (let i = 0; i < rows.length; i++) {
      try {
        await this.create(rows[i]);
        created++;
      } catch (err) {
        const reason =
          err instanceof ApiError && err.code === 'DUPLICATE_RFID'
            ? 'rfid_uid already registered'
            : (err as { code?: number }).code === 11000
              ? 'duplicate key (id_number or rfid_uid)'
              : (err as Error).message;
        skipped.push({ row: i + 1, reason });
      }
    }
    return { created, skipped };
  },
```

- [ ] **Step 3: Add the controller handler**

In `persons.controller.ts`, add to the `personController` object (after `create`):

```typescript
  import: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await personService.import(req.body.rows), 201);
  }),
```

- [ ] **Step 4: Register the route**

In `persons.routes.ts`, import `importPersonsSchema` in the existing schema import block, then add this line (place it before the `/:id` routes so it is not shadowed):

```typescript
personRoutes.post('/import', validate(importPersonsSchema), personController.import);
```

- [ ] **Step 5: Typecheck and lint**

Run in `serverside/`: `npm run build && npm run lint`
Expected: clean.

- [ ] **Step 6: Verify mixed import (one good, one duplicate)**

```bash
curl -s -X POST http://localhost:3000/api/persons/import \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"rows":[
    {"full_name":"Import One","type":"student","id_number":"IMP-001"},
    {"full_name":"Import Dup","type":"student","id_number":"IMP-002","rfid_uid":"AABBCCDD"}
  ]}'
```

Expected: `data.created` is `1`, `data.skipped` contains one entry with `row: 2` and a reason mentioning rfid_uid (UID `AABBCCDD` was used in Task 1).

- [ ] **Step 7: Commit**

```bash
cd serverside
git add src/modules/persons/persons.schema.ts src/modules/persons/persons.service.ts src/modules/persons/persons.controller.ts src/modules/persons/persons.routes.ts
git commit -m "feat(persons): add bulk CSV import endpoint"
```

---

### Task 3: Filtered CSV export endpoint — `GET /persons/export`

**Files:**
- Modify: `serverside/src/modules/persons/persons.repository.ts`
- Modify: `serverside/src/modules/persons/persons.service.ts`
- Modify: `serverside/src/modules/persons/persons.controller.ts`
- Modify: `serverside/src/modules/persons/persons.routes.ts`

**Interfaces:**
- Consumes: existing list filter logic (`type`, `section`, `search`).
- Produces: `GET /persons/export?type=&section=&search=` responding with `text/csv` (not the JSON envelope). Column order matches the Global Constraints canonical order. The frontend export button (Task 8) downloads this directly.

- [ ] **Step 1: Add an unpaginated finder to the repository**

In `persons.repository.ts`, add to the `personRepo` object:

```typescript
  findAll: (filter: FilterQuery<IPerson>) =>
    PersonModel.find(filter).sort({ createdAt: -1 }).lean(),
```

- [ ] **Step 2: Add the export service method (builds filter + CSV string)**

In `persons.service.ts`, add to the `personService` object. Reuse the same filter shape as `list`:

```typescript
  async exportCsv(query: ListQuery): Promise<string> {
    const filter: FilterQuery<IPerson> = {};
    if (query.type) filter.type = query.type;
    if (query.status) filter.status = query.status;
    if (query.section) filter.department_section = query.section;
    if (query.search) {
      const rx = { $regex: query.search, $options: 'i' };
      filter.$or = [{ full_name: rx }, { id_number: rx }];
    }
    const rows = await personRepo.findAll(filter);
    const header =
      'full_name,type,id_number,department_section,contact_email,photo_url,rfid_uid';
    const esc = (v: unknown) => {
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = rows.map((r) =>
      [
        r.full_name,
        r.type,
        r.id_number,
        r.department_section,
        r.contact_email,
        r.photo_url,
        r.rfid_uid,
      ]
        .map(esc)
        .join(',')
    );
    return [header, ...lines].join('\n');
  },
```

- [ ] **Step 3: Add the controller handler (CSV headers, not sendSuccess)**

In `persons.controller.ts`, add to the `personController` object:

```typescript
  export: asyncHandler(async (req: Request, res: Response) => {
    const csv = await personService.exportCsv(req.query);
    const date = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="persons-${date}.csv"`);
    res.status(200).send(csv);
  }),
```

- [ ] **Step 4: Register the route**

In `persons.routes.ts`, add before the `/:id` routes:

```typescript
personRoutes.get('/export', personController.export);
```

- [ ] **Step 5: Typecheck and lint**

Run in `serverside/`: `npm run build && npm run lint`
Expected: clean.

- [ ] **Step 6: Verify export returns CSV with the header**

```bash
curl -s "http://localhost:3000/api/persons/export?type=student" \
  -H "Authorization: Bearer $TOKEN"
```

Expected: first line is exactly `full_name,type,id_number,department_section,contact_email,photo_url,rfid_uid`, followed by one line per student (including the `IMP-001` / `PENDING-001` rows created earlier, with an empty trailing `rfid_uid` field).

- [ ] **Step 7: Commit**

```bash
cd serverside
git add src/modules/persons/persons.repository.ts src/modules/persons/persons.service.ts src/modules/persons/persons.controller.ts src/modules/persons/persons.routes.ts
git commit -m "feat(persons): add filtered CSV export endpoint"
```

---

### Task 4: Frontend API helpers — `apiPost` + `apiGetBlob`

**Files:**
- Modify: `userpage/lib/auth.ts`

**Interfaces:**
- Produces:
  - `apiPost<T>(path: string, body: unknown): Promise<T>` — attaches token, sends JSON, parses the success envelope, throws `ApiError` (with `.code`, `.status`) on failure. Used by the create form (Task 6) and import panel (Task 7).
  - `apiGetBlob(path: string): Promise<Blob>` — attaches token, returns the raw response body as a Blob (for CSV download). Used by the export button (Task 8).

- [ ] **Step 1: Add both helpers**

Append to `userpage/lib/auth.ts` (the `ApiError` interface already exists in this file above `apiGet`):

```typescript
/** POST JSON to a protected endpoint, returning the parsed data envelope. */
export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const token = getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    credentials: "include",
    body: JSON.stringify(body),
  });
  const parsed = (await res.json().catch(() => null)) as
    | { success: true; data: T }
    | { success: false; code?: string; message?: string }
    | null;

  if (!res.ok || !parsed || parsed.success !== true) {
    const failure = parsed as { code?: string; message?: string } | null;
    const err: ApiError = new Error(failure?.message ?? "Request failed");
    err.code = failure?.code;
    err.status = res.status;
    throw err;
  }
  return parsed.data;
}

/** GET a non-JSON endpoint (e.g. CSV) as a Blob, attaching the access token. */
export async function apiGetBlob(path: string): Promise<Blob> {
  const token = getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    credentials: "include",
  });
  if (!res.ok) {
    const err: ApiError = new Error("Download failed");
    err.status = res.status;
    throw err;
  }
  return res.blob();
}
```

- [ ] **Step 2: Lint and typecheck**

Run in `userpage/`: `npm run lint && npm run build`
Expected: compiles, no lint errors.

- [ ] **Step 3: Commit**

```bash
cd userpage
git add lib/auth.ts
git commit -m "feat(auth): add apiPost and apiGetBlob helpers"
```

---

### Task 5: Registration form component + print styles

**Files:**
- Create: `userpage/components/RegistrationForm.tsx`
- Modify: `userpage/app/globals.css`

**Interfaces:**
- Produces:
  - `PersonRecord` type (exported): `{ full_name: string; type: string; id_number: string; department_section?: string | null; contact_email?: string | null; photo_url?: string | null; rfid_uid?: string | null; status: string; createdAt?: string; }`
  - `RegistrationForm({ person, onClose }: { person: PersonRecord; onClose: () => void })` — a full-screen overlay showing the printable record with "Print" (`window.print()`) and "Close" buttons. Used by Task 6 (auto-open after create) and Task 9 (print from profile).
- The print CSS class `print-area` marks the only element that shows when printing.

- [ ] **Step 1: Create the component**

```tsx
"use client";

import NcstMark from "@/components/NcstMark";

export interface PersonRecord {
  full_name: string;
  type: string;
  id_number: string;
  department_section?: string | null;
  contact_email?: string | null;
  photo_url?: string | null;
  rfid_uid?: string | null;
  status: string;
  createdAt?: string;
}

function Field({ label, value }: { label: string; value?: string | null }) {
  return (
    <div className="border-b border-line py-2">
      <p className="text-[11px] font-600 uppercase tracking-[0.14em] text-ink-soft">
        {label}
      </p>
      <p className="mt-0.5 text-[15px] text-ink">{value || "—"}</p>
    </div>
  );
}

export default function RegistrationForm({
  person,
  onClose,
}: {
  person: PersonRecord;
  onClose: () => void;
}) {
  const created = person.createdAt
    ? new Date(person.createdAt).toLocaleDateString()
    : new Date().toLocaleDateString();

  return (
    <div className="fixed inset-0 z-50 overflow-auto bg-ink/40 p-4 sm:p-8">
      <div className="mx-auto max-w-2xl">
        {/* Toolbar — hidden when printing */}
        <div className="mb-3 flex justify-end gap-2 print:hidden">
          <button
            onClick={onClose}
            className="rounded-xl border border-line bg-white px-4 py-2 text-sm font-600 text-ink-soft hover:text-ink"
          >
            Close
          </button>
          <button
            onClick={() => window.print()}
            className="rounded-xl bg-navy px-4 py-2 text-sm font-600 text-white hover:bg-navy/90"
          >
            Print
          </button>
        </div>

        {/* Printable record */}
        <div className="print-area rounded-2xl border border-line bg-white p-8">
          <div className="flex items-center gap-3 border-b-2 border-navy pb-4">
            <NcstMark className="h-12 w-12" />
            <div>
              <p className="font-display text-lg font-700 tracking-tight text-ink">
                NCST RFID System
              </p>
              <p className="text-[12px] font-600 uppercase tracking-[0.18em] text-gold">
                Registration Record
              </p>
            </div>
          </div>

          <div className="mt-6 flex gap-6">
            <div className="grid h-24 w-24 shrink-0 place-items-center overflow-hidden rounded-xl border border-line bg-paper text-ink-soft">
              {person.photo_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={person.photo_url}
                  alt={person.full_name}
                  className="h-full w-full object-cover"
                />
              ) : (
                <span className="text-[11px]">No photo</span>
              )}
            </div>
            <div className="min-w-0 flex-1">
              <Field label="Full name" value={person.full_name} />
              <Field label="Type" value={person.type} />
              <Field label="ID number" value={person.id_number} />
            </div>
          </div>

          <div className="mt-4 grid gap-x-8 sm:grid-cols-2">
            <Field label="Course / Section" value={person.department_section} />
            <Field label="Email" value={person.contact_email} />
            <Field
              label="RFID UID"
              value={person.rfid_uid || "Not yet assigned"}
            />
            <Field label="Status" value={person.status} />
            <Field label="Date registered" value={created} />
          </div>

          <div className="mt-10 grid grid-cols-2 gap-8">
            <div className="border-t border-ink pt-1 text-[12px] text-ink-soft">
              Registrant signature
            </div>
            <div className="border-t border-ink pt-1 text-[12px] text-ink-soft">
              Admin signature / date
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add print CSS**

Append to `userpage/app/globals.css`:

```css
@media print {
  body * {
    visibility: hidden;
  }
  .print-area,
  .print-area * {
    visibility: visible;
  }
  .print-area {
    position: absolute;
    inset: 0;
    margin: 0;
    border: 0;
  }
}
```

- [ ] **Step 3: Lint and typecheck**

Run in `userpage/`: `npm run lint && npm run build`
Expected: clean (the `no-img-element` rule is disabled inline for the photo).

- [ ] **Step 4: Commit**

```bash
cd userpage
git add components/RegistrationForm.tsx app/globals.css
git commit -m "feat(admin): add printable registration form"
```

---

### Task 6: Create-person form + auto-open registration form

**Files:**
- Create: `userpage/components/PersonForm.tsx`
- Modify: `userpage/components/StudentsDirectory.tsx`

**Interfaces:**
- Consumes: `apiPost` (Task 4), `RegistrationForm` + `PersonRecord` (Task 5).
- Produces: `PersonForm({ onCreated, onClose }: { onCreated: (person: PersonRecord) => void; onClose: () => void })`. On successful `POST /persons` it calls `onCreated` with the created person (the API returns the full record including `_id`, `status`, `createdAt`).

- [ ] **Step 1: Create the form component**

```tsx
"use client";

import { useState } from "react";
import { apiPost } from "@/lib/auth";
import type { PersonRecord } from "@/components/RegistrationForm";

const inputCls =
  "w-full rounded-xl border border-line bg-white px-3 py-2 text-[14px] text-ink outline-none focus:border-blue focus:ring-4 focus:ring-blue/12";

export default function PersonForm({
  onCreated,
  onClose,
}: {
  onCreated: (person: PersonRecord) => void;
  onClose: () => void;
}) {
  const [form, setForm] = useState({
    full_name: "",
    type: "student",
    id_number: "",
    department_section: "",
    contact_email: "",
    photo_url: "",
    rfid_uid: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function set(k: keyof typeof form, v: string) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    // Only send optional fields when non-empty (backend rejects empty rfid_uid/email).
    const payload: Record<string, string> = {
      full_name: form.full_name.trim(),
      type: form.type,
      id_number: form.id_number.trim(),
    };
    for (const k of ["department_section", "contact_email", "photo_url", "rfid_uid"] as const) {
      const v = form[k].trim();
      if (v) payload[k] = v;
    }
    try {
      const created = await apiPost<PersonRecord>("/persons", payload);
      onCreated(created);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40 grid place-items-start overflow-auto bg-ink/40 p-4 sm:p-8">
      <form
        onSubmit={submit}
        className="mx-auto w-full max-w-lg space-y-3 rounded-2xl border border-line bg-white p-6"
      >
        <div className="flex items-center justify-between">
          <h2 className="font-display text-xl font-700 tracking-tight text-ink">
            Add person
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-[14px] font-600 text-ink-soft hover:text-ink"
          >
            Cancel
          </button>
        </div>

        {error && (
          <p className="rounded-xl bg-red/10 px-4 py-2 text-[13px] text-red">{error}</p>
        )}

        <label className="block text-[13px] font-600 text-ink-soft">
          Full name
          <input
            required
            value={form.full_name}
            onChange={(e) => set("full_name", e.target.value)}
            className={`mt-1 ${inputCls}`}
          />
        </label>

        <div className="grid grid-cols-2 gap-3">
          <label className="block text-[13px] font-600 text-ink-soft">
            Type
            <select
              value={form.type}
              onChange={(e) => set("type", e.target.value)}
              className={`mt-1 ${inputCls}`}
            >
              <option value="student">Student</option>
              <option value="staff">Staff</option>
              <option value="employee">Employee</option>
            </select>
          </label>
          <label className="block text-[13px] font-600 text-ink-soft">
            ID number
            <input
              required
              value={form.id_number}
              onChange={(e) => set("id_number", e.target.value)}
              className={`mt-1 ${inputCls}`}
            />
          </label>
        </div>

        <label className="block text-[13px] font-600 text-ink-soft">
          Course / Section
          <input
            value={form.department_section}
            onChange={(e) => set("department_section", e.target.value)}
            className={`mt-1 ${inputCls}`}
          />
        </label>

        <label className="block text-[13px] font-600 text-ink-soft">
          Email
          <input
            type="email"
            value={form.contact_email}
            onChange={(e) => set("contact_email", e.target.value)}
            className={`mt-1 ${inputCls}`}
          />
        </label>

        <label className="block text-[13px] font-600 text-ink-soft">
          Photo URL
          <input
            value={form.photo_url}
            onChange={(e) => set("photo_url", e.target.value)}
            className={`mt-1 ${inputCls}`}
          />
        </label>

        <label className="block text-[13px] font-600 text-ink-soft">
          RFID UID (hex) — scan a card now, or leave blank to assign later
          <input
            value={form.rfid_uid}
            onChange={(e) => set("rfid_uid", e.target.value)}
            placeholder="e.g. A3F19C24"
            className={`mt-1 font-mono ${inputCls}`}
          />
        </label>

        <button
          type="submit"
          disabled={saving}
          className="w-full rounded-xl bg-navy px-4 py-2.5 text-sm font-600 text-white hover:bg-navy/90 disabled:opacity-60"
        >
          {saving ? "Saving…" : "Create & print form"}
        </button>
      </form>
    </div>
  );
}
```

- [ ] **Step 2: Wire the form into the directory with an "Add person" button**

In `StudentsDirectory.tsx`, add these imports at the top:

```tsx
import PersonForm from "@/components/PersonForm";
import RegistrationForm, { type PersonRecord } from "@/components/RegistrationForm";
```

Inside the component, add state near the other `useState` hooks:

```tsx
  const [showForm, setShowForm] = useState(false);
  const [printPerson, setPrintPerson] = useState<PersonRecord | null>(null);
```

Replace the header row (the `<div className="flex flex-wrap items-center justify-between gap-2">` block containing the "Directory" heading and count) with a version that adds an Add button:

```tsx
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[13px] font-600 uppercase tracking-[0.16em] text-ink-soft">
          Directory
        </h2>
        <div className="flex items-center gap-3">
          <span className="text-[12px] text-ink-soft">
            {loading ? "Loading…" : `${total} ${total === 1 ? "person" : "people"}`}
          </span>
          <button
            onClick={() => setShowForm(true)}
            className="rounded-xl bg-navy px-3 py-1.5 text-[13px] font-600 text-white hover:bg-navy/90"
          >
            + Add person
          </button>
        </div>
      </div>
```

Then, just before the closing `</section>` of the component, render the modals:

```tsx
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
```

- [ ] **Step 3: Lint and typecheck**

Run in `userpage/`: `npm run lint && npm run build`
Expected: clean.

- [ ] **Step 4: Manual verification**

In the running admin app: Directory → "+ Add person" → fill name/ID (leave UID blank) → "Create & print form". Expected: form closes, the registration record opens automatically showing "Not yet assigned" for RFID and status "pending", the browser Print dialog is reachable via the Print button, and the new person appears in the directory after closing.

- [ ] **Step 5: Commit**

```bash
cd userpage
git add components/PersonForm.tsx components/StudentsDirectory.tsx
git commit -m "feat(admin): add create-person form with auto-print"
```

---

### Task 7: CSV import panel

**Files:**
- Create: `userpage/components/ImportPersons.tsx`
- Create: `userpage/lib/csv.ts`
- Modify: `userpage/components/StudentsDirectory.tsx`

**Interfaces:**
- Consumes: `apiPost` (Task 4), the `POST /persons/import` response shape `{ created, skipped: { row, reason }[] }` (Task 2).
- Produces:
  - `parseCsv(text: string): Record<string, string>[]` in `lib/csv.ts` — parses a CSV string (with quoted-field support) into row objects keyed by the header line.
  - `ImportPersons({ onDone, onClose }: { onDone: () => void; onClose: () => void })` — panel with template download, file picker, validation preview, and submit.

- [ ] **Step 1: Create the CSV parser**

`userpage/lib/csv.ts`:

```typescript
// Minimal CSV parser: handles quoted fields, escaped quotes (""), and CRLF.
// Returns one object per data row, keyed by the header row's column names.
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      field = "";
      row = [];
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  const nonEmpty = rows.filter((r) => r.some((c) => c.trim() !== ""));
  if (nonEmpty.length === 0) return [];
  const header = nonEmpty[0].map((h) => h.trim());
  return nonEmpty.slice(1).map((r) => {
    const obj: Record<string, string> = {};
    header.forEach((h, idx) => {
      obj[h] = (r[idx] ?? "").trim();
    });
    return obj;
  });
}
```

- [ ] **Step 2: Create the import panel**

`userpage/components/ImportPersons.tsx`:

```tsx
"use client";

import { useState } from "react";
import { apiPost } from "@/lib/auth";
import { parseCsv } from "@/lib/csv";

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
  if (r.rfid_uid && !/^[0-9A-Fa-f]+$/.test(r.rfid_uid)) return "rfid_uid must be hex";
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
    setErrors(parsed.map(rowError));
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
          <p className="rounded-xl bg-red/10 px-4 py-2 text-[13px] text-red">{error}</p>
        )}
        {result && (
          <p className="rounded-xl bg-emerald-50 px-4 py-2 text-[13px] text-emerald-700">
            {result}
          </p>
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
                          <span className="text-red">{errors[i]}</span>
                        ) : (
                          <span className="text-emerald-700">ok</span>
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
```

- [ ] **Step 3: Wire the import panel into the directory**

In `StudentsDirectory.tsx`, add the import:

```tsx
import ImportPersons from "@/components/ImportPersons";
```

Add state alongside `showForm`:

```tsx
  const [showImport, setShowImport] = useState(false);
```

Add an "Import CSV" button in the header's button group, right before the "+ Add person" button:

```tsx
          <button
            onClick={() => setShowImport(true)}
            className="rounded-xl border border-line bg-white px-3 py-1.5 text-[13px] font-600 text-ink-soft hover:text-ink"
          >
            Import CSV
          </button>
```

Render the panel next to the other modals (before `</section>`):

```tsx
      {showImport && (
        <ImportPersons
          onClose={() => setShowImport(false)}
          onDone={fetchRows}
        />
      )}
```

- [ ] **Step 4: Lint and typecheck**

Run in `userpage/`: `npm run lint && npm run build`
Expected: clean.

- [ ] **Step 5: Manual verification**

Directory → "Import CSV" → "Download template" → open it, keep the two sample rows, save → choose the file. Expected: preview shows 2 rows both "ok"; clicking Import reports "Created N" (or a skip reason if `2024-0001`/`A3F19C24` already exist from a prior run), and the directory refreshes.

- [ ] **Step 6: Commit**

```bash
cd userpage
git add components/ImportPersons.tsx lib/csv.ts components/StudentsDirectory.tsx
git commit -m "feat(admin): add CSV import panel"
```

---

### Task 8: Export CSV button

**Files:**
- Modify: `userpage/components/StudentsDirectory.tsx`

**Interfaces:**
- Consumes: `apiGetBlob` (Task 4), `GET /persons/export` (Task 3). Reuses the component's existing `type`, `section`, `search` state so the export matches the current filter.

- [ ] **Step 1: Add the import and export handler**

In `StudentsDirectory.tsx`, add to the auth import (it currently imports `apiGet, apiGetList`):

```tsx
import { apiGet, apiGetList, apiGetBlob } from "@/lib/auth";
```

Add this handler inside the component (near `fetchRows`):

```tsx
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
```

- [ ] **Step 2: Add the Export button**

In the header button group, add before the "Import CSV" button:

```tsx
          <button
            onClick={exportCsv}
            className="rounded-xl border border-line bg-white px-3 py-1.5 text-[13px] font-600 text-ink-soft hover:text-ink"
          >
            Export CSV
          </button>
```

- [ ] **Step 3: Lint and typecheck**

Run in `userpage/`: `npm run lint && npm run build`
Expected: clean.

- [ ] **Step 4: Manual verification**

Directory → filter to `Students` → "Export CSV". Expected: a `persons-<date>.csv` downloads; its first line is the canonical header and it contains only the currently-filtered rows. Re-importing that file via Task 7's panel round-trips (existing rows skipped as duplicates).

- [ ] **Step 5: Commit**

```bash
cd userpage
git add components/StudentsDirectory.tsx
git commit -m "feat(admin): add filtered CSV export button"
```

---

### Task 9: Print registration form from a person's profile

**Files:**
- Modify: `userpage/components/PersonProfile.tsx`

**Interfaces:**
- Consumes: `RegistrationForm` + `PersonRecord` (Task 5). Maps the loaded `PersonOverview.person` into a `PersonRecord` (note: overview lacks `photo_url`/`createdAt`, which the form renders as "No photo" / today's date — acceptable).

- [ ] **Step 1: Add a Print button that opens the form**

Replace the entire contents of `PersonProfile.tsx` with:

```tsx
"use client";

import { useEffect, useState } from "react";
import { apiGet } from "@/lib/auth";
import ProfileView, { InfoBanner, type PersonOverview } from "@/components/ProfileView";
import RegistrationForm, { type PersonRecord } from "@/components/RegistrationForm";

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

  useEffect(() => {
    setLoading(true);
    setError(null);
    apiGet<PersonOverview>(`/persons/${personId}/overview`)
      .then(setData)
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, [personId]);

  const record: PersonRecord | null = data?.person
    ? {
        full_name: data.person.full_name,
        type: data.person.type,
        id_number: data.person.id_number,
        department_section: data.person.department_section,
        contact_email: data.person.contact_email,
        rfid_uid: data.person.rfid_uid,
        status: data.person.status,
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
          <button
            onClick={() => setShowForm(true)}
            className="rounded-xl border border-line bg-white px-3 py-1.5 text-[13px] font-600 text-ink-soft hover:text-ink"
          >
            Print form
          </button>
        )}
      </div>

      {loading && <p className="text-ink-soft">Loading {name ?? "profile"}…</p>}
      {error && <InfoBanner>Couldn&apos;t load profile: {error}</InfoBanner>}
      {data && <ProfileView data={data} />}

      {showForm && record && (
        <RegistrationForm person={record} onClose={() => setShowForm(false)} />
      )}
    </div>
  );
}
```

- [ ] **Step 2: Lint and typecheck**

Run in `userpage/`: `npm run lint && npm run build`
Expected: clean.

- [ ] **Step 3: Manual verification**

Directory → click any person → "Print form". Expected: the registration record opens for that person with their real name/ID/status/UID, and Print works.

- [ ] **Step 4: Commit**

```bash
cd userpage
git add components/PersonProfile.tsx
git commit -m "feat(admin): print registration form from profile"
```

---

## Self-Review

**Spec coverage:**
- Backend schema change (optional rfid_uid + pending) → Task 1. ✓
- Feature 1 create + auto-open form → Tasks 4, 5, 6. ✓
- Feature 2 CSV import (UID optional → active/pending; per-row isolation; template; preview) → Tasks 2, 7. ✓
- Feature 3 filtered export (round-trips) → Tasks 3, 8. ✓
- Feature 4 printable registration form (auto after create + from profile) → Tasks 5, 6, 9. ✓
- `apiPost`/`apiGetBlob` helpers → Task 4. ✓

**Placeholder scan:** No TBD/TODO; every code step contains full code; verification uses concrete commands with expected output. The intentional lint-disable comment for the profile photo `<img>` is deliberate, not a placeholder.

**Type consistency:** `PersonRecord` defined in Task 5 and consumed unchanged in Tasks 6 & 9. Import response `{ created, skipped: { row, reason }[] }` defined in Task 2 and consumed identically in Task 7. `apiPost`/`apiGetBlob` signatures from Task 4 match their call sites. `parseCsv` signature from Task 7 matches its use.

**Deviation from default TDD:** No automated tests, because neither repo has a test framework and the spec's testing section is satisfiable via the running server. Verification is build + lint + curl/manual per task. This is a deliberate, flagged choice — not an omission.
