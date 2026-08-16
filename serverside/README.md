# NCST RFID Backend

TypeScript + Express + MongoDB backend for the NCST campus RFID gate & attendance system.
Handles person/vehicle registration, RFID gate scans, attendance logging, authentication,
and reporting.

Companion frontend: [`ncst_rfid_access`](https://github.com/moi-script/ncst_rfid_access).
See `../userpage/ncst_rfid_serverside_flow.md` for the full API blueprint.

Deploying? See **[`DEPLOYMENT.md`](DEPLOYMENT.md)** — Render + Vercel
walkthrough, the production environment reference, and which seed script to run
where.

## Tech stack

- **Node.js 22+ / Express** (TypeScript)
- **MongoDB / Mongoose**
- **JWT** auth (15m access token in body, 7d refresh token in an httpOnly cookie with rotation)
- **bcrypt** password hashing, **Zod** validation
- Helmet, CORS, rate limiting, morgan logging

## Setup

```bash
npm install
cp .env.example .env   # fill in MONGODB_URI, JWT secrets, admin creds
npm run seed           # creates admin + 4 gates (run once)
npm run dev            # start with hot reload
```

The API listens on `http://localhost:3000` (health check at `GET /health`).
`.env` is gitignored — never commit real secrets. Generate strong ones with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

### Required environment variables

| Variable | Description |
|----------|-------------|
| `MONGODB_URI` | MongoDB connection string |
| `JWT_ACCESS_SECRET` | Secret for signing access tokens |
| `JWT_REFRESH_SECRET` | Different secret for refresh tokens |
| `PORT` | API port (default `3000`) |
| `API_PREFIX` | Route prefix (default `/api`) |
| `ALLOWED_ORIGINS` | Comma-separated CORS origins (e.g. `http://localhost:5173`) |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | Seed admin credentials |
| `LOGIN_RATE_LIMIT_MAX` | Max `/auth/login` requests per 15 min (default `10`). `npm run verify:roles` makes 8 login calls per run, so running it twice in a row needs at least `20`. |
| `OCCUPANCY_RESET_TIME` | Nightly cutoff (`HH:MM`, default `23:00`) after which a card still marked inside is treated as outside. Prevents a missed exit tap from locking someone out the next morning. |
| `SCHOOL_YEAR_END_MMDD` | Vehicle pass expiry cutoff (`MM-DD`, default `03-31`), interpreted in the server's local timezone. A malformed value stops the server at startup rather than silently becoming an Invalid Date. |
| `VERIFY_BYPASS_TOKEN` | Optional, unset by default. Lets the `verify:*` harnesses run back to back at production rate limits instead of tripping them (see the "429s during a verify run" entry below). `shouldBypassRateLimit()` in `src/middlewares/rateLimiter.ts` only honours it when `NODE_ENV` is not `production`, so it is inert in a production configuration regardless of whether it happens to be set — but it must never be set on a production host anyway. **Never set it in production.** |

## Scripts

- `npm run dev` — ts-node-dev hot reload
- `npm run build` — compile to `dist/`
- `npm start` — run compiled server
- `npm run seed` — seed admin + gates (idempotent)
- `npm run seed:test` — seed hardcoded test accounts for the testing phase (idempotent)
- `npm run lint` — eslint
- `npm run verify:passback` — assert anti-passback behaviour (needs `dev` + `seed:test`).
  **Destructive to live occupancy state**: its rebuild-path check calls
  `OccupancyModel.deleteMany({})` on the whole collection before reconstructing
  it from `scan_logs`. It self-heals within the same run, but do not run it
  against a live campus mid-day.
- `npm run rebuild:occupancy` — reconcile occupancy state from `scan_logs`
- `npm run grant:superadmin -- <username>` — break-glass promotion of an
  existing account to `superadmin`. `POST /users { role: 'superadmin' }` is
  403 for everyone, superadmins included (`assertCanCreateRole` denies
  creating a peer or higher rank) — the API can **never** mint a superadmin.
  This script is the only path by which one can come to exist, which is why
  it deliberately lives outside the API: it requires shell access to the
  server (and therefore `.env`/`MONGODB_URI` access), not just a logged-in
  session. No argument prints a usage message and exits 1; an unknown
  username exits 1 with an error naming what it looked for; promoting an
  account that is already a superadmin is a no-op that exits 0. Keep this
  script available (and `ADMIN_PASSWORD` deleted from production `.env`
  after the first seed, per the note at the bottom of this file) — without
  it, a lost superadmin password is unrecoverable.

### Troubleshooting

- **Server fails to start with an index error on `occupancies`.** The
  `entity_type_1_entity_id_1` unique index is what makes anti-passback
  detection atomic, and `server.ts` now refuses to start until it exists. If
  the `occupancies` collection has duplicate `{entity_type, entity_id}` rows
  from a run that predates the index, the build fails permanently against
  that duplicate data. Drop the collection and run `npm run rebuild:occupancy`
  to repopulate it cleanly from `scan_logs`.
- **Occupancy state looks wrong (a card shows `inside` when it shouldn't, or
  vice versa) after a restore, a manual edit, or a bug.** `scan_logs` is the
  source of truth; occupancy is a read-optimised second copy that can drift
  from it. Run `npm run rebuild:occupancy` to wipe and replay occupancy from
  the scan log since the last nightly reset boundary. The script itself waits
  for the unique `(entity_type, entity_id)` index to finish building before
  writing, for the same reason described above — don't skip that wait when
  editing the script. **The `occupancies` collection reads completely EMPTY
  for the duration of the rebuild** (it wipes before it replays): a live
  server serving taps mid-rebuild admits everyone, since every card looks
  like a first entry. Take the gate offline for the rebuild window, or accept
  that every tap during it is treated as a fresh entry.
- **A second vehicle for the same owner is rejected as a duplicate, or a
  `POST /vehicles` for someone who already has a pass throws `DUPLICATE_PLATE`
  with the message "Owner already has a vehicle" even though the plate and
  RFID are both unused.** A pre-existing `owner_person_id_1` unique index on
  the `vehicles` collection silently enforces a one-vehicle-per-person rule
  that the schema no longer declares — Mongoose does not drop an existing
  index just because `unique: true` was removed from the schema definition.
  Drop it explicitly:
  ```bash
  mongosh ncst_rfid --quiet --eval 'db.vehicles.dropIndex("owner_person_id_1")'
  ```
  Confirm with `db.vehicles.getIndexes()` that `owner_person_id_1` is gone
  (only `_id_`, `plate_number_1`, and `rfid_uid_1` should remain unique).
- **A gate tap for a vehicle 500s instead of denying, or the deploy is
  bringing in a `vehicles` collection from before `valid_until` existed** (an
  older backup restore, or a manual edit that skipped the field). `valid_until`
  is `required: true` on the schema, but that is enforced only on write —
  Mongoose never validates a row already sitting in the database, so a
  pre-existing row can still have it missing. The gate code fails closed on a
  missing `valid_until` (denies with `vehicle_expired` and still logs the
  tap), but check for and backfill any such rows as a deploy step anyway,
  right after a restore or migration, rather than relying on that fallback
  indefinitely:
  ```bash
  mongosh ncst_rfid --quiet --eval 'db.vehicles.countDocuments({valid_until:{$exists:false}})'
  mongosh ncst_rfid --quiet --eval 'db.vehicles.updateMany({valid_until:{$exists:false}},{$set:{valid_until:ISODate("2027-03-31T23:59:59.999+08:00")}})'
  ```
  Run the `countDocuments` check first — it tells you whether the backfill
  even applies before you touch anything. The timestamp in the second command
  is a **local end-of-day** instant (`+08:00`, matching campus time and
  `nextSchoolYearEnd()`), not a UTC instant — adjust the offset if the
  deployment's local timezone differs. `npm run seed:test`'s `SEED_RESET`
  branch does **not** backfill this: it wipes only scan logs and attendance,
  never vehicles, so a pre-existing legacy row survives a test reseed
  untouched.
- **A `verify:*` run reports 429s, or `verify:passback` dies with
  `TypeError: Cannot read properties of undefined (reading 'find')`.** All
  four `verify:*` harnesses send `X-Verify-Bypass: $VERIFY_BYPASS_TOKEN` on
  every request (login calls included), which lets `globalLimiter`,
  `loginLimiter`, and `scanLimiter` all skip counting the run, provided the
  server has the same `VERIFY_BYPASS_TOKEN` set and `NODE_ENV` is not
  `production` (`shouldBypassRateLimit()` in
  `src/middlewares/rateLimiter.ts`). If you're seeing 429s despite that:
  - **`VERIFY_BYPASS_TOKEN` is unset or mismatched** between the harness's
    environment and the running server's `.env` — set the same value in both
    and restart the dev server so it picks up the change (`ts-node-dev`
    re-reads `.env` on respawn, but not while already running).
  - **You're intentionally running without it** (e.g. to check the harnesses
    still behave correctly under the real limits) — that's expected; the
    harnesses report the 429 clearly rather than mistaking it for an
    authorization failure. Run the harnesses one at a time, leaving a window
    between them, or set `VERIFY_BYPASS_TOKEN` for the run.
  - **You're running against a production server** — the bypass is
    deliberately inert there, by design; don't raise the production limits to
    work around it.

