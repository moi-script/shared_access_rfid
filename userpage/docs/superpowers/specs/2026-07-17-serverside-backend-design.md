# NCST RFID Serverside Backend — Design Spec

**Date:** 2026-07-17
**Source doc:** `ncst_rfid_serverside_flow.md` (backend API blueprint)
**Target location:** `C:\thesis_rfid\serverside` (currently empty; not a git repo)

---

## 1. Goal

Build the complete NCST campus RFID gate backend from the blueprint doc: a
TypeScript + Express + Mongoose (MongoDB Atlas M10) API with a layered
architecture, admin-seeded accounts, no public registration, and role-based
access for admins and users.

## 2. Scope (this pass)

**In scope — full backend, all 10 modules with real logic:**
auth, persons, vehicles, gates, scan, attendance, users, logs, dashboard, reports.

**Explicitly out of scope (YAGNI / deferred):**
- Automated tests (Jest) — deferred to a later pass.
- RS256 JWT — using HS256 shared secret for now (doc allows this for dev).
- Live DB run — code + `.env.example` only; user supplies `.env` and runs seed.
- CSV/PDF report export — reports return JSON only.
- WebSocket / real-time gate status — gate "status" is derived from last scan time.

## 3. Stack

- Node.js ≥ 20, TypeScript ^5
- Express ^4, Mongoose ^8
- Zod (validation + env parsing), bcrypt (rounds 12), jsonwebtoken ^9 (HS256)
- helmet, cors, morgan, express-rate-limit, cookie-parser, dotenv
- Dev: ts-node-dev, eslint, @typescript-eslint

## 4. Architecture

Layered: `Route → Controller → Service → Repository → Mongoose`.

- **Controllers** never touch the DB; wrapped in `asyncHandler`.
- **Services** hold business logic, no direct Mongoose queries.
- **Repositories** isolate all Mongoose queries.
- `app.ts` builds the Express app (middleware + routes, no `listen`).
- `server.ts` connects DB, calls `listen()`, handles graceful shutdown (SIGINT/SIGTERM).

Middleware order: helmet → cors → cookie-parser → json body → requestLogger →
routes → notFound → global errorHandler.

## 5. Project structure

```
ncst-rfid-backend/
├── src/
│   ├── config/          db.ts, env.ts (zod-validated), seed.ts
│   ├── constants/       roles.ts, errors.ts
│   ├── middlewares/     authenticate, authorize, validate, rateLimiter,
│   │                    errorHandler, requestLogger, notFound
│   ├── modules/
│   │   ├── auth/        routes, controller, service, schema
│   │   ├── persons/     routes, controller, service, repository, model, schema
│   │   ├── vehicles/    (same shape as persons)
│   │   ├── gates/       routes, controller, service, repository, model
│   │   ├── scan/        routes, controller, service, repository, model, schema
│   │   ├── attendance/  routes, controller, service, repository, model
│   │   ├── users/       routes, controller, service, repository, model, schema
│   │   ├── logs/        routes, controller, service (queries scan_logs)
│   │   └── dashboard/   routes, controller, service (role-branched)
│   ├── utils/           asyncHandler, ApiResponse, ApiError, pagination
│   ├── types/           express.d.ts (req.user), index.ts
│   ├── app.ts
│   └── server.ts
├── .env.example
├── .gitignore
├── tsconfig.json
└── package.json
```

## 6. Data models (Mongoose)

Collections and fields per doc section 4, with the following resolved gaps:

### persons
`full_name, type('student'|'staff'|'employee'), id_number, department_section,
contact_email, photo_url, rfid_uid, status('active'|'inactive'), timestamps`
Indexes: `rfid_uid` unique, `id_number`, `status`.

### users  *(includes fields the doc references but omits from §4)*
`username (unique), password_hash, role('admin'|'user'), person_id(ObjectId|null),
must_change_password(bool, default true for admin-created accounts),
is_active(bool, default true — soft delete), refreshTokenHash(string|null),
createdAt`
Admin seeded via `config/seed.ts`; no API creates an admin.

### vehicles
`owner_person_id(ref persons), plate_number(unique), rfid_uid(unique),
vehicle_type, vehicle_model, photo_url, status, createdAt`
Index: `owner_person_id` unique (one vehicle per person, MVP), `plate_number` unique,
`rfid_uid` unique.
Vehicles carry their own `rfid_uid` so gate taps resolve vehicles (fallback after
person lookup). Granted vehicle taps log to `scan_logs` but do not touch
`attendance_summary` (attendance is person-only).

### gates
`name, type('person'|'vehicle'), location`
Seeded: 4 fixed gates (Main Entrance, Side Gate, Parking Entrance, Parking Exit).

### scan_logs *(immutable — no update/delete endpoint)*
`rfid_uid, entity_type('person'|'vehicle'), entity_id(ObjectId|null), gate_id,
direction('entry'|'exit'), access_result('granted'|'denied'),
reason(string|null), scan_time(Date)`
Indexes: `scan_time` TTL 2 years, `rfid_uid`, compound `entity_type+entity_id`.

