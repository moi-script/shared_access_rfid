# Vehicle Registration Simplification — Design Spec

**Date:** 2026-08-18
**Supersedes (partially):** `2026-07-31-vehicle-registration-design.md` — that
spec's six-section paper-form layout is reduced here to a single short form.
The original stays the record of why each field existed.
**Touches:** `userpage` (form, vehicle-type mirror) and `serverside`
(vehicle-type constant, application schema + model).

---

## 1. Goal

Reduce the vehicle application form to the nine fields the OSS office actually
fills in, add `car` as a registrable vehicle type, and remove repeat typing by
auto-filling a returning applicant from their own records.

The current form (`components/vehicles/VehicleApplicationForm.tsx`, 896 lines)
collects ~28 fields mirroring the printed sheet. In practice most arrive blank.

## 2. Scope

**In scope:**

- Form reduced to: Application (`category`), Applicant Type, Vehicle Type,
  Owner, Id number, School Year, Email, Mobile No., Plate no.
- `car` added to the vehicle type list, with no per-person cap.
- Auto-fill of Owner / Email / School Year / Mobile No. from the Id number.
- Vehicle photo reuse on renewal of an already-registered plate.
- Signature capture removed from the form.

**Explicitly out of scope:**

- Deleting any field from the data model. Dropped fields are commented out in
  the form and relaxed (not removed) on the server. See §4.
- The `applicationSignatures` server module — routes, model, and service stay
  live and callable; only the form stops calling them.
- `rfid_uid`. Not in the request list, but it is the sticker that opens the
  barrier (`VehicleModel` declares it `required: true, unique: true`), not a
  paper-form field. It stays.
- Person photo capture. It already reuses an existing photo
  (`VehicleApplicationForm.tsx:566` offers capture only when
  `owner.photo_url` is absent), so the requested behaviour is present.

## 3. Vehicle type: `car`

`VEHICLE_TYPES` lives in exactly one place per deployable and every Mongoose
enum and zod schema reads from it, so both mirrors change together:

- `serverside/src/constants/vehicleTypes.ts` (authoritative)
- `userpage/lib/vehicleTypes.ts` (browser mirror)

`car` is appended to both lists.

### 3.1 No per-person limit

`VEHICLE_LIMITS` is typed `Record<VehicleType, number>`, so an entry is
mandatory once `car` joins the union — omitting it is a compile error in both
projects.

`car` is therefore set to `Number.POSITIVE_INFINITY`. The only enforcement site
is `assertWithinLimit` (`serverside/src/modules/vehicles/vehicles.service.ts:49-60`):

```ts
const limit = VEHICLE_LIMITS[type];
const used = active.filter(...).length;
if (used >= limit) throw new ApiError('CONFLICT', ...);
```

`used >= Infinity` is never true for a finite count, so the check passes
unconditionally and the CONFLICT message never fires. This expresses "no limit"
without touching the checking code.

The considered alternative — widening the type to
`Partial<Record<VehicleType, number>>` and treating a missing key as unlimited —
produces the same behaviour but changes the type and every reader. Rejected as
more churn for no gain.

A comment at the constant records that `Infinity` is deliberate, so a later
reader does not "fix" it to a number.

## 4. Fields: what the form sends, what the server accepts

### 4.1 Kept in the form

`category`, `applicant_type`, `vehicle_type`, Owner (as `owner_person_id`),
`id_number`, `school_year`, `email`, `mobile_no`, `plate_no`, `rfid_uid`.

### 4.2 Commented out in the form

`last_name`, `first_name`, `middle_name`, `year_level`, `tel_no`,
`permanent_address`, `make`, `model`, `year`, `color`, `mv_file_no`,
`lto_cr_no`, `lto_cr_date`, `lto_or_no`, `lto_or_date`, `relationship`,
`driver_name`, `driver_license_no`, `signed_name`, `signed_date`, and the
signature file input.

Commented, not deleted, in the same style as the directory/profile Delete
removal: the block stays greppable and re-arming is an uncomment.

### 4.3 Still sent, because it is derivable

`registered_owner_name` remains required server-side and is populated from the
looked-up person's `full_name`. This is real data, not a placeholder, so no
relaxation is needed and no junk is written.

Its **input is removed from the UI** along with the fields in §4.2 — the clerk
never types it — but unlike those, the key is still present in the submitted
payload. It is the one field that is hidden and sent rather than hidden and
dropped.

### 4.4 Relaxed on the server

Five fields are `.min(1)` in `vehicleApplications.schema.ts` **and**
`required: true` in `vehicleApplications.model.ts`, and would now arrive empty.
Both layers relax to optional:

| Field | Schema | Model |
|---|---|---|
| `last_name` | `:16` | `:80` |
| `first_name` | `:17` | `:81` |
| `make` | `:38` | `:100` |
| `signed_name` | `:46` | `:108` |
| `signed_date` | `:47` | `:109` |

`VehicleModel` already declares `make`, `vehicle_model`, and `color` optional
(`vehicles.model.ts:35-40`), so the vehicle side needs no change.

Nothing else in either schema is relaxed. Fields that stay required stay
required.

### 4.5 Consequence to verify during implementation

With `make`, `model`, and `color` no longer collected, a newly registered
vehicle is identified by plate, type, and photo alone. Before implementing,
grep for readers of those three fields (reports, the barrier console, the
vehicles list view). Any UI that displays them must tolerate a blank rather
than render an empty label. This is a check, not a redesign: the fields remain
in the model and older rows keep their values.

