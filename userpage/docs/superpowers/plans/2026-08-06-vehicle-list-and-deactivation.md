# Vehicles List and Deactivation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give OSS and superadmin a Vehicles tab that lists registered vehicles with their owners and lets them deactivate or reactivate one, replacing today's curl/mongosh-only workflow.

**Architecture:** Two repos, changed in order. The server gains an owner join and a search filter on the existing `GET /vehicles` (no new routes — `PATCH /vehicles/:id/status` already exists and already enforces the allowance rules). The browser gains one new view component wired into the existing role-based nav. Verification is a black-box harness extension, not unit tests, because that is the only test style this codebase has.

**Tech Stack:** Express 5 + Mongoose 8 (`serverside`), Next.js 16.2.10 App Router + React + Tailwind (`userpage`), TypeScript throughout.

## Global Constraints

- **Two separate git repos.** `C:\thesis_rfid\serverside` and `C:\thesis_rfid\userpage` are independent deployables with their own `.git`. They cannot import from each other. Commit to each separately; never stage across them.
- **Current branch is `feat/single-card-access`** in `userpage`, which has ~20 unrelated modified files already in the working tree. Stage only the files each task names. Never `git add -A` or `git add .`.
- **`userpage/AGENTS.md`:** "This is NOT the Next.js you know … Read the relevant guide in `node_modules/next/dist/docs/` before writing any code." Next.js here is **16.2.10**. The relevant guide for this work is `node_modules/next/dist/docs/01-app/03-api-reference/01-directives/use-client.md` — the `"use client"` directive goes at the top of the file, before any imports.
- **The server is the authority on wording.** Error text shown to the user comes from `err.message` on the API response. Do not compose parallel copies of server-side messages in the browser.
- **`vehicle_type` values** are exactly `motorcycle`, `multicab`, `van`, `pickup`, `auv`, `truck` — read from `userpage/lib/vehicleTypes.ts` on the client and `serverside/src/constants/vehicleTypes.ts` on the server. Never hardcode the list.
- **Tailwind tokens in this project** are `ink`, `ink-soft`, `paper`, `line`, `navy`, `blue`, `red`, `gold`. Font weights are numeric utilities (`font-600`, `font-700`). Do not introduce new colors.
- **Both verification harnesses need a running server:** `npm run dev` in `serverside`, and `npm run seed:test` applied once.

---

## File Structure

**`serverside`**
| File | Responsibility |
| --- | --- |
| `src/utils/escapeRegex.ts` | **Create.** Escape user input before it enters a `$regex`. |
| `src/modules/vehicles/vehicles.repository.ts` | **Modify.** `findPaginated` joins the owner. |
| `src/modules/vehicles/vehicles.service.ts` | **Modify.** `list()` accepts `search`. |
| `src/config/verifyVehicles.ts` | **Modify.** Add the list/search/deactivation checks. |

**`userpage`**
| File | Responsibility |
| --- | --- |
| `components/admin/VehiclesView.tsx` | **Create.** The whole view: filters, table, toggle. |
| `lib/permissions.ts` | **Modify.** New `vehicles` view, icon, nav entries. |
| `components/admin/AdminShell.tsx` | **Modify.** Render the view for its tab. |

---

## Task 1: `escapeRegex` helper

**Files:**
- Create: `serverside/src/utils/escapeRegex.ts`
- Test: `serverside/src/config/verifyVehicles.ts` (exercised end-to-end in Task 3)

**Interfaces:**
- Consumes: nothing
- Produces: `escapeRegex(input: string): string` — returns the input with every regex metacharacter backslash-escaped, safe to embed in a `$regex` value.

- [ ] **Step 1: Create the helper**

Create `serverside/src/utils/escapeRegex.ts`:

```ts
/**
 * Escapes every regex metacharacter so a user-supplied string matches
 * literally inside a Mongo `$regex`.
 *
 * Plate numbers are the reason this exists: `CAV (8832` reaches the driver as
 * an unterminated group and throws, where a name rarely would. personService's
 * search (persons.service.ts) still interpolates raw input and has the same
 * latent bug — fixing it there touches the directory, the deleted-persons view
 * and CSV export at once, so it is deliberately left for its own change.
 */
export function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
```

- [ ] **Step 2: Verify it compiles and behaves**

Run from `serverside`:

```bash
npx ts-node -e "import {escapeRegex} from './src/utils/escapeRegex'; console.log(escapeRegex('CAV (8832')); console.log(new RegExp(escapeRegex('CAV (8832')).test('CAV (8832'));"
```

Expected output:

```
CAV \(8832
true
```

If the second line is `false` or the command throws, the escape is wrong — do not continue.

- [ ] **Step 3: Commit**

```bash
cd C:/thesis_rfid/serverside
git add src/utils/escapeRegex.ts
git commit -m "feat: add escapeRegex helper for user input in \$regex"
```

---

## Task 2: Server — owner join and search on `GET /vehicles`

**Files:**
- Modify: `serverside/src/modules/vehicles/vehicles.repository.ts:7-13`
- Modify: `serverside/src/modules/vehicles/vehicles.service.ts:12-17` and `:61-68`

**Interfaces:**
- Consumes: `escapeRegex` from Task 1.
- Produces: `GET /vehicles` accepts `search`, and each returned item's `owner_person_id` is now an object `{ _id, full_name, id_number, type }` instead of a bare id string. Task 4 renders this shape; Task 3 asserts it.

- [ ] **Step 1: Add the populate**

In `serverside/src/modules/vehicles/vehicles.repository.ts`, replace the `find` inside `findPaginated` (currently line 9):

```ts
      VehicleModel.find(filter)
        // The list view shows who owns each vehicle; without this the browser
        // gets a bare ObjectId and would need a second round trip per page.
        // findActiveByOwner deliberately does NOT get this join — it feeds the
        // gate terminal, which needs the narrow projection it already has.
        .populate('owner_person_id', 'full_name id_number type')
        .sort({ createdAt: -1 })
        .skip(p.skip)
        .limit(p.limit)
        .lean(),
```

Leave `countDocuments`, `findById`, `findByRfid`, `findByPlate`, `updateById`, and `findActiveByOwner` untouched.

- [ ] **Step 2: Add `search` to the query interface**

In `serverside/src/modules/vehicles/vehicles.service.ts`, extend `ListQuery` (currently lines 12-17):

```ts
interface ListQuery {
  page?: string;
  limit?: string;
  status?: string;
  vehicle_type?: string;
  search?: string;
}
```

- [ ] **Step 3: Add the search filter**

Add the import at the top of the same file, alongside the existing utils imports:

```ts
import { escapeRegex } from '../../utils/escapeRegex';
```

Then in `list()`, after the existing `vehicle_type` line and before `findPaginated` is called:

```ts
    if (query.search) {
      // Plate and sticker UID only. Owner name is not searchable here: it would
      // need a $lookup pipeline, and the directory already answers "what does
      // this person drive" from the person's side. These two are what a clerk
      // standing next to the vehicle actually has in hand.
      const rx = { $regex: escapeRegex(query.search), $options: 'i' };
      filter.$or = [{ plate_number: rx }, { rfid_uid: rx }];
    }
```

- [ ] **Step 4: Verify the server still starts and the endpoint responds**

With `npm run dev` running in `serverside`:

```bash
TOKEN=$(curl -s -X POST http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"StrongAdminPass@2025!"}' \
  | python -c "import json,sys; print(json.load(sys.stdin)['data']['accessToken'])")

curl -s "http://localhost:3000/api/vehicles?limit=2" -H "Authorization: Bearer $TOKEN" \
  | python -m json.tool | head -30
```

Expected: each item's `owner_person_id` is an **object containing `full_name`**, not a string. If it is still a bare string, the populate did not take effect — check for a typo in the field name before continuing.

Then confirm search works and that metacharacters do not throw:

```bash
curl -s "http://localhost:3000/api/vehicles?search=CAV" -H "Authorization: Bearer $TOKEN" | python -m json.tool | head -20
curl -s "http://localhost:3000/api/vehicles?search=CAV%20(88" -H "Authorization: Bearer $TOKEN" | python -m json.tool | head -5
```

Expected: the first returns CAV 8832. The second returns `"success": true` with an empty or matching `data` array — **not** a 500.

- [ ] **Step 5: Commit**

```bash
cd C:/thesis_rfid/serverside
git add src/modules/vehicles/vehicles.repository.ts src/modules/vehicles/vehicles.service.ts
git commit -m "feat: populate owner and add search to GET /vehicles"
```

---

## Task 3: Server — extend the verification harness

**Files:**
- Modify: `serverside/src/config/verifyVehicles.ts`

**Interfaces:**
- Consumes: the `GET /vehicles` behavior from Task 2; the existing harness helpers `login`, `request`, `expectEqual`, `idOf`, `nextUid`, and the `ownerId` created in `main()`.
- Produces: nothing consumed by later tasks. This task is the server-side gate.

- [ ] **Step 1: Read the harness's existing shape**

Open `serverside/src/config/verifyVehicles.ts` and read `main()` from line 109 to the end. Note that `ownerId`, `stamp`, `suffix`, and `nextUid()` already exist and that vehicles are created with `request(superadmin, 'POST', '/vehicles', {...})`. Reuse them; do not create a second throwaway owner.

- [ ] **Step 2: Add the new check block**

Inside `main()`, at the end of the existing `try` block (before its `finally`/cleanup), add:

```ts
    console.log('\n== list: owner join, search, and deactivation ==');

    // A vehicle of a type with room to spare, so this block never collides
    // with the limit assertions above. pickup's limit is 3.
    const listPlate = `VLIST-${suffix}`;
    const listUid = nextUid();
    const listRes = await request(superadmin, 'POST', '/vehicles', {
      owner_person_id: ownerId,
      plate_number: listPlate,
      rfid_uid: listUid,
      vehicle_type: 'pickup',
      make: 'Toyota',
    });
    expectEqual('list fixture created', listRes.status, CREATED);
    const listId = idOf(listRes.json);

    // 1. The owner arrives joined, not as a bare id.
    const listed = await request(superadmin, 'GET', `/vehicles?search=${listPlate}`);
    expectEqual('list responds 200', listed.status, OK);
    const listRows = (listed.json.data ?? []) as Array<{
      plate_number?: string;
      owner_person_id?: { full_name?: string } | string;
    }>;
    expectEqual('search by plate returns exactly one row', listRows.length, 1);
    const joinedOwner = listRows[0]?.owner_person_id;
    expectEqual(
      'owner is populated, not a bare id',
      typeof joinedOwner === 'object' && typeof joinedOwner?.full_name === 'string',
      true
    );
    expectEqual(
      'populated owner is the right person',
      typeof joinedOwner === 'object' ? joinedOwner?.full_name : null,
      'Vehicle-Limit Owner'
    );

    // 2. Search matches the sticker UID too.
    const byUid = await request(superadmin, 'GET', `/vehicles?search=${listUid}`);
    const uidRows = (byUid.json.data ?? []) as Array<{ plate_number?: string }>;
    expectEqual('search by rfid_uid finds the vehicle', uidRows[0]?.plate_number, listPlate);

    // 3. Regex metacharacters are escaped, not executed. Unescaped, the open
    //    paren reaches the driver as an unterminated group and 500s.
    const meta = await request(superadmin, 'GET', '/vehicles?search=' + encodeURIComponent('CAV (88'));
    expectEqual('regex metacharacters do not error', meta.status, OK);

    // 4. Deactivating frees the owner's slot for that type. Fill pickup to its
    //    limit, confirm the next one is refused, deactivate one, confirm it is
    //    then accepted.
    const pickupsToAdd = VEHICLE_LIMITS.pickup - 1; // the fixture above is one
    const filler: string[] = [];
    for (let i = 0; i < pickupsToAdd; i++) {
      const r = await request(superadmin, 'POST', '/vehicles', {
        owner_person_id: ownerId,
        plate_number: `VFILL${i}-${suffix}`,
        rfid_uid: nextUid(),
        vehicle_type: 'pickup',
      });
      expectEqual(`pickup filler ${i + 1} accepted`, r.status, CREATED);
      filler.push(idOf(r.json));
    }

    const overLimit = await request(superadmin, 'POST', '/vehicles', {
      owner_person_id: ownerId,
      plate_number: `VOVER-${suffix}`,
      rfid_uid: nextUid(),
      vehicle_type: 'pickup',
    });
    expectEqual('pickup past the limit is refused', overLimit.status, CONFLICT);

    const deact = await request(superadmin, 'PATCH', `/vehicles/${listId}/status`, {
      status: 'inactive',
    });
    expectEqual('deactivate responds 200', deact.status, OK);

    const afterFree = await request(superadmin, 'POST', '/vehicles', {
      owner_person_id: ownerId,
      plate_number: `VFREE-${suffix}`,
      rfid_uid: nextUid(),
      vehicle_type: 'pickup',
    });
    expectEqual('deactivating freed the slot', afterFree.status, CREATED);

    // 5. Reactivating past the limit is refused, and says so in words the UI
    //    can show verbatim.
    const react = await request(superadmin, 'PATCH', `/vehicles/${listId}/status`, {
      status: 'active',
    });
    expectEqual('reactivating past the limit is refused', react.status, CONFLICT);
    expectEqual(
      'the refusal names the limit',
      String(react.json.message ?? '').includes('the limit'),
      true
    );

    void filler;
```

- [ ] **Step 3: Run the harness**

With `npm run dev` running and `npm run seed:test` already applied:

```bash
cd C:/thesis_rfid/serverside
npm run verify:vehicles
```

Expected: every line prints `ok`, and the run ends with `All vehicle checks passed.` If any check FAILs, fix the cause before continuing — a failing harness here means Task 4 would be building on a broken API.

- [ ] **Step 4: Commit**

```bash
cd C:/thesis_rfid/serverside
git add src/config/verifyVehicles.ts
git commit -m "test: cover the vehicle list join, search, and deactivation"
```

---

## Task 4: Client — the `VehiclesView` component

**Files:**
- Create: `userpage/components/admin/VehiclesView.tsx`

**Interfaces:**
- Consumes: `apiGet`, `apiPatch` from `@/lib/auth`; `VEHICLE_TYPES` from `@/lib/vehicleTypes`; `Notice` and `SectionHeading` components; the populated `owner_person_id` shape from Task 2.
- Produces: `export default function VehiclesView()` — takes **no props**. Task 6 renders it as `<VehiclesView />`.

- [ ] **Step 1: Read the Next.js client-component guide**

Required by `userpage/AGENTS.md` before writing any code:

```bash
cat C:/thesis_rfid/userpage/node_modules/next/dist/docs/01-app/03-api-reference/01-directives/use-client.md
```

The load-bearing rule for this file: `"use client"` goes at the very top, **before any imports**.

- [ ] **Step 2: Create the component**

Create `userpage/components/admin/VehiclesView.tsx`:

```tsx
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiGet, apiPatch } from "@/lib/auth";
import { VEHICLE_TYPES } from "@/lib/vehicleTypes";
import Notice from "@/components/Notice";
import SectionHeading from "@/components/SectionHeading";
import { TfiCar } from "react-icons/tfi";

/** The owner as GET /vehicles now joins it. Null when the person was deleted. */
interface VehicleOwner {
  _id: string;
  full_name: string;
  id_number: string;
  type: string;
}

interface VehicleRow {
  _id: string;
  plate_number: string;
  rfid_uid: string;
  vehicle_type: string;
  make?: string;
  vehicle_model?: string;
  valid_until: string;
  status: "active" | "inactive";
  owner_person_id: VehicleOwner | null;
}

type Badge = "active" | "expired" | "inactive";

/**
 * A vehicle may be stored `active` and still be past its expiry. The gate calls
 * that unusable — vehicleRepo.findActiveByOwner filters on status AND
 * valid_until — so showing the stored field alone would tell a clerk the
 * opposite of what the barrier does. Presentational only: nothing writes
 * "expired", and the toggle still sends active/inactive.
 */
function badgeOf(v: VehicleRow): Badge {
  if (v.status === "inactive") return "inactive";
  return new Date(v.valid_until) < new Date() ? "expired" : "active";
}

const BADGE_CLS: Record<Badge, string> = {
  active: "border border-blue bg-blue/25 text-ink",
  expired: "bg-gold/40 text-ink",
  inactive: "bg-ink-soft/10 text-ink-soft",
};

const selectCls =
  "rounded-xl border border-line bg-white px-3 py-2 text-[14px] text-ink outline-none focus:border-blue focus:ring-4 focus:ring-blue/12";

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export default function VehiclesView() {
  const [rows, setRows] = useState<VehicleRow[]>([]);
  const [type, setType] = useState("");
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Keyed by vehicle id, not a single boolean: one slow row must not freeze the
  // whole table, and a double-click must not queue two writes for the same row.
  const [busyId, setBusyId] = useState<string | null>(null);
  const gen = useRef(0);

  const load = useCallback(async () => {
    const mine = ++gen.current;
    setError(null);
    try {
      const p = new URLSearchParams();
      if (type) p.set("vehicle_type", type);
      if (status) p.set("status", status);
      if (search.trim()) p.set("search", search.trim());
      p.set("limit", "100");
      const list = await apiGet<VehicleRow[]>(`/vehicles?${p.toString()}`);
      if (mine !== gen.current) return; // a newer load started; discard this
      setRows(list);
    } catch (err) {
      if (mine !== gen.current) return;
      setError((err as Error).message);
    } finally {
      if (mine === gen.current) setLoading(false);
    }
  }, [type, status, search]);

  useEffect(() => {
    // Debounced so typing in the search box doesn't fire a request per keystroke.
    const t = setTimeout(() => void load(), 250);
    return () => {
      clearTimeout(t);
      // `gen` is a plain counter ref, not a DOM node, so there is no stale-node
      // hazard here — bumping it on every cleanup is what invalidates in-flight
      // responses after unmount or filter change.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      gen.current++;
    };
  }, [load]);

  async function toggle(row: VehicleRow) {
    setBusyId(row._id);
    setError(null);
    try {
      await apiPatch(`/vehicles/${row._id}/status`, {
        status: row.status === "active" ? "inactive" : "active",
      });
    } catch (err) {
      // Reactivation legitimately fails when the owner has since filled that
      // type. The server already words it with the owner's name and the
      // type-correct plural, so it is shown verbatim rather than re-composed.
      setError((err as Error).message);
    } finally {
      setBusyId(null);
      // Reload regardless of outcome: a failed toggle can still mean the
      // on-screen list is stale, e.g. someone else changed the same row.
      await load();
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="font-display text-xl font-700 text-navy">Vehicles</h1>
        <p className="text-sm text-ink-soft">
          Deactivating a vehicle frees the owner&apos;s slot for that type and stops its
          RFID sticker at the barrier. The registration is kept, so you can reactivate it
          later.
        </p>
      </div>

      {error && <Notice className="text-sm text-ink">{error}</Notice>}

      <section className="rounded-2xl border border-line bg-white p-5">
        <SectionHeading icon={TfiCar}>Registered vehicles</SectionHeading>

        <div className="mt-3 flex flex-wrap gap-2">
          <select value={type} onChange={(e) => setType(e.target.value)} className={selectCls}>
            <option value="">All types</option>
            {VEHICLE_TYPES.map((t) => (
              <option key={t} value={t} className="capitalize">
                {t}
              </option>
            ))}
          </select>
          <select value={status} onChange={(e) => setStatus(e.target.value)} className={selectCls}>
            <option value="">All statuses</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search plate or RFID UID…"
            className={`min-w-[16rem] flex-1 ${selectCls}`}
          />
        </div>

        {loading && <p className="mt-3 text-[15px] text-ink-soft">Loading…</p>}

        {!loading && rows.length === 0 && (
          <p className="mt-3 text-[15px] text-ink-soft">No vehicles match those filters.</p>
        )}

        {!loading && rows.length > 0 && (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-[14px]">
              <thead>
                <tr className="border-b border-line text-[12px] uppercase tracking-wide text-ink-soft">
                  <th className="py-2 font-600">Plate</th>
                  <th className="py-2 font-600">Vehicle</th>
                  <th className="py-2 font-600">Owner</th>
                  <th className="py-2 font-600">Valid until</th>
                  <th className="py-2 font-600">Status</th>
                  <th className="py-2 font-600">
                    <span className="sr-only">Action</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((v) => {
                  const badge = badgeOf(v);
                  const busy = busyId === v._id;
                  return (
                    <tr key={v._id} className="border-b border-line/60 last:border-0">
                      <td className="py-2.5 font-mono text-[13px] font-600 text-ink">
                        {v.plate_number}
                      </td>
                      <td className="py-2.5 text-ink">
                        <span className="capitalize">{v.vehicle_type}</span>
                        {(v.make || v.vehicle_model) && (
                          <span className="text-ink-soft">
                            {" · "}
                            {[v.make, v.vehicle_model].filter(Boolean).join(" ")}
                          </span>
                        )}
                      </td>
                      <td className="py-2.5 text-ink">
                        {v.owner_person_id ? (
                          <>
                            <span className="font-600">{v.owner_person_id.full_name}</span>{" "}
                            <span className="text-ink-soft">
                              · {v.owner_person_id.id_number}
                            </span>
                          </>
                        ) : (
                          <span className="text-ink-soft">— (deleted)</span>
                        )}
                      </td>
                      <td className="py-2.5 text-ink-soft">{fmtDate(v.valid_until)}</td>
                      <td className="py-2.5">
                        <span
                          className={`rounded-md px-2 py-0.5 text-[12px] font-600 capitalize ${BADGE_CLS[badge]}`}
                        >
                          {badge}
                        </span>
                      </td>
                      <td className="py-2.5 text-right">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void toggle(v)}
                          className="rounded-lg border border-line bg-white px-3 py-1.5 text-[13px] font-600 text-ink-soft transition hover:border-navy hover:text-navy disabled:opacity-60"
                        >
                          {busy
                            ? "Saving…"
                            : v.status === "active"
                              ? "Deactivate"
                              : "Reactivate"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
```

- [ ] **Step 3: Verify it typechecks and lints**

```bash
cd C:/thesis_rfid/userpage
npx tsc --noEmit
npx next lint --file components/admin/VehiclesView.tsx
```

Expected: no errors referencing `VehiclesView.tsx`. The component is not yet reachable in the UI — that is Tasks 5 and 6.

> Note: `npx tsc --noEmit` runs over the whole project, which has unrelated modified files on this branch. Errors in **other** files are pre-existing; only treat `VehiclesView.tsx` errors as yours.

- [ ] **Step 4: Commit**

```bash
cd C:/thesis_rfid/userpage
git add components/admin/VehiclesView.tsx
git commit -m "feat: add the vehicles list view with a deactivate toggle"
```

---

## Task 5: Client — nav entry and permissions

**Files:**
- Modify: `userpage/lib/permissions.ts:13-20`, `:108-116`, `:118-146`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `"vehicles"` as a member of the `AdminView` union. Task 6 switches on it.

- [ ] **Step 1: Add `vehicles` to the view union**

In `userpage/lib/permissions.ts`, extend `AdminView` (lines 13-20):

```ts
export type AdminView =
  | "overview"
  | "directory"
  | "parking"
  | "vehicles"
  | "presence"
  | "records"
  | "register"
  | "accounts";
```

- [ ] **Step 2: Add the icon**

In the same file, add to `VIEW_ICONS`:

```ts
export const VIEW_ICONS: Record<AdminView, IconType> = {
  overview: TfiDashboard,
  directory: TfiIdBadge,
  parking: TfiCar,
  // Same icon as Parking on purpose: same subject, seen from the registry side
  // rather than the gate side.
  vehicles: TfiCar,
  presence: TfiTime,
  records: TfiAgenda,
  register: TfiWrite,
  accounts: TfiKey,
};
```

`TfiCar` is already imported at the top of the file — do not add a second import.

- [ ] **Step 3: Add the tab for superadmin and oss only**

In `NAV_BY_ROLE`, add `{ id: "vehicles", label: "Vehicles" }` after the `parking` entry for `superadmin`, and after `parking` for `oss`:

```ts
  superadmin: [
    { id: "overview", label: "Overview" },
    { id: "directory", label: "Directory" },
    { id: "parking", label: "Parking" },
    { id: "vehicles", label: "Vehicles" },
    { id: "presence", label: "Presence" },
    { id: "records", label: "Records" },
    { id: "register", label: "Register" },
    { id: "accounts", label: "Accounts" },
  ],
```

```ts
  oss: [
    { id: "register", label: "Register" },
    { id: "directory", label: "Directory" },
    { id: "parking", label: "Parking" },
    { id: "vehicles", label: "Vehicles" },
  ],
```

Add a comment above the `oss` array explaining the exclusion of registrar and hr:

```ts
  // No vehicles tab for registrar or hr. They may READ /vehicles
  // (vehicles.routes.ts authorizes all four staff roles) but writes are
  // OSS-only via assertCanWrite('vehicle'), so the tab's only button would
  // 403 for them — the same reason the OSS Register tab was withheld until it
  // had something behind it.
```

Do **not** add `vehicles` to `registrar`, `hr`, `staff`, or `student`.

- [ ] **Step 4: Verify it typechecks**

```bash
cd C:/thesis_rfid/userpage
npx tsc --noEmit
```

Expected: an error in `AdminShell.tsx` is **acceptable at this point only if** it is about an unhandled `vehicles` case; anything else in `permissions.ts` is yours to fix. Task 6 closes it.

- [ ] **Step 5: Commit**

```bash
cd C:/thesis_rfid/userpage
git add lib/permissions.ts
git commit -m "feat: add the Vehicles tab for superadmin and OSS"
```

---

## Task 6: Client — wire the view into `AdminShell`

**Files:**
- Modify: `userpage/components/admin/AdminShell.tsx:9-14` and `:107-122`

**Interfaces:**
- Consumes: `VehiclesView` (Task 4), the `"vehicles"` view id (Task 5).
- Produces: the finished, reachable feature.

- [ ] **Step 1: Import the view**

In `userpage/components/admin/AdminShell.tsx`, add to the existing view imports (after `ParkingView`, keeping the alphabetical-ish grouping already there):

```tsx
import VehiclesView from "./VehiclesView";
```

- [ ] **Step 2: Render it**

Add a branch alongside the others in the view body, directly after the `parking` line:

```tsx
        {!loading && view === "vehicles" && <VehiclesView />}
```

Note it has **no** `data` guard, unlike `parking`. `ParkingView` reads from the dashboard payload; `VehiclesView` fetches its own data, so gating it on `data` would blank the tab whenever `/dashboard` fails.

- [ ] **Step 3: Verify the whole project typechecks and builds**

```bash
cd C:/thesis_rfid/userpage
npx tsc --noEmit
npm run build
```

Expected: no errors in `AdminShell.tsx`, `VehiclesView.tsx`, or `permissions.ts`, and the build completes.

- [ ] **Step 4: Verify in the running app**

With `serverside` on `npm run dev` and `userpage` on `npm run dev`:

1. Log in as the superadmin (`admin`)
2. Click the **Vehicles** tab
3. Confirm `CAV 8832` is listed with owner **John Moises Nugal · 2023-55904** — not a bare ObjectId
4. Type `CAV` in the search box; the list narrows
5. Type `CAV (88`; the list empties without an error notice appearing
6. Click **Deactivate** on `CAV 8832`; the badge flips to `inactive` and the button becomes **Reactivate**
7. Click **Reactivate**; the badge returns to `active`

Then confirm the role boundary — log in as an OSS user and check the Vehicles tab is present, and as a registrar and check it is **absent**.

- [ ] **Step 5: Commit**

```bash
cd C:/thesis_rfid/userpage
git add components/admin/AdminShell.tsx
git commit -m "feat: render the vehicles view in the admin shell"
```

---

## Task 7: Restore the test data this plan disturbed

**Files:** none — this is a data cleanup step.

**Interfaces:**
- Consumes: nothing.
- Produces: a database whose fixtures match what the earlier manual-testing notes describe.

- [ ] **Step 1: Check what Task 3 and Task 6 left behind**

Task 3's harness creates `VLIST-*`, `VFILL*`, `VFREE-*` pickups against a throwaway owner, and Task 6's manual walkthrough toggles `CAV 8832` twice. Confirm the real fixture is back to active:

```bash
mongosh "mongodb://127.0.0.1:27017/ncst_rfid" --quiet --eval '
printjson(db.vehicles.find({plate_number:"CAV 8832"},{plate_number:1,status:1,rfid_uid:1}).toArray());
print("harness leftovers: " + db.vehicles.countDocuments({plate_number:/^V(LIST|FILL|FREE|OVER)/}));
'
```

Expected: `CAV 8832` is `status: "active"` with `rfid_uid: "0004512983"`.

- [ ] **Step 2: Reactivate it if the walkthrough left it inactive**

Only if Step 1 showed `inactive`:

```bash
mongosh "mongodb://127.0.0.1:27017/ncst_rfid" --quiet --eval '
db.vehicles.updateOne({plate_number:"CAV 8832"}, {$set:{status:"active"}});
printjson(db.vehicles.findOne({plate_number:"CAV 8832"},{plate_number:1,status:1}));
'
```

- [ ] **Step 3: Decide on the harness leftovers**

The `V*` vehicles are throwaway fixtures tied to a throwaway person and are harmless — every harness in this repo leaves similar rows, and `verify:vehicles` is written to be re-runnable alongside them. Leave them unless the count is climbing across many runs, in which case:

```bash
mongosh "mongodb://127.0.0.1:27017/ncst_rfid" --quiet --eval '
printjson(db.vehicles.deleteMany({plate_number:/^V(LIST|FILL|FREE|OVER)-/}));
'
```

- [ ] **Step 4: No commit**

This task touches no files.

---

## Self-Review

**Spec coverage**

| Spec section | Task |
| --- | --- |
| Server: owner names on the list | Task 2, Step 1 |
| Server: search filter + `escapeRegex` | Task 1; Task 2, Steps 2-3 |
| Client: `VehiclesView` structure, debounce, `gen` ref | Task 4 |
| Status is three states | Task 4, `badgeOf` |
| No pager, `limit=100` | Task 4, `load()` |
| Client: nav and permissions, registrar/hr excluded | Task 5 |
| `AdminShell` renders the view | Task 6 |
| Error handling: reactivation 409 shown verbatim | Task 4, `toggle()`; Task 3, check 5 |
| Per-row busy state | Task 4, `busyId` |
| Testing checks 1-6 | Task 3 |
| Testing check 7 (expired ≠ active) | **Covered client-side only**, by `badgeOf` in Task 4. There is no expiry block in `verifyVehicles.ts` — nothing asserts server-side that an expired-but-active vehicle is absent from `findActiveByOwner`. That remains an untested gap. |
| Known issue: `personService` unescaped regex | Not implemented by design — recorded in `escapeRegex.ts`'s doc comment (Task 1) so it is discoverable from the code, not only the spec. |
| Out of scope: edit, delete | No task. Correct. |

**Placeholders:** none. Every code step carries the literal content to write.

**Type consistency:** `VehicleRow`, `VehicleOwner`, `Badge`, and `badgeOf` are defined once in Task 4 and referenced nowhere else. `escapeRegex` is defined in Task 1 and imported in Task 2 under the same name. `AdminView`'s `"vehicles"` member (Task 5) matches the `view === "vehicles"` comparison (Task 6). The populated owner field is `owner_person_id` on both sides — the server populates in place rather than renaming, and Task 4's interface declares it as `VehicleOwner | null`, which matches Mongoose's behavior when the referenced document is gone.