## Test accounts (`npm run seed:test`)

For the testing phase, `seed:test` inserts a hardcoded superadmin, a registrar, two
rank-2 office accounts (HR, OSS), three students, and two staff members. Each
student/staff person is a `Person` (profile + RFID) linked to a `User` login whose
**username is the student/employee number**. The HR and OSS accounts have no linked
`Person` — they are office logins, not people.

| Role | Username | Password |
|------|----------|----------|
| Superadmin | `testadmin` | `Admin@123` |
| Registrar | `testregistrar` | `Registrar@123` |
| HR | `testhr` | `Hr@12345` |
| OSS | `testoss` | `Oss@12345` |
| Student — Juan Dela Cruz | `2025-0001` | `Student@123` |
| Student — Maria Santos | `2025-0002` | `Student@123` |
| Student — Pedro Reyes | `2025-0003` | `Student@123` |
| Staff — Ana Villanueva | `EMP-1001` | `Staff@123` |
| Staff — Bea Ramos | `EMP-1002` | *(no login — Person only, for cross-domain checks)* |

> Demo credentials for local testing only.

### Gate terminals

Each of the four gates has a fixed `type` (person/vehicle) and `direction`
(entry/exit). A terminal authenticates with a per-gate device key sent as
`X-Gate-Key`; the server derives the gate and direction from the key, so a
terminal posts only `{ rfid_uid }`.