## 5. Auto-fill from Id number

Id number is the lookup key; Owner becomes read-only and is filled from it.

### 5.1 Why two hops

The person record holds only `full_name`, `id_number`, `department_section`,
and `contact_email` (`persons.model.ts:5-25`). **School Year and Mobile No. do
not exist on it.** They exist only on prior vehicle applications
(`vehicleApplications.model.ts:84-86`). A person-only lookup would leave two of
the four target blanks unfilled, so the fill reads both sources:

1. `GET /persons?search=<id_number>` → `owner_person_id`, Owner name from
   `full_name`, Email from `contact_email`.
2. `GET /vehicle-applications?owner_person_id=<id>&limit=1` → their most recent
   application → School Year, Mobile No., and Email if the person record had
   none.

Both endpoints already exist. `vehicleApplications.service.list` accepts
`owner_person_id` (`:63`) and `findPaginated` sorts `createdAt: -1`
(`vehicleApplications.repository.ts:11`), so `limit=1` is genuinely the latest.
No new server route is required.

### 5.2 Rules

- **Fills blanks only.** A field the clerk has already typed is never
  overwritten. This makes the fill safe to re-run when the Id number changes.
- **Debounced and generation-guarded**, reusing the existing `gen.current`
  pattern in this file (`:238-269`) so a slow early response cannot clobber a
  faster later one.
- **No match is a dead end, stated plainly.** `owner_person_id` is required
  (`vehicleApplications.schema.ts:14`), so an application cannot be filed for
  someone who is not already a person. The form surfaces "No person with that
  Id number" rather than letting the clerk fill a form that will 422 on submit.
- **Step 2 failing is not an error.** A first-time applicant has no prior
  application; School Year and Mobile No. simply stay empty for typing.

### 5.3 Owner search

To be precise about what survives: the **search input, the results dropdown,
and `selectOwner`/`clearOwner` as user-facing controls are removed**. What is
retained is the underlying `/persons?search=` call and the debounce/generation
guard around it (`:238-280`), now driven by the Id number field instead of a
name query. `owner` remains the state that holds the resolved person and
supplies `owner_person_id`.

There is no name-search entry point after this change. A clerk who only knows
the applicant's name looks them up in the person directory first.

## 6. Vehicle photo reuse on renewal

Reuse happens only when the application is a **renewal of a plate the person
already holds**. A new plate always requires a fresh capture, whatever its type.

Rationale: vehicle photos are keyed uniquely per vehicle
(`vehiclePhotos.model.ts:16`), and the photo's job is to show the guard the
vehicle at the barrier. Two cars owned by one person share a type but are not
the same vehicle; inheriting one's photo for the other would show the wrong car.
Matching on plate makes the reused photo always the same physical vehicle.

### 6.1 Flow

1. On renewal with a plate typed, look through the person's vehicles from
   `GET /persons/:id/overview` (it returns `VehicleModel.find({ owner_person_id })`,
   `dashboard.service.ts:232`) for a matching `plate_number`.
2. On a match, `GET /vehicles/<oldId>/photo` for the bytes.
3. On success, show them as the prefilled vehicle photo, with the source plate
   visible, and upload them to `POST /vehicles/<newId>/photo` after the new
   vehicle is created.
4. On 404 or any failure, fall back to normal capture. A missing prior photo is
   an ordinary state, not an error.

No new endpoint: both routes exist (`vehicles.routes.ts:19,34`).

### 6.2 Upload ordering is unchanged

Photos still upload after the create, because the vehicle id does not exist
before it, and a photo failure still degrades to a warning rather than failing
the registration — the existing behaviour at `VehicleApplicationForm.tsx:371-399`.

## 7. Signature removal

Commented out in the form: the file input, the `handleSignature` handler, the
`toPngBlob` helper, the preview state, and the upload block at `:351-366`.

`POST /vehicle-applications/:id/signature` and the whole
`applicationSignatures` module stay live. Applications already carrying a
signature keep it, and `GET /:id/signature` still serves it.

## 8. Verification

**userpage:** `npm run lint` and `npm run build`. Lint baseline is 4 pre-existing
`react-hooks/set-state-in-effect` errors; the count must not increase, and any
line-number shift must be attributable to added lines.

**serverside:** `npm run build`, then the `config/verify*.ts` harness.
`verifyVehicles.ts` asserts `VEHICLE_LIMITS.van === 3` and derives loop bounds
from `VEHICLE_LIMITS.pickup` (`:138-148`, `:341`); adding `car` should not
disturb either, and the plan confirms it rather than assuming.

**Manual:** register a new car for a person with no prior application (all
blanks stay empty, fresh photo); register a renewal for an existing plate
(fields fill, photo prefills from the old vehicle); type an unknown Id number
(clear "no person" message, no submit).

## 9. Open items for the implementation plan

- Grep for readers of `make` / `vehicle_model` / `color` before relaxing (§4.5).
- Confirm `verifyVehicles.ts` passes unchanged with `car` present (§8).
- Decide where the "No person with that Id number" message sits in the form
  layout — a detail below the Id number field, matching existing error styling.
- Per `userpage/AGENTS.md`, this Next.js version has breaking changes from
  common knowledge. Read the relevant guide under `node_modules/next/dist/docs/`
  before writing the form changes, and heed any deprecation notices — do not
  assume familiar Next.js conventions apply.
