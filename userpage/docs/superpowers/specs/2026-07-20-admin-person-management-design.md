# Admin Person Management — Design Spec

**Date:** 2026-07-20
**Scope:** NCST RFID system — admin console (`userpage`) + persons module (`serverside`)
**Status:** Approved for planning

## Goal

Give the admin full control over person records from the console: create individuals,
bulk-import from CSV, export the current view to CSV, and print an official
registration form for each person. A registration form opens automatically after
every single-create, so each new student is "showcased" immediately for printing/filing.

All features are **admin-only** and reuse the existing auth, API response envelope,
and UI patterns. No new services or ports.

## Context (what already exists)

- **Backend persons module** (`serverside/src/modules/persons/`) with admin-only routes:
  - `GET /persons` (list/search/paginate), `GET /persons/sections`,
    `GET /persons/:id`, `GET /persons/:id/overview`
  - `POST /persons` (create), `PATCH /persons/:id` (update),
    `PATCH /persons/:id/status`, `PATCH /persons/:id/rfid` (reassign card)
  - Person fields: `full_name`, `type` (`student|staff|employee`), `id_number`,
    `department_section`, `contact_email`, `photo_url`, `rfid_uid`, `status`.
- **Frontend admin console** (`userpage/app/admin/page.tsx`) with Overview /
  Directory / Parking views, plus `StudentsDirectory` (read-only list) and
  `PersonProfile` components.
- **API helpers** in `userpage/lib/auth.ts`: `apiGet`, `apiGetList` (envelope:
  `{ success, data, meta }`). No POST/PATCH/file helpers yet.

**Gaps this spec fills:** no create form, no CSV import, no export, no print view.

## Backend schema change (prerequisite)