- `POST /gates/:id/key` (superadmin) mints a key and revokes that gate's
  previous ones. The plaintext is returned once and is not recoverable.
- `npm run seed:test` prints one key per gate for local development the first
  time it runs; on later runs it skips minting for any gate that already has
  an active key, so it prints nothing for gates it has already provisioned.
- `npm run verify:gates` asserts the photo pipeline and gate behavior. It mints
  its own keys, so terminals provisioned beforehand need re-provisioning after.

### Photos

`POST /persons/:id/photo` (registrar/superadmin, multipart field `photo`, 1MB
cap) stores bytes in the `personphotos` collection and sets `photo_url` to
`/persons/<id>/photo`. Uploads are classified by magic bytes, not by the
declared Content-Type. `GET /persons/:id/photo` accepts a user JWT or a gate
key.

### Attendance date bucketing (local time, not UTC)

`scanService.dateKey()` buckets attendance by the **server's local calendar
date** (`Date#getFullYear/getMonth/getDate`), and `isLate()` compares against
`LATE_CUTOFF_TIME` in local hours via `Date#setHours`. Neither uses UTC.

Any consumer that computes "today" in UTC — for example
`new Date().toISOString().slice(0, 10)` — will compute a different calendar
day than the server for part of every day in any timezone that isn't UTC+0,
and will silently query the wrong attendance bucket. This is not a corner
case: it caused a real intermittent test failure during development. When
building a client, script, or test against `/attendance`, derive the date
key the same way the server does (local `Date` components), never via
`toISOString()`.

The same bug class applies to `OCCUPANCY_RESET_TIME` (default `23:00`).
`lastResetBoundary()` interprets it in the server's **local** time via
`Date#setHours`, exactly like `isLate()` above — never UTC. This is not a
cosmetic difference: on a host running with `TZ=UTC` and the default left
untouched, the boundary resolves to 07:00 Manila — inside the morning
arrival rush. Every card that tapped between roughly 05:00 and 07:00 has
`since` before that boundary once it passes, so the lazy-expiry check on the
next read treats it as outside and grants a free re-entry — a passback
window opening every single morning, with no log line and no alert. It is
invisible to `npm run verify:passback` because that harness computes its
expectations from the same local clock it is testing, so a wrong host
timezone shifts both sides together. Deployments MUST either set
`TZ=Asia/Manila` (or the correct campus timezone) or knowingly accept that
window — do not leave a UTC host on the default.

