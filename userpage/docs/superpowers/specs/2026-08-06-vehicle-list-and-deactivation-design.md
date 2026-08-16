# Vehicles list with deactivation

Date: 2026-08-06

## Problem

`PATCH /api/vehicles/:id/status` has existed since vehicle registration
shipped (`vehicles.routes.ts:33`), and nothing in the frontend calls it. The
only vehicle requests the browser makes are the application form's `POST
/vehicles` and its photo upload (`VehicleApplicationForm.tsx:381`). There is no
vehicle list, no edit screen, and no deactivate control anywhere in `userpage`.

The consequence is operational. Per-type allowances count active, unexpired
vehicles only, so freeing a slot means deactivating a vehicle — and the only
ways to do that today are curl against the API or a direct `mongosh` write.
An OSS clerk who registers a vehicle to the wrong person, or whose owner has
hit the pickup limit, has no path forward inside the app.

A second gap surfaced while scoping this: `GET /vehicles` returns raw vehicle
documents. `owner_person_id` is a bare `ObjectId`, and the only filters are
`status` and `vehicle_type`. A list built on today's response would show
`6a6d3b2ddb1da8cff1ace641` where the owner's name belongs.

## Decisions

| Question | Decision |
| --- | --- |
| Placement | New top-level **Vehicles** tab |
| Who sees it | superadmin and oss only |
| Owner names | Server-side `.populate()` on `findPaginated` |
| Search | Server-side, over `plate_number` and `rfid_uid`, regex-escaped |
| Row action | Toggle (Deactivate / Reactivate), fires immediately, no confirm |
| Status display | Three states — active, expired, inactive |
| Out of scope | Editing vehicle fields; deleting vehicles |

Deactivation is reversible and the row survives, so a confirm dialog is
friction on a safe action. This matches `AccountsView.toggleOne`
(`AccountsView.tsx:122-132`), which also fires immediately.

## Architecture

### Server: owner names on the list

`vehicleRepo.findPaginated` currently returns lean documents with no join:

```ts
VehicleModel.find(filter).sort({ createdAt: -1 }).skip(p.skip).limit(p.limit).lean()
```

It gains a populate:

```ts
VehicleModel.find(filter)
  .populate('owner_person_id', 'full_name id_number type')
  .sort({ createdAt: -1 })
  .skip(p.skip)
  .limit(p.limit)
  .lean()