To allow persons to exist **before a physical card is assigned** (import "assign
later" + create-without-UID), one small, backward-compatible change:

- `persons.model.ts`:
  - `rfid_uid`: `required: true, unique` → **optional**, `unique: true, sparse: true`
    (sparse index so multiple card-less persons don't collide on `null`).
  - `status` enum: `['active', 'inactive']` → `['active', 'inactive', 'pending']`.
- `persons.schema.ts` (`createPersonSchema`): `rfid_uid` becomes `.optional()`
  (keeps the hex regex when present).

Existing persons with a card behave exactly as before. A card-less person simply
never matches a scan. **Semantics:** a person with no `rfid_uid` is `pending`;
assigning a card (via the existing `PATCH /persons/:id/rfid`) flips them to `active`.

## Feature 1 — Create person (single)

**UI:** an "Add person" button in the Directory view opens a form (modal or slide-in
panel following existing card styling). Fields: full name, type, ID number,
department/section, email, photo URL, **optional RFID UID** with hint
"Scan a card now, or leave blank to assign later."

**Flow:**
1. Submit → `POST /persons` (existing endpoint; now accepts optional `rfid_uid`).
2. Client-side + server-side validation. Surface field errors from the envelope
   (`code`/`message`), e.g. duplicate `id_number` or `rfid_uid`.
3. **On success → the Registration Form (Feature 4) opens automatically** for the
   newly created person, ready to print. Directory list refreshes.

**API helper:** add `apiPost<T>(path, body)` to `lib/auth.ts` (mirrors `apiGet`,
attaches token, parses the envelope, throws `ApiError` with `code`/`status`).

## Feature 2 — CSV import (bulk)

**UI:** an "Import CSV" button opens an import panel:
1. "Download template" link → a CSV with the canonical header row.
2. File picker → parse client-side into rows.
3. **Preview table** with per-row status: valid (green) or invalid (red + reason:
   missing required field, bad type, duplicate ID in file, malformed UID).
4. "Import N valid rows" button → sends valid rows to the backend.
5. Result summary: created count + skipped rows with reasons (e.g.
   "duplicate id_number", "rfid_uid already in use").

**CSV columns (canonical, shared with export):**
`full_name, type, id_number, department_section, contact_email, photo_url, rfid_uid`
- `full_name`, `type`, `id_number` required.
- `rfid_uid` optional: present → person `active`; blank → person `pending`.

**Backend endpoint:** `POST /persons/import`
- Admin-only (same middleware chain as other person routes).
- Body: `{ rows: CreatePersonInput[] }` validated with
  `z.object({ rows: z.array(createPersonSchema).min(1).max(500) })`.
- Service inserts rows **individually with per-row try/catch** (not a single
  `insertMany`) so one bad row doesn't abort the batch. Returns
  `{ created: number, skipped: { row: number, reason: string }[] }`.
- Duplicate `id_number` and `rfid_uid` become skip reasons, not 500s.

**Parsing:** client-side CSV parse. Prefer a tiny hand-rolled parser or an existing
dependency; do **not** add a heavy library. (Confirm available deps during planning.)

## Feature 3 — Export CSV (respects filters)

**UI:** an "Export CSV" button in the Directory triggers a download of the
**currently filtered** list (same `type` / `section` / `search` the admin sees).

**Backend endpoint:** `GET /persons/export`
- Admin-only. Accepts the **same query params** as `GET /persons`
  (`type`, `section`, `search`) — no pagination (exports the full matching set).
- Responds with `Content-Type: text/csv` and
  `Content-Disposition: attachment; filename="persons-<date>.csv"`.
- Column order **identical to the import template**, so export → edit → re-import
  round-trips. Blank `rfid_uid` for pending persons.

**Client:** fetch with the auth token, read blob, trigger download. Add an
`apiGetBlob(path)` helper (or inline fetch) since the response is not the JSON envelope.

## Feature 4 — Registration form (printable)

A print-optimized A4 view of one person's full record:
- Header with `NcstMark` + "Registration Record" title.
- All fields: full name, type, ID number, department/section, email, photo (if
  `photo_url`), RFID UID (or "Not yet assigned"), status, created date.
- Signature/date lines at the bottom for filing.

**Implementation:**
- A `RegistrationForm` component rendered in a dedicated print context.
- Browser-native print via a "Print" button (`window.print()`) with a
  `@media print` stylesheet that hides console chrome and shows only the form.
  No PDF library.
- **Entry points:**
  1. Auto-opened after a successful single-create (Feature 1).
  2. A "Print form" button on the existing `PersonProfile` view.

## Components & files (anticipated)

**Frontend (`userpage`):**
- `lib/auth.ts` — add `apiPost`, `apiGetBlob` helpers.
- `components/PersonForm.tsx` — create form (Feature 1).
- `components/ImportPersons.tsx` — CSV import panel + preview (Feature 2).
- `components/RegistrationForm.tsx` — printable record (Feature 4).
- `components/StudentsDirectory.tsx` — add Add / Import / Export buttons + export handler.
- `components/PersonProfile.tsx` — add "Print form" button.
- `app/globals.css` (or scoped) — `@media print` rules.

**Backend (`serverside`):**
- `modules/persons/persons.model.ts` — schema change.
- `modules/persons/persons.schema.ts` — optional `rfid_uid`; add `importSchema`.
- `modules/persons/persons.routes.ts` — add `POST /import`, `GET /export`.
- `modules/persons/persons.controller.ts` — `import`, `export` handlers.
- `modules/persons/persons.service.ts` — per-row insert; filtered export query.
- `modules/persons/persons.repository.ts` — export query (reuse list filters).

## Error handling

- **Create/import:** duplicate `id_number` / `rfid_uid` reported as field/row
  errors, never 500. Validation via existing `validate` middleware + Zod.
- **Import:** per-row isolation; partial success always returns a summary.
- **Export:** empty result still returns a valid CSV (header only).
- **Print:** guarded when `photo_url` missing; "Not yet assigned" for blank UID.

## Testing

- **Backend:** unit/integration for `POST /persons` with optional UID (active vs
  pending), `POST /persons/import` (all-valid, mixed, duplicates), and
  `GET /persons/export` (filter honored, CSV shape matches template header).
- **Round-trip:** export a filtered set, re-import it, assert idempotent skips on
  duplicates.
- **Frontend:** manual verification of create→auto-print, import preview
  validation states, export download, and print layout.

## Out of scope (YAGNI)

- ID-card printing / barcode / QR generation.
- PDF generation libraries.
- Editing persons via CSV re-import (import is create-only; duplicates skipped).
- Bulk card assignment UI beyond the existing per-person reassign flow.