The same bug class applies to `SCHOOL_YEAR_END_MMDD` (default `03-31`).
`nextSchoolYearEnd()` in `src/utils/schoolYear.ts` builds the expiry date from
local `Date` components — never `toISOString()` or `Date.UTC` — so a vehicle
pass stays valid through the end of the local calendar day it expires on,
matching how `isLate()` and `lastResetBoundary()` bucket by the server's local
clock. A malformed value fails closed at startup (see `env.ts`) rather than
silently becoming an Invalid Date that would let every pass expire immediately
or never. Startup validation also rejects a syntactically valid but
non-existent calendar date (e.g. `02-30`, `04-31`) — the regex alone can't
catch these because `new Date(year, 1, 30)` doesn't throw, it silently
normalises to March 2, which is the same silent-corruption failure mode
through a different door. `02-29` is rejected too: `nextSchoolYearEnd()` has
no leap-year awareness, so accepting it would let the date silently roll to
March 1 in three years out of four.

`npm run verify:roles` cannot actually exercise the local-vs-UTC distinction
above on a host running at UTC+0, because at a zero offset `Date.UTC(...)`
and local `Date` construction produce the identical instant — a regression to
UTC would go completely undetected and the harness would report false
confidence. The harness therefore fails loudly first if it detects a zero
timezone offset, rather than silently passing checks that prove nothing. This
is a real risk in practice: most CI runners and default Docker images run
`TZ=UTC`. Do not "fix" this by setting `TZ` only for the `verify:*` npm
scripts — several checks in this harness compare dates the server itself
bucketed, so the harness and the server must keep agreeing on local time, and
pinning `TZ` for only one side would introduce a mismatch worse than the
blind spot. Set `TZ=Asia/Manila` (or the correct campus timezone) for the
whole environment, as already required above for `OCCUPANCY_RESET_TIME`.

## Data model

- **Person** — a student/staff/employee profile with an `rfid_uid` and `id_number`.
- **User** — a login account with one of four roles: `superadmin` (full control,
  including single and bulk activate/deactivate), `registrar` (registers people and
  creates their logins), `staff`, and `student` (own profile only). A person's login
  links to their profile via `person_id`.
- **Vehicle**, **Gate**, **ScanLog**, **AttendanceSummary** — RFID and attendance records.

## API overview

All routes are prefixed with `API_PREFIX` (default `/api`).

| Area | Base path | Notes |
|------|-----------|-------|
| Auth | `/api/auth` | `POST /login`, `POST /refresh`, `POST /logout` |
| Persons | `/api/persons` | CRUD for people |
| Vehicles | `/api/vehicles` | CRUD for vehicles |
| Gates | `/api/gates` | Gate management |
| Scan | `/api/scan` | RFID scan ingestion |
| Attendance | `/api/attendance` | Attendance records |
| Users | `/api/users` | User account management (admin). `POST /users` requires an explicit `role` — it has no default. |
| Logs | `/api/logs` | Scan/audit logs |
| Dashboard | `/api/dashboard` | Role-aware summary (admin stats vs. student view) |
| Reports | `/api/reports` | Reporting endpoints |

### Auth flow

`POST /api/auth/login` with `{ "username", "password" }` returns:

```json
{ "success": true, "data": { "accessToken": "<jwt>", "user": { "id", "username", "role", "personId", "mustChangePassword" } } }
```

Send the access token as `Authorization: Bearer <accessToken>` on protected routes.

## Project structure

```
src/
  app.ts            # Express app + middleware wiring
  server.ts         # bootstrap / listen
  config/           # env, db, seed, testSeed
  constants/        # roles, error codes
  middlewares/      # auth, validation, rate limiting, errors
  modules/          # feature modules (auth, persons, vehicles, gates, scan, ...)
  utils/            # ApiError, ApiResponse, pagination helpers
```

Each module follows a `routes → controller → service → repository → model` layering.

## Notes

- No public registration. The superadmin is seeded; registrars and user logins are created through the API.
- Access token (15m) in response body; refresh token (7d) in httpOnly cookie with rotation.
- `scan/tap` always returns HTTP 200; `granted`/`denied` is in the body.
- After first seed, remove `ADMIN_PASSWORD` from the production `.env`.
