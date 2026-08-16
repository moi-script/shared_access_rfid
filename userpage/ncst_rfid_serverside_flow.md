# NCST Centralized RFID System — Backend API

> TypeScript + Express + MongoDB (Atlas M10) · Industry-grade structure · No public registration

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Architecture Overview](#2-architecture-overview)
3. [Project Structure](#3-project-structure)
4. [Database Schema](#4-database-schema)
5. [Authentication & Authorization](#5-authentication--authorization)
6. [Security Practices](#6-security-practices)
7. [API Reference](#7-api-reference)
8. [Error Handling](#8-error-handling)
9. [Environment Configuration](#9-environment-configuration)
10. [Getting Started](#10-getting-started)
11. [Good Practices Checklist](#11-good-practices-checklist)

---

## 1. Project Overview

This backend powers the NCST campus RFID gate system. It handles:

- **RFID tap processing** — real-time entry/exit scan events from physical gates
- **Attendance tracking** — daily rollup per student/staff into `attendance_summary`
- **Person & vehicle registration** — managed exclusively by admins
- **System logs & reports** — full audit trail via `scan_logs`
- **Dashboard data** — aggregate stats for admins, personal view for linked user accounts

**No public registration exists.** All accounts are created by an admin. Admin credentials are seeded privately and never exposed through any API endpoint.

---

## 2. Architecture Overview

```
Client (Web / Mobile)
        │
        ▼
  [ HTTPS + JWT ]
        │
        ▼
  Express API Server (TypeScript)
        │
   ┌────┴────┐
   │         │
Route     Middleware
Layer     (auth, validation,
   │       rate-limit, logger)
   │
Service Layer
   │  (business logic, no DB calls here)
   │
Repository Layer
   │  (all MongoDB queries isolated here)
   │
MongoDB Atlas M10
(mongoose ODM)
```

### Key Decisions

| Decision | Rationale |
|---|---|
| Layered architecture (Route → Service → Repository) | Keeps business logic testable and DB-agnostic |
| JWT access + refresh token pair | Short-lived access tokens (15 min), long-lived refresh (7 days) stored in httpOnly cookie |
| Admin seeded, not registered | Admin is a private entity — no `/register` endpoint exists anywhere |
| Role checked at middleware level | `authorize('admin')` or `authorize('user')` guard applied per route group |
| TTL index on `scan_logs` | Keeps M10 storage capped — logs auto-expire after 2 years |
| `attendance_summary` as read cache | Dashboards query this, never raw `scan_logs` |

---

## 3. Project Structure

```
ncst-rfid-backend/
├── src/
│   ├── config/
│   │   ├── db.ts                  # MongoDB Atlas connection
│   │   ├── env.ts                 # Validated env vars (zod)
│   │   └── seed.ts                # Admin account seeder (run once, private)
│   │
│   ├── constants/
│   │   ├── roles.ts               # ROLES enum: 'admin' | 'user'
│   │   └── errors.ts              # Centralized error codes + messages
│   │
│   ├── middlewares/
│   │   ├── authenticate.ts        # Verifies JWT, attaches req.user
│   │   ├── authorize.ts           # Role guard factory: authorize('admin')
│   │   ├── validate.ts            # Zod schema validation middleware
│   │   ├── rateLimiter.ts         # Per-route rate limiting (express-rate-limit)
│   │   ├── errorHandler.ts        # Global error handler
│   │   └── requestLogger.ts       # Morgan + structured log output
│   │
│   ├── modules/
│   │   ├── auth/
│   │   │   ├── auth.routes.ts
│   │   │   ├── auth.controller.ts
│   │   │   ├── auth.service.ts
│   │   │   └── auth.schema.ts     # Zod: login body
│   │   │
│   │   ├── persons/
│   │   │   ├── persons.routes.ts
│   │   │   ├── persons.controller.ts
│   │   │   ├── persons.service.ts
│   │   │   ├── persons.repository.ts
│   │   │   ├── persons.model.ts   # Mongoose model
│   │   │   └── persons.schema.ts  # Zod: create/update body
│   │   │
│   │   ├── vehicles/
│   │   │   └── ...                # Same structure as persons
│   │   │
│   │   ├── gates/
│   │   │   └── ...
│   │   │
│   │   ├── scan/
│   │   │   ├── scan.routes.ts
│   │   │   ├── scan.controller.ts
│   │   │   ├── scan.service.ts    # Core tap logic + attendance rollup
│   │   │   ├── scan.repository.ts
│   │   │   └── scan.model.ts
│   │   │
│   │   ├── attendance/
│   │   │   └── ...
│   │   │
│   │   ├── users/
│   │   │   └── ...                # Admin-only: create/manage user accounts
│   │   │
│   │   ├── logs/
│   │   │   └── ...                # Admin-only: query scan_logs
│   │   │
│   │   └── dashboard/
│   │       ├── dashboard.routes.ts
│   │       ├── dashboard.controller.ts
│   │       └── dashboard.service.ts  # Branches on role: admin vs user
│   │
│   ├── utils/
│   │   ├── asyncHandler.ts        # Wraps async controllers, catches errors
│   │   ├── ApiResponse.ts         # Standardized response shape
│   │   ├── ApiError.ts            # Custom error class
│   │   └── pagination.ts          # Cursor-based pagination helper
│   │
│   ├── types/
│   │   ├── express.d.ts           # Extends Request: req.user
│   │   └── index.ts               # Shared types
│   │
│   └── app.ts                     # Express app setup (no listen here)
│   └── server.ts                  # listen(), graceful shutdown
│
├── .env.example
├── .env                           # Never committed
├── tsconfig.json
├── package.json
└── README.md
```

---

## 4. Database Schema

All models mirror the PostgreSQL schema converted to MongoDB (Mongoose). Key collections:

### `persons`
```ts
{
  _id: ObjectId,
  full_name: string,           // required
  type: 'student' | 'staff' | 'employee',
  id_number: string,           // e.g. "2021-00142"
  department_section: string,  // e.g. "BSIT-3A"
  contact_email: string,
  photo_url: string,
  rfid_uid: string,            // unique — the physical card UID
  status: 'active' | 'inactive',
  createdAt: Date,
  updatedAt: Date
}
```
**Indexes:** `rfid_uid` (unique), `id_number`, `status`

**Dummy sample:**
```json
{
  "full_name": "Juan dela Cruz",
  "type": "student",
  "id_number": "2021-00142",
  "department_section": "BSIT-3A",
  "contact_email": "juan.delacruz@ncst.edu.ph",
  "rfid_uid": "A3F9C2D1",
  "status": "active"
}
```

### `users`
```ts
{
  _id: ObjectId,
  username: string,            // unique — e.g. "jdelacruz" or "admin"
  password_hash: string,       // bcrypt, rounds: 12
  role: 'admin' | 'user',
  person_id: ObjectId | null,  // null = guard/unlinked; ObjectId = student/staff
  createdAt: Date
}
```
> Admin accounts are seeded via `src/config/seed.ts`. No API endpoint creates an admin.

**Dummy sample (student account):**
```json
{
  "username": "jdelacruz",
  "role": "user",
  "person_id": "<persons._id of Juan dela Cruz>"
}
```

**Dummy sample (guard account — no person link):**
```json
{
  "username": "guard.gate1",
  "role": "user",
  "person_id": null
}
```

### `vehicles`
```ts
{
  _id: ObjectId,
  owner_person_id: ObjectId,   // ref: persons
  plate_number: string,        // unique — e.g. "ABC-1234"
  vehicle_type: string,        // "motorcycle" | "car" | "bicycle"
  vehicle_model: string,       // "Honda Click 125i"
  photo_url: string,
  status: 'active' | 'inactive',
  createdAt: Date
}
```
**Index:** `owner_person_id` (unique — one vehicle per person at MVP)

**Dummy sample:**
```json
{
  "plate_number": "ABC-1234",
  "vehicle_type": "motorcycle",
  "vehicle_model": "Honda Click 125i",
  "status": "active",
  "owner_person_id": "<persons._id of Juan dela Cruz>"
}
```

### `gates`
```ts
{
  _id: ObjectId,
  name: string,                // "Main Entrance"
  type: 'person' | 'vehicle',
  location: string             // "Front Building, Gate A"
}
```
**Seeded data (4 fixed gates):**
```json
[
  { "name": "Main Entrance",     "type": "person",  "location": "Front Building Gate A" },
  { "name": "Side Gate",         "type": "person",  "location": "South Wing Gate B"     },
  { "name": "Parking Entrance",  "type": "vehicle", "location": "Parking Lot Entry"     },
  { "name": "Parking Exit",      "type": "vehicle", "location": "Parking Lot Exit"      }
]
```

### `scan_logs`
```ts
{
  _id: ObjectId,
  rfid_uid: string,
  entity_type: 'person' | 'vehicle',
  entity_id: ObjectId | null,  // null if unregistered UID
  gate_id: ObjectId,
  direction: 'entry' | 'exit',
  access_result: 'granted' | 'denied',
  reason: string | null,       // "unregistered_uid" | "inactive_id" | null
  scan_time: Date              // ← TTL index on this field
}
```
**Indexes:** `scan_time` (TTL: 2 years), `rfid_uid`, `entity_type + entity_id`

**Dummy sample:**
```json
{
  "rfid_uid": "A3F9C2D1",
  "entity_type": "person",
  "entity_id": "<persons._id of Juan dela Cruz>",
  "gate_id": "<gates._id of Main Entrance>",
  "direction": "entry",
  "access_result": "granted",
  "reason": null,
  "scan_time": "2025-01-15T07:42:13.000Z"
}
```

### `attendance_summary`
```ts
{
  _id: ObjectId,
  person_id: ObjectId,
  date: Date,                  // date-only, no time
  time_in: Date | null,
  time_out: Date | null,
  status: 'present' | 'late' | 'absent'
}
```
**Index:** `person_id + date` (unique compound)

**Dummy sample:**
```json
{
  "person_id": "<persons._id of Juan dela Cruz>",
  "date": "2025-01-15",
  "time_in": "2025-01-15T07:42:13.000Z",
  "time_out": "2025-01-15T17:05:44.000Z",
  "status": "present"
}
```

---

## 5. Authentication & Authorization

### Flow

```
POST /api/auth/login
  └─ validate body (username + password)
  └─ find user in DB → compare bcrypt hash
  └─ issue accessToken (JWT, 15min) → response body
  └─ issue refreshToken (JWT, 7d)   → httpOnly cookie

GET /api/* (protected routes)
  └─ authenticate middleware
      └─ reads Authorization: Bearer <accessToken>
      └─ verifies JWT signature + expiry
      └─ attaches { userId, role, personId } to req.user

POST /api/auth/refresh
  └─ reads refreshToken from httpOnly cookie
  └─ verifies + issues new accessToken

POST /api/auth/logout
  └─ clears httpOnly cookie
```

### Role Matrix

| Endpoint group | admin | user (linked) | user (unlinked / guard) |
|---|:---:|:---:|:---:|
| `POST /scan/tap` | ✓ | ✓ | ✓ |
| `GET /dashboard` | Full stats | Own data only | Gate status only |
| `GET /persons` | ✓ | — | — |
| `POST /persons` | ✓ | — | — |
| `GET /vehicles` | ✓ | — | — |
| `POST /vehicles` | ✓ | — | — |
| `GET /logs` | ✓ | — | — |
| `GET /reports` | ✓ | — | — |
| `POST /users` | ✓ | — | — |
| `GET /attendance` | All records | Own only | — |

### JWT Payload Shape
```ts
interface JwtPayload {
  sub: string;      // users._id
  role: 'admin' | 'user';
  personId: string | null;
  iat: number;
  exp: number;
}
```

### Middleware Usage
```ts
// Admin-only route
router.get('/logs', authenticate, authorize('admin'), logsController.getAll);

// Any authenticated user
router.post('/scan/tap', authenticate, scanController.tap);

// Dashboard — role branching happens inside the service
router.get('/dashboard', authenticate, dashboardController.get);
```

### Admin Seeder
```ts
// src/config/seed.ts — run once with: npx ts-node src/config/seed.ts
// Never called by any API route.

await User.create({
  username: process.env.ADMIN_USERNAME,
  password_hash: await bcrypt.hash(process.env.ADMIN_PASSWORD, 12),
  role: 'admin',
  person_id: null,
});
```

> `ADMIN_USERNAME` and `ADMIN_PASSWORD` live in `.env` only. Rotate after first login.

---

## 6. Security Practices

### Transport & Headers
- HTTPS enforced in production (terminate at load balancer or use `helmet` HSTS)
- `helmet` sets secure HTTP headers on every response
- `cors` configured with explicit `origin` whitelist — no wildcard in production

### Authentication
- Passwords hashed with **bcrypt, cost factor 12**
- Access tokens expire in **15 minutes**
- Refresh tokens stored in **httpOnly, Secure, SameSite=Strict** cookie — inaccessible to JS
- JWT signed with **RS256** (asymmetric) in production; HS256 acceptable in dev
- Refresh token **rotation** — each use issues a new refresh token and invalidates the old one (stored hash in DB)

### Input Validation
- Every request body validated with **Zod** before reaching the controller
- MongoDB query parameters sanitized — no raw user input passed to `$where` or `$regex` without anchoring
- `rfid_uid` on scan tap validated as hex string pattern only

### Rate Limiting
```ts
// Gate tap endpoint — physical hardware calls this
scanLimiter: 60 requests/minute per IP

// Auth login — prevent brute force
loginLimiter: 10 requests/15 minutes per IP

// General API
globalLimiter: 200 requests/minute per IP
```

### Database
- MongoDB user has **least-privilege** role: `readWrite` on the RFID DB only — no `dbAdmin` or `clusterAdmin`
- Atlas IP Access List: only the app server IP is whitelisted — no open `0.0.0.0/0`
- Connection string stored in `.env` only, never hardcoded
- TTL index on `scan_logs.scan_time` (2 years) — prevents unbounded storage growth

### Logging & Audit
- `morgan` for HTTP request logs (combined format in production)
- All `scan_logs` writes are immutable — no update or delete endpoint exists for logs
- Admin actions (person/vehicle create, update, deactivate) logged with `performed_by` field
- Errors logged with stack traces server-side; clients receive only safe error codes

### Secrets
- `.env` never committed (`.gitignore`)
- `.env.example` committed with placeholder values only
- Rotate `JWT_SECRET` and `ADMIN_PASSWORD` on any suspected exposure

---

## 7. API Reference

All responses follow this envelope:

```ts
// Success
{ "success": true, "data": <payload>, "meta"?: { pagination } }

// Error
{ "success": false, "code": "ERROR_CODE", "message": "Human readable" }
```

---

### Auth

#### `POST /api/auth/login`
No auth required.
```json
// Body
{ "username": "jdelacruz", "password": "••••••••" }

// Response 200
{
  "success": true,
  "data": {
    "accessToken": "<jwt>",
    "user": { "id": "...", "username": "jdelacruz", "role": "user", "personId": "..." }
  }
}
```

#### `POST /api/auth/refresh`
Reads `refreshToken` from httpOnly cookie.
```json
// Response 200
{ "success": true, "data": { "accessToken": "<new_jwt>" } }
```

#### `POST /api/auth/logout`
Clears the refresh token cookie.

---

### Scan (Gate Tap)

#### `POST /api/scan/tap`
Called by gate hardware on every RFID scan. Authenticated (any role).
```json
// Body
{
  "rfid_uid": "A3F9C2D1",
  "gate_id": "<gates._id>",
  "direction": "entry"
}

// Response 200 — granted
{
  "success": true,
  "data": {
    "access_result": "granted",
    "person": { "full_name": "Juan dela Cruz", "type": "student", "photo_url": "..." },
    "scan_time": "2025-01-15T07:42:13.000Z"
  }
}

// Response 200 — denied
{
  "success": true,
  "data": {
    "access_result": "denied",
    "reason": "inactive_id",
    "scan_time": "2025-01-15T07:42:13.000Z"
  }
}
```
> Always returns HTTP 200 for tap results — denied is a valid business outcome, not an error.

#### `GET /api/scan/logs` · Admin only
```
Query: ?page=1&limit=50&gate_id=&direction=entry&from=2025-01-01&to=2025-01-31
```

---

### Persons · Admin only

#### `GET /api/persons`
```
Query: ?page=1&limit=20&type=student&status=active&search=Juan
```

#### `GET /api/persons/:id`

#### `POST /api/persons`
```json
{
  "full_name": "Maria Santos",
  "type": "student",
  "id_number": "2022-00388",
  "department_section": "BSCS-2B",
  "contact_email": "maria.santos@ncst.edu.ph",
  "rfid_uid": "B7E2A1F4",
  "status": "active"
}
```

#### `PATCH /api/persons/:id`
Partial update. Cannot update `rfid_uid` via this endpoint — use dedicated reassign endpoint.

#### `PATCH /api/persons/:id/status`
Activate or deactivate a person.
```json
{ "status": "inactive" }
```

#### `PATCH /api/persons/:id/rfid`
Reassign RFID card (lost/replaced).
```json
{ "rfid_uid": "C9D3B2A8" }
```

---

### Vehicles · Admin only

#### `GET /api/vehicles`
#### `GET /api/vehicles/:id`
#### `POST /api/vehicles`
```json
{
  "owner_person_id": "<persons._id>",
  "plate_number": "XYZ-9988",
  "vehicle_type": "motorcycle",
  "vehicle_model": "Yamaha Mio i 125",
  "status": "active"
}
```
#### `PATCH /api/vehicles/:id`
#### `PATCH /api/vehicles/:id/status`

---

### Users · Admin only

> No registration endpoint. Admin creates all accounts here.

#### `GET /api/users`
#### `POST /api/users`
```json
{
  "username": "msantos",
  "password": "TemporaryPass@2025",
  "role": "user",
  "person_id": "<persons._id>"   // null for guard accounts
}
```
> Password must be changed on first login (enforced by `must_change_password: true` flag).

#### `PATCH /api/users/:id/password` · Admin resets a user's password
#### `DELETE /api/users/:id` · Soft-delete (sets `is_active: false`)

---

### Dashboard

#### `GET /api/dashboard`
Role-branched — same endpoint, different payload.

**Admin response:**
```json
{
  "success": true,
  "data": {
    "total_persons": 37000,
    "active_today": 24812,
    "total_vehicles": 11100,
    "scan_events_today": 96200,
    "denied_today": 43,
    "gates": [
      { "name": "Main Entrance", "last_scan": "2025-01-15T08:03:11Z", "status": "online" }
    ]
  }
}
```

**User (linked) response:**
```json
{
  "success": true,
  "data": {
    "person": { "full_name": "Juan dela Cruz", "status": "active" },
    "today": { "time_in": "07:42:13", "time_out": null, "status": "present" },
    "recent_attendance": [ ... ],
    "vehicle": { "plate_number": "ABC-1234", "status": "active" }
  }
}
```

---

### Attendance · Admin: all | User: own only

#### `GET /api/attendance`
```
Query (admin): ?person_id=&from=2025-01-01&to=2025-01-31&status=present
Query (user):  from/to only — person_id is taken from req.user.personId
```

#### `GET /api/attendance/summary/:person_id` · Admin only

---

### Reports · Admin only

#### `GET /api/reports/attendance`
```
Query: ?from=&to=&department_section=&type=student&format=json
```

#### `GET /api/reports/gate-activity`
```
Query: ?gate_id=&from=&to=
```

---

## 8. Error Handling

All errors flow through `src/middlewares/errorHandler.ts`.

### Error Codes

| Code | HTTP | Meaning |
|---|---|---|
| `INVALID_CREDENTIALS` | 401 | Wrong username or password |
| `TOKEN_EXPIRED` | 401 | Access token expired — client should refresh |
| `TOKEN_INVALID` | 401 | Malformed or tampered token |
| `FORBIDDEN` | 403 | Valid token but insufficient role |
| `NOT_FOUND` | 404 | Resource does not exist |
| `VALIDATION_ERROR` | 422 | Request body failed Zod schema |
| `DUPLICATE_RFID` | 409 | `rfid_uid` already registered |
| `DUPLICATE_PLATE` | 409 | `plate_number` already registered |
| `INACTIVE_PERSON` | 200 | Tap denied — person is inactive |
| `UNREGISTERED_UID` | 200 | Tap denied — UID not in system |
| `RATE_LIMITED` | 429 | Too many requests |
| `INTERNAL_ERROR` | 500 | Unhandled server error |

### ApiError class
```ts
// Usage in service layer:
throw new ApiError(404, 'NOT_FOUND', 'Person not found');
```

---

## 9. Environment Configuration

```bash
# .env.example

# App
NODE_ENV=development
PORT=3000
API_PREFIX=/api

# MongoDB
MONGODB_URI=mongodb+srv://<user>:<pass>@cluster.mongodb.net/ncst_rfid?retryWrites=true&w=majority

# JWT
JWT_ACCESS_SECRET=change_me_to_random_256bit_string
JWT_REFRESH_SECRET=change_me_to_different_random_256bit_string
JWT_ACCESS_EXPIRES_IN=15m
JWT_REFRESH_EXPIRES_IN=7d

# Admin seed (used once, then remove from env)
ADMIN_USERNAME=admin
ADMIN_PASSWORD=StrongAdminPass@2025!

# CORS
ALLOWED_ORIGINS=http://localhost:5173,https://ncst-rfid.yourdomain.com

# Rate limiting
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX=200
LOGIN_RATE_LIMIT_MAX=10
SCAN_RATE_LIMIT_MAX=60

# Cookie
COOKIE_SECRET=change_me_to_random_string
```

---

## 10. Getting Started

### Prerequisites
- Node.js ≥ 20
- MongoDB Atlas M10 cluster (connection string ready)
- npm or pnpm

### Install
```bash
git clone <repo>
cd ncst-rfid-backend
npm install
cp .env.example .env
# Fill in .env values
```

### Seed the database
```bash
# Creates admin account + 4 fixed gates
npx ts-node src/config/seed.ts
```
> Run this **once only**. After seeding, remove `ADMIN_USERNAME` and `ADMIN_PASSWORD` from production `.env`.

### Development
```bash
npm run dev        # ts-node-dev with hot reload
```

### Production build
```bash
npm run build      # tsc → dist/
npm start          # node dist/server.js
```

### Scripts
```json
{
  "dev":    "ts-node-dev --respawn src/server.ts",
  "build":  "tsc",
  "start":  "node dist/server.js",
  "seed":   "ts-node src/config/seed.ts",
  "lint":   "eslint src --ext .ts",
  "test":   "jest"
}
```

### Recommended packages
```json
{
  "dependencies": {
    "express": "^4.18",
    "mongoose": "^8",
    "bcrypt": "^5",
    "jsonwebtoken": "^9",
    "zod": "^3",
    "helmet": "^7",
    "cors": "^2",
    "morgan": "^1",
    "express-rate-limit": "^7",
    "cookie-parser": "^1",
    "dotenv": "^16"
  },
  "devDependencies": {
    "typescript": "^5",
    "@types/express": "^4",
    "@types/bcrypt": "^5",
    "@types/jsonwebtoken": "^9",
    "@types/morgan": "^1",
    "@types/cookie-parser": "^1",
    "ts-node-dev": "^2",
    "eslint": "^8",
    "@typescript-eslint/eslint-plugin": "^6"
  }
}
```

---

## 11. Good Practices Checklist

### Structure
- [x] Route → Controller → Service → Repository layers (no DB calls in controllers)
- [x] Each module is self-contained (routes, controller, service, repo, model, schema)
- [x] `asyncHandler` wrapper on all async controllers — no try/catch repetition
- [x] Global error handler as the last Express middleware
- [x] `req.user` typed via Express namespace extension (`types/express.d.ts`)

### Security
- [x] No `/register` endpoint — accounts are admin-created only
- [x] Admin is seeded privately, never created via API
- [x] Passwords bcrypt-hashed (rounds: 12)
- [x] JWT access token (15 min) + httpOnly refresh cookie (7 days)
- [x] Refresh token rotation — old token invalidated on use
- [x] `helmet` on every response
- [x] `cors` with explicit origin whitelist
- [x] Zod validation on every request body
- [x] Rate limiting on login and scan tap endpoints
- [x] Least-privilege MongoDB Atlas user
- [x] Atlas IP access list restricted to app server only
- [x] `.env` in `.gitignore` — secrets never committed

### Database
- [x] TTL index on `scan_logs.scan_time` (2 years) — storage stays capped on M10
- [x] Unique index on `rfid_uid` — prevents duplicate card registration
- [x] Compound unique index on `attendance_summary (person_id, date)`
- [x] Unique index on `vehicles.owner_person_id` (one vehicle per person, MVP)
- [x] `attendance_summary` used as read cache — dashboards never query raw `scan_logs`

### API Design
- [x] Consistent response envelope: `{ success, data, meta? }` or `{ success, code, message }`
- [x] HTTP 200 for tap results (denied is a valid outcome, not an HTTP error)
- [x] `PATCH` for partial updates, never `PUT` on partial fields
- [x] Pagination on all list endpoints (cursor or offset+limit)
- [x] Scan logs are immutable — no update/delete endpoint
- [x] Dashboard branches on `req.user.role` in the service layer

### Client Integration
- [x] All protected endpoints require `Authorization: Bearer <accessToken>` header
- [x] Client stores `accessToken` in memory (not localStorage)
- [x] Client calls `POST /auth/refresh` automatically on 401 `TOKEN_EXPIRED`
- [x] Refresh token sent automatically via cookie — no client handling needed
- [x] Gate hardware authenticates once and reuses the token until expiry