```

Only this method changes. `findActiveByOwner` is left alone deliberately — it
feeds the gate terminal, which needs a narrow projection and no owner join,
and its comment already warns against a second lookup with a drifting filter.

The populate projection is the minimum the list renders: `full_name` for the
column, `id_number` to disambiguate two people with the same name, `type` for
the row subtitle. A deleted owner populates as `null`; the view renders
"— (deleted)" rather than crashing.

### Server: search filter

`vehicleService.list` builds its filter inline today. It gains a `search`
branch over the two fields that identify a vehicle:

```ts
if (query.search) {
  const rx = { $regex: escapeRegex(query.search), $options: 'i' };
  filter.$or = [{ plate_number: rx }, { rfid_uid: rx }];
}
```

Owner name is **not** searchable. Doing so would require either a `$lookup`
pipeline or a two-step query, and the directory already answers "which
vehicles does this person have" from the person's side. Plate and UID are what
a clerk holding a vehicle in front of them actually has.

`escapeRegex` is a new two-line helper in `serverside/src/utils/`. This is a
deliberate departure from `personService`'s search (`persons.service.ts:38`),
which interpolates user input into `$regex` unescaped. Plate numbers contain
characters that are regex metacharacters more often than names do — a plate
typed as `CAV (8832` throws an unhandled `PCRE` error today. The persons
search is not changed here; that is its own fix, noted below.

### Client: `VehiclesView`

New `components/admin/VehiclesView.tsx`, structured after `AccountsView`:

- Filter state (`type`, `status`, `search`) feeding a `useCallback` query builder
- `load()` in a debounced effect, 250 ms, with the `gen` ref counter that
  discards out-of-order responses
- `load()` re-run after every mutation, in a `finally` so a failed toggle still
  refreshes a possibly-stale list

Columns: plate · type and make · owner · valid until · status · action.

No pager. The view requests `limit=100` and renders what comes back, as
`AccountsView` does (`AccountsView.tsx:68`). The office registers vehicles in
the dozens, and the filters narrow further; a pager is added when the count
justifies it, not before.

### Status is three states, not two

A vehicle may be `status: 'active'` and past `valid_until`. The API reports it
as active; the gate treats it as unusable, because `findActiveByOwner` filters
on status **and** expiry. Rendering the stored field alone would tell a clerk
the opposite of what the barrier does.

The badge is therefore derived:

```
status === 'inactive'            → inactive
valid_until < now                → expired
otherwise                        → active
```

`expired` is presentational only. Nothing is written, and the toggle still
sends `active` / `inactive` — expiry is a date, not a status.

### Client: nav and permissions

`lib/permissions.ts` gains `"vehicles"` in `AdminView`, an entry in
`VIEW_ICONS` (`TfiCar`, matching Parking's use of the same icon for the same
subject), and the tab in `NAV_BY_ROLE` for `superadmin` and `oss`.

Registrar and HR are excluded even though `vehicles.routes.ts:25-28` lets them
*read* the collection. Writes are OSS-only via `assertCanWrite('vehicle')`, so
those roles would get a tab whose only button 403s. This mirrors the reasoning
recorded at `permissions.ts:136-138`, where the OSS Register tab was withheld
until it had something behind it.

`AdminShell` renders the view behind `view === "vehicles"`, alongside the
existing branches.

## Data flow

```
VehiclesView
  └─ GET /vehicles?status=&vehicle_type=&search=&page=&limit=
       └─ vehicleService.list (filter built inline) → vehicleRepo.findPaginated
            └─ .populate(owner_person_id) → rows with owner objects

  └─ [Deactivate] → PATCH /vehicles/:id/status {"status":"inactive"}
       └─ vehicleService.setStatus → update()
            └─ owner-exists check + per-type allowance check
       └─ load() → table re-renders
```

## Error handling

Deactivation has no domain failure mode; only network and auth errors reach
the user.

**Reactivation can legitimately fail.** `setStatus` delegates to `update()`
(`vehicles.service.ts:210-213`), which re-runs `assertWithinLimit` on the way
back to active. Reactivating a vehicle whose owner has since filled that type
returns 409:

> John Moises Nugal already has 3 active pickups (the limit). Deactivate one first.

The view surfaces `err.message` in a `Notice` rather than composing its own
wording — the server already has the owner's name and the type-correct plural
(`pluralizeType`), and a second copy would drift.

A row is disabled while its own request is in flight, keyed by vehicle id, so
a double-click cannot queue two writes and one slow row cannot freeze the
table.

## Testing

Extend `serverside/src/config/verifyVehicles.ts`, the existing black-box
harness for this module:

1. List returns a populated owner name, not a bare id
2. Search matches by plate number
3. Search matches by RFID UID
4. Search input containing regex metacharacters returns cleanly rather than
   erroring
5. Deactivating frees the owner's slot for that type — a registration that
   was 409ing succeeds afterward
6. Reactivating past the limit returns 409 carrying the limit message
7. An expired-but-active vehicle is absent from `findActiveByOwner`, holding
   the derived-badge logic to the same definition the gate uses

## Known issue, deliberately not fixed here

`personService`'s search interpolates unescaped user input into `$regex`
(`persons.service.ts:38`). The same class of bug this spec avoids for
vehicles exists there today for names and ID numbers. It is a one-line fix
using the same helper, but it changes behavior on a shared code path
(`buildListFilter` serves the directory, the deleted-persons view, and CSV
export) and belongs in its own change with its own verification.

Separately: the owner search in `GadgetForm` and `VehicleApplicationForm`
searches `full_name` and `id_number` only, so typing a person's RFID UID
returns no matches and the form reports "Select the owner from the directory
first." That is working as designed — noted here only because it is adjacent
and gets rediscovered.