### attendance_summary
`person_id, date(date-only), time_in(Date|null), time_out(Date|null),
status('present'|'late'|'absent')`
Index: compound unique `(person_id, date)`.

## 7. Auth & authorization

- **Login:** validate → find user → bcrypt compare → issue access JWT (15m, HS256,
  response body) + refresh JWT (7d, httpOnly/Secure/SameSite=Strict cookie).
- **Refresh rotation:** store bcrypt hash of current refresh token on
  `users.refreshTokenHash`. On `/auth/refresh`: verify cookie JWT, compare to stored
  hash, issue new access + new refresh, replace stored hash. Old token invalid.
- **Logout:** clear cookie, null out `refreshTokenHash`.
- **JWT payload:** `{ sub, role, personId, iat, exp }`.
- **authenticate** middleware: verify Bearer access token, attach
  `req.user = { userId, role, personId }`.
- **authorize(role)** factory: guards route groups (`authorize('admin')`).
- **Dashboard** does role branching inside the service, not middleware.

### Role matrix (per doc §5)
- `POST /scan/tap` — all authenticated roles.
- `GET /dashboard` — admin: full stats; linked user: own data; unlinked/guard: gate status.
- persons, vehicles, logs, reports, users management, `POST` — admin only.
- attendance — admin: all; linked user: own only (person_id from `req.user`).

## 8. Endpoints (per doc §7)

- **auth:** `POST /login`, `POST /refresh`, `POST /logout`
- **scan:** `POST /tap` (always HTTP 200, granted/denied are business outcomes),
  `GET /logs` (admin, paginated + filters)
- **persons:** GET list (filters), GET :id, POST, PATCH :id, PATCH :id/status,
  PATCH :id/rfid (dedicated reassign) — admin only
- **vehicles:** GET list, GET :id, POST, PATCH :id, PATCH :id/status — admin only
- **users:** GET list, POST (creates user/guard), PATCH :id/password, DELETE :id
  (soft delete `is_active=false`) — admin only
- **dashboard:** GET (role-branched)
- **attendance:** GET (admin all / user own), GET /summary/:person_id (admin)
- **reports:** GET /attendance, GET /gate-activity — admin, JSON only

All list endpoints paginated (offset+limit, via `utils/pagination`).

## 9. Scan/tap logic (core)

On `POST /scan/tap { rfid_uid, gate_id, direction }`:
1. Look up person (then vehicle) by `rfid_uid`.
2. Determine `access_result` + `reason`:
   - not found → denied, `unregistered_uid`, entity_id null
   - found but `status==='inactive'` → denied, `inactive_id`
   - found + active → granted, reason null
3. Write immutable `scan_logs` entry with `scan_time = now`.
4. If granted **and** entity is a person: upsert `attendance_summary` for
   `(person_id, today)` — set `time_in` on first entry of the day, `time_out` on
   exit; compute `status` (present/late) via a configurable late cutoff.
5. Return `{ access_result, person?, reason?, scan_time }` with HTTP 200.

## 10. Error handling

Global handler maps errors to the doc's code table
(`INVALID_CREDENTIALS`, `TOKEN_EXPIRED`, `TOKEN_INVALID`, `FORBIDDEN`, `NOT_FOUND`,
`VALIDATION_ERROR`, `DUPLICATE_RFID`, `DUPLICATE_PLATE`, `RATE_LIMITED`,
`INTERNAL_ERROR`). Error envelope: `{ success:false, code, message }`.
Success envelope: `{ success:true, data, meta? }`. Stack traces logged
server-side only; clients get safe codes.

## 11. Security

helmet on all responses; cors with explicit origin whitelist from env; bcrypt
rounds 12; Zod validation on every body; `rfid_uid` validated as hex pattern;
rate limiters (login 10/15min, scan 60/min, global 200/min); `.env` gitignored;
`.env.example` committed with placeholders.

## 12. Config / env (`.env.example`)

`NODE_ENV, PORT, API_PREFIX, MONGODB_URI, JWT_ACCESS_SECRET, JWT_REFRESH_SECRET,
JWT_ACCESS_EXPIRES_IN, JWT_REFRESH_EXPIRES_IN, ADMIN_USERNAME, ADMIN_PASSWORD,
ALLOWED_ORIGINS, RATE_LIMIT_*, COOKIE_SECRET, LATE_CUTOFF_TIME`
(`LATE_CUTOFF_TIME` added to drive attendance present/late classification.)

## 13. Scripts

`dev` (ts-node-dev), `build` (tsc), `start` (node dist/server.js),
`seed` (ts-node src/config/seed.ts), `lint` (eslint).

## 14. Definition of done (this pass)

- `npm install && npm run build` succeeds with no TS errors.
- All modules present with real controller/service/repository logic.
- Seed script creates admin + 4 gates when run against a real Atlas URI.
- `.env.example` documents every required variable.
- README or the source blueprint covers run instructions.
