# NCST RFID Serverside Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the complete NCST campus RFID gate backend (Express + Mongoose + TypeScript) from the approved design spec.

**Architecture:** Layered `Route → Controller → Service → Repository → Mongoose`. Controllers never query the DB; services hold business logic; repositories isolate Mongoose calls. `app.ts` builds the Express app, `server.ts` connects the DB and listens with graceful shutdown.

**Tech Stack:** Node ≥20, TypeScript ^5, Express ^4, Mongoose ^8, Zod, bcrypt (rounds 12), jsonwebtoken ^9 (HS256), helmet, cors, morgan, express-rate-limit, cookie-parser, dotenv.

## Global Constraints

- All code lives under `C:\thesis_rfid\serverside` (currently empty, not a git repo — Task 1 runs `git init`).
- TypeScript strict mode; every task ends with `npx tsc --noEmit` passing (no tests this pass).
- No public registration endpoint anywhere. Admin is seeded only.
- Response envelope: success `{ success: true, data, meta? }`; error `{ success: false, code, message }`.
- JWT HS256. Access token 15m in response body; refresh token 7d in httpOnly/Secure/SameSite=Strict cookie.
- bcrypt rounds = 12.
- `scan/tap` always returns HTTP 200 (granted/denied are business outcomes).
- `scan_logs` are immutable — no update/delete route.
- `.env` is gitignored; `.env.example` committed with placeholders.
- API base path from `API_PREFIX` env (default `/api`).

---

### Task 1: Project scaffolding

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `.env.example`, `.eslintrc.json`, `src/index-placeholder.ts`

**Interfaces:**
- Produces: buildable TS project; npm scripts `dev`, `build`, `start`, `seed`, `lint`.

- [ ] **Step 1: `git init` and create `package.json`**

```json
{
  "name": "ncst-rfid-backend",
  "version": "1.0.0",
  "main": "dist/server.js",
  "scripts": {
    "dev": "ts-node-dev --respawn --transpile-only src/server.ts",
    "build": "tsc",
    "start": "node dist/server.js",
    "seed": "ts-node src/config/seed.ts",
    "lint": "eslint src --ext .ts"
  },
  "dependencies": {
    "bcrypt": "^5.1.1",
    "cookie-parser": "^1.4.6",
    "cors": "^2.8.5",
    "dotenv": "^16.4.5",
    "express": "^4.19.2",
    "express-rate-limit": "^7.4.0",
    "helmet": "^7.1.0",
    "jsonwebtoken": "^9.0.2",
    "mongoose": "^8.5.0",
    "morgan": "^1.10.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/bcrypt": "^5.0.2",
    "@types/cookie-parser": "^1.4.7",
    "@types/cors": "^2.8.17",
    "@types/express": "^4.17.21",
    "@types/jsonwebtoken": "^9.0.6",
    "@types/morgan": "^1.9.9",
    "@types/node": "^20.14.0",
    "@typescript-eslint/eslint-plugin": "^7.16.0",
    "@typescript-eslint/parser": "^7.16.0",
    "eslint": "^8.57.0",
    "ts-node": "^10.9.2",
    "ts-node-dev": "^2.0.0",
    "typescript": "^5.5.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2021",
    "module": "commonjs",
    "moduleResolution": "node",
    "rootDir": "src",
    "outDir": "dist",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "typeRoots": ["./node_modules/@types", "./src/types"]
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 3: Create `.gitignore`**

```
node_modules/
dist/
.env
*.log
```

- [ ] **Step 4: Create `.eslintrc.json`**

```json
{
  "parser": "@typescript-eslint/parser",
  "plugins": ["@typescript-eslint"],
  "extends": ["eslint:recommended", "plugin:@typescript-eslint/recommended"],
  "parserOptions": { "ecmaVersion": 2021, "sourceType": "module" },
  "env": { "node": true, "es2021": true },
  "rules": { "@typescript-eslint/no-explicit-any": "warn" }
}
```

- [ ] **Step 5: Create `.env.example`**

```bash
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

# Admin seed (used once)
ADMIN_USERNAME=admin
ADMIN_PASSWORD=StrongAdminPass@2025!

# CORS (comma-separated)
ALLOWED_ORIGINS=http://localhost:5173

# Rate limiting
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX=200
LOGIN_RATE_LIMIT_MAX=10
SCAN_RATE_LIMIT_MAX=60

# Cookie
COOKIE_SECRET=change_me_to_random_string

# Attendance
LATE_CUTOFF_TIME=08:00
```

- [ ] **Step 6: Temp placeholder so tsc has input**

Create `src/index-placeholder.ts`:
```ts
export const placeholder = true;
```

- [ ] **Step 7: Install and verify build**

Run: `npm install && npx tsc --noEmit`
Expected: exit 0, no errors.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "chore: scaffold ncst-rfid-backend project"
```

---

### Task 2: Config layer (env + db)

**Files:**
- Create: `src/config/env.ts`, `src/config/db.ts`
- Delete: `src/index-placeholder.ts`

**Interfaces:**
- Produces: `env` (validated config object), `connectDB(): Promise<void>`, `disconnectDB(): Promise<void>`.

- [ ] **Step 1: Create `src/config/env.ts`**

```ts
import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3000),
  API_PREFIX: z.string().default('/api'),
  MONGODB_URI: z.string().min(1),
  JWT_ACCESS_SECRET: z.string().min(1),
  JWT_REFRESH_SECRET: z.string().min(1),
  JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),
  ADMIN_USERNAME: z.string().default('admin'),
  ADMIN_PASSWORD: z.string().default('changeme'),
  ALLOWED_ORIGINS: z.string().default('http://localhost:5173'),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(60000),
  RATE_LIMIT_MAX: z.coerce.number().default(200),
  LOGIN_RATE_LIMIT_MAX: z.coerce.number().default(10),
  SCAN_RATE_LIMIT_MAX: z.coerce.number().default(60),
  COOKIE_SECRET: z.string().default('cookie_secret'),
  LATE_CUTOFF_TIME: z.string().default('08:00'),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = {
  ...parsed.data,
  ALLOWED_ORIGINS_LIST: parsed.data.ALLOWED_ORIGINS.split(',').map((o) => o.trim()),
  isProd: parsed.data.NODE_ENV === 'production',
};
```

- [ ] **Step 2: Create `src/config/db.ts`**

```ts
import mongoose from 'mongoose';
import { env } from './env';

export async function connectDB(): Promise<void> {
  mongoose.set('strictQuery', true);
  await mongoose.connect(env.MONGODB_URI);
  console.log('[db] connected to MongoDB');
}

export async function disconnectDB(): Promise<void> {
  await mongoose.disconnect();
  console.log('[db] disconnected');
}
```

- [ ] **Step 3: Remove placeholder**

Delete `src/index-placeholder.ts`.

- [ ] **Step 4: Verify build**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: add validated env config and db connection"
```

---

### Task 3: Constants and utils

**Files:**
- Create: `src/constants/roles.ts`, `src/constants/errors.ts`, `src/utils/ApiError.ts`, `src/utils/ApiResponse.ts`, `src/utils/asyncHandler.ts`, `src/utils/pagination.ts`

**Interfaces:**
- Produces:
  - `ROLES = { ADMIN: 'admin', USER: 'user' }`, `Role` type.
  - `ERROR_CODES` map with `{ status, message }` per code.
  - `class ApiError extends Error { status: number; code: string; constructor(status, code, message) }`.
  - `sendSuccess(res, data, status?, meta?)`.
  - `asyncHandler(fn)` → Express handler.
  - `getPagination(query): { page, limit, skip }` and `buildMeta(total, page, limit)`.

- [ ] **Step 1: Create `src/constants/roles.ts`**

```ts
export const ROLES = { ADMIN: 'admin', USER: 'user' } as const;
export type Role = (typeof ROLES)[keyof typeof ROLES];
```

- [ ] **Step 2: Create `src/constants/errors.ts`**

```ts
export const ERROR_CODES = {
  INVALID_CREDENTIALS: { status: 401, message: 'Wrong username or password' },
  TOKEN_EXPIRED: { status: 401, message: 'Access token expired' },
  TOKEN_INVALID: { status: 401, message: 'Malformed or invalid token' },
  UNAUTHORIZED: { status: 401, message: 'Authentication required' },
  FORBIDDEN: { status: 403, message: 'Insufficient permissions' },
  NOT_FOUND: { status: 404, message: 'Resource not found' },
  VALIDATION_ERROR: { status: 422, message: 'Request validation failed' },
  DUPLICATE_RFID: { status: 409, message: 'RFID UID already registered' },
  DUPLICATE_PLATE: { status: 409, message: 'Plate number already registered' },
  DUPLICATE_USERNAME: { status: 409, message: 'Username already taken' },
  RATE_LIMITED: { status: 429, message: 'Too many requests' },
  INTERNAL_ERROR: { status: 500, message: 'Internal server error' },
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;
```

- [ ] **Step 3: Create `src/utils/ApiError.ts`**

```ts
import { ERROR_CODES, ErrorCode } from '../constants/errors';

export class ApiError extends Error {
  status: number;
  code: string;

  constructor(code: ErrorCode, message?: string) {
    const def = ERROR_CODES[code];
    super(message ?? def.message);
    this.status = def.status;
    this.code = code;
    Object.setPrototypeOf(this, ApiError.prototype);
  }

  static notFound(message = 'Resource not found') {
    return new ApiError('NOT_FOUND', message);
  }
}
```

- [ ] **Step 4: Create `src/utils/ApiResponse.ts`**

```ts
import { Response } from 'express';

export function sendSuccess(
  res: Response,
  data: unknown,
  status = 200,
  meta?: unknown
): Response {
  const body: Record<string, unknown> = { success: true, data };
  if (meta !== undefined) body.meta = meta;
  return res.status(status).json(body);
}
```

- [ ] **Step 5: Create `src/utils/asyncHandler.ts`**

```ts
import { Request, Response, NextFunction, RequestHandler } from 'express';

export const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
```

- [ ] **Step 6: Create `src/utils/pagination.ts`**

```ts
export interface PaginationParams {
  page: number;
  limit: number;
  skip: number;
}

export function getPagination(query: Record<string, unknown>): PaginationParams {
  const page = Math.max(1, parseInt(String(query.page ?? '1'), 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(String(query.limit ?? '20'), 10) || 20));
  return { page, limit, skip: (page - 1) * limit };
}

export function buildMeta(total: number, page: number, limit: number) {
  return { pagination: { total, page, limit, pages: Math.ceil(total / limit) } };
}
```

- [ ] **Step 7: Verify build and commit**

Run: `npx tsc --noEmit`
Expected: exit 0.
```bash
git add -A && git commit -m "feat: add constants (roles, errors) and core utils"
```

---

### Task 4: Shared types

**Files:**
- Create: `src/types/express.d.ts`, `src/types/index.ts`

**Interfaces:**
- Produces: `Express.Request.user?: AuthUser`; `AuthUser = { userId: string; role: Role; personId: string | null }`.

- [ ] **Step 1: Create `src/types/index.ts`**

```ts
import { Role } from '../constants/roles';

export interface AuthUser {
  userId: string;
  role: Role;
  personId: string | null;
}
```

- [ ] **Step 2: Create `src/types/express.d.ts`**

```ts
import { AuthUser } from './index';

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export {};
```

- [ ] **Step 3: Verify build and commit**

Run: `npx tsc --noEmit`
Expected: exit 0.
```bash
git add -A && git commit -m "feat: extend Express Request with typed user"
```

---

### Task 5: Core middleware (non-auth)

**Files:**
- Create: `src/middlewares/errorHandler.ts`, `src/middlewares/notFound.ts`, `src/middlewares/requestLogger.ts`, `src/middlewares/validate.ts`, `src/middlewares/rateLimiter.ts`

**Interfaces:**
- Consumes: `ApiError`, `env`.
- Produces:
  - `errorHandler(err, req, res, next)` — final middleware.
  - `notFound(req, res, next)` — throws `ApiError('NOT_FOUND')`.
  - `requestLogger` — morgan instance.
  - `validate(schema: ZodSchema, source?: 'body'|'query'|'params')` → middleware.
  - `loginLimiter`, `scanLimiter`, `globalLimiter`.

- [ ] **Step 1: Create `src/middlewares/errorHandler.ts`**

```ts
import { Request, Response, NextFunction } from 'express';
import { ApiError } from '../utils/ApiError';
import { env } from '../config/env';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof ApiError) {
    res.status(err.status).json({ success: false, code: err.code, message: err.message });
    return;
  }

  // Mongoose duplicate key
  if (typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000) {
    res.status(409).json({ success: false, code: 'DUPLICATE_KEY', message: 'Duplicate value' });
    return;
  }

  console.error('[error]', err);
  const message = env.isProd ? 'Internal server error' : String((err as Error)?.message ?? err);
  res.status(500).json({ success: false, code: 'INTERNAL_ERROR', message });
}
```

- [ ] **Step 2: Create `src/middlewares/notFound.ts`**

```ts
import { Request, Response, NextFunction } from 'express';
import { ApiError } from '../utils/ApiError';

export function notFound(_req: Request, _res: Response, next: NextFunction): void {
  next(new ApiError('NOT_FOUND', 'Endpoint not found'));
}
```

- [ ] **Step 3: Create `src/middlewares/requestLogger.ts`**

```ts
import morgan from 'morgan';
import { env } from '../config/env';

export const requestLogger = morgan(env.isProd ? 'combined' : 'dev');
```

- [ ] **Step 4: Create `src/middlewares/validate.ts`**

```ts
import { Request, Response, NextFunction } from 'express';
import { ZodSchema } from 'zod';
import { ApiError } from '../utils/ApiError';

type Source = 'body' | 'query' | 'params';

export const validate =
  (schema: ZodSchema, source: Source = 'body') =>
  (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      const detail = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      next(new ApiError('VALIDATION_ERROR', detail));
      return;
    }
    // assign parsed/coerced values back
    (req[source] as unknown) = result.data;
    next();
  };
```

- [ ] **Step 5: Create `src/middlewares/rateLimiter.ts`**

```ts
import rateLimit from 'express-rate-limit';
import { env } from '../config/env';

const handler = (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }) =>
  res.status(429).json({ success: false, code: 'RATE_LIMITED', message: 'Too many requests' });

export const globalLimiter = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  max: env.RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  handler,
});

export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: env.LOGIN_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  handler,
});

export const scanLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: env.SCAN_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  handler,
});
```

- [ ] **Step 6: Verify build and commit**

Run: `npx tsc --noEmit`
Expected: exit 0.
```bash
git add -A && git commit -m "feat: add core middleware (error, validate, rate-limit, logger)"
```

---

### Task 6: Mongoose models

**Files:**
- Create: `src/modules/persons/persons.model.ts`, `src/modules/users/users.model.ts`, `src/modules/vehicles/vehicles.model.ts`, `src/modules/gates/gates.model.ts`, `src/modules/scan/scan.model.ts`, `src/modules/attendance/attendance.model.ts`

**Interfaces:**
- Produces exported models + document interfaces:
  - `PersonModel`, `IPerson` (`full_name, type, id_number, department_section, contact_email, photo_url, rfid_uid, status`).
  - `UserModel`, `IUser` (`username, password_hash, role, person_id, must_change_password, is_active, refreshTokenHash`).
  - `VehicleModel`, `IVehicle` (`owner_person_id, plate_number, vehicle_type, vehicle_model, photo_url, status`).
  - `GateModel`, `IGate` (`name, type, location`).
  - `ScanLogModel`, `IScanLog` (`rfid_uid, entity_type, entity_id, gate_id, direction, access_result, reason, scan_time`).
  - `AttendanceModel`, `IAttendance` (`person_id, date, time_in, time_out, status`).

- [ ] **Step 1: Create `src/modules/persons/persons.model.ts`**

```ts
import { Schema, model, Document, Types } from 'mongoose';

export interface IPerson extends Document {
  _id: Types.ObjectId;
  full_name: string;
  type: 'student' | 'staff' | 'employee';
  id_number: string;
  department_section: string;
  contact_email?: string;
  photo_url?: string;
  rfid_uid: string;
  status: 'active' | 'inactive';
  createdAt: Date;
  updatedAt: Date;
}

const personSchema = new Schema<IPerson>(
  {
    full_name: { type: String, required: true },
    type: { type: String, enum: ['student', 'staff', 'employee'], required: true },
    id_number: { type: String, required: true, index: true },
    department_section: { type: String },
    contact_email: { type: String },
    photo_url: { type: String },
    rfid_uid: { type: String, required: true, unique: true },
    status: { type: String, enum: ['active', 'inactive'], default: 'active', index: true },
  },
  { timestamps: true }
);

export const PersonModel = model<IPerson>('Person', personSchema);
```

- [ ] **Step 2: Create `src/modules/users/users.model.ts`**

```ts
import { Schema, model, Document, Types } from 'mongoose';
import { ROLES, Role } from '../../constants/roles';

export interface IUser extends Document {
  _id: Types.ObjectId;
  username: string;
  password_hash: string;
  role: Role;
  person_id: Types.ObjectId | null;
  must_change_password: boolean;
  is_active: boolean;
  refreshTokenHash: string | null;
  createdAt: Date;
}

const userSchema = new Schema<IUser>(
  {
    username: { type: String, required: true, unique: true },
    password_hash: { type: String, required: true },
    role: { type: String, enum: [ROLES.ADMIN, ROLES.USER], required: true },
    person_id: { type: Schema.Types.ObjectId, ref: 'Person', default: null },
    must_change_password: { type: Boolean, default: false },
    is_active: { type: Boolean, default: true },
    refreshTokenHash: { type: String, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

export const UserModel = model<IUser>('User', userSchema);
```

- [ ] **Step 3: Create `src/modules/vehicles/vehicles.model.ts`**

```ts
import { Schema, model, Document, Types } from 'mongoose';

export interface IVehicle extends Document {
  _id: Types.ObjectId;
  owner_person_id: Types.ObjectId;
  plate_number: string;
  rfid_uid: string;
  vehicle_type: string;
  vehicle_model: string;
  photo_url?: string;
  status: 'active' | 'inactive';
  createdAt: Date;
}

const vehicleSchema = new Schema<IVehicle>(
  {
    owner_person_id: { type: Schema.Types.ObjectId, ref: 'Person', required: true, unique: true },
    plate_number: { type: String, required: true, unique: true },
    rfid_uid: { type: String, required: true, unique: true },
    vehicle_type: { type: String, required: true },
    vehicle_model: { type: String },
    photo_url: { type: String },
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

export const VehicleModel = model<IVehicle>('Vehicle', vehicleSchema);
```

- [ ] **Step 4: Create `src/modules/gates/gates.model.ts`**

```ts
import { Schema, model, Document, Types } from 'mongoose';

export interface IGate extends Document {
  _id: Types.ObjectId;
  name: string;
  type: 'person' | 'vehicle';
  location: string;
}

const gateSchema = new Schema<IGate>({
  name: { type: String, required: true },
  type: { type: String, enum: ['person', 'vehicle'], required: true },
  location: { type: String },
});

export const GateModel = model<IGate>('Gate', gateSchema);
```

- [ ] **Step 5: Create `src/modules/scan/scan.model.ts`**

```ts
import { Schema, model, Document, Types } from 'mongoose';

export interface IScanLog extends Document {
  _id: Types.ObjectId;
  rfid_uid: string;
  entity_type: 'person' | 'vehicle';
  entity_id: Types.ObjectId | null;
  gate_id: Types.ObjectId;
  direction: 'entry' | 'exit';
  access_result: 'granted' | 'denied';
  reason: string | null;
  scan_time: Date;
}

const TWO_YEARS_SECONDS = 60 * 60 * 24 * 365 * 2;

const scanLogSchema = new Schema<IScanLog>({
  rfid_uid: { type: String, required: true, index: true },
  entity_type: { type: String, enum: ['person', 'vehicle'], required: true },
  entity_id: { type: Schema.Types.ObjectId, default: null },
  gate_id: { type: Schema.Types.ObjectId, ref: 'Gate', required: true },
  direction: { type: String, enum: ['entry', 'exit'], required: true },
  access_result: { type: String, enum: ['granted', 'denied'], required: true },
  reason: { type: String, default: null },
  scan_time: { type: Date, required: true, index: { expireAfterSeconds: TWO_YEARS_SECONDS } },
});

scanLogSchema.index({ entity_type: 1, entity_id: 1 });

export const ScanLogModel = model<IScanLog>('ScanLog', scanLogSchema);
```

- [ ] **Step 6: Create `src/modules/attendance/attendance.model.ts`**

```ts
import { Schema, model, Document, Types } from 'mongoose';

export interface IAttendance extends Document {
  _id: Types.ObjectId;
  person_id: Types.ObjectId;
  date: string; // YYYY-MM-DD
  time_in: Date | null;
  time_out: Date | null;
  status: 'present' | 'late' | 'absent';
}

const attendanceSchema = new Schema<IAttendance>({
  person_id: { type: Schema.Types.ObjectId, ref: 'Person', required: true },
  date: { type: String, required: true },
  time_in: { type: Date, default: null },
  time_out: { type: Date, default: null },
  status: { type: String, enum: ['present', 'late', 'absent'], default: 'present' },
});

attendanceSchema.index({ person_id: 1, date: 1 }, { unique: true });

export const AttendanceModel = model<IAttendance>('AttendanceSummary', attendanceSchema);
```

- [ ] **Step 7: Verify build and commit**

Run: `npx tsc --noEmit`
Expected: exit 0.
```bash
git add -A && git commit -m "feat: add Mongoose models with indexes"
```

---

### Task 7: Auth middleware (authenticate + authorize)

**Files:**
- Create: `src/middlewares/authenticate.ts`, `src/middlewares/authorize.ts`, `src/modules/auth/auth.tokens.ts`

**Interfaces:**
- Consumes: `env`, `ApiError`, `AuthUser`, `Role`.
- Produces:
  - `signAccessToken(payload)`, `signRefreshToken(payload)`, `verifyAccessToken(token)`, `verifyRefreshToken(token)` in `auth.tokens.ts`. Payload type `TokenPayload = { sub: string; role: Role; personId: string | null }`.
  - `authenticate` middleware → sets `req.user`.
  - `authorize(...roles: Role[])` factory.

- [ ] **Step 1: Create `src/modules/auth/auth.tokens.ts`**

```ts
import jwt from 'jsonwebtoken';
import { env } from '../../config/env';
import { Role } from '../../constants/roles';

export interface TokenPayload {
  sub: string;
  role: Role;
  personId: string | null;
}

export function signAccessToken(payload: TokenPayload): string {
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, {
    expiresIn: env.JWT_ACCESS_EXPIRES_IN,
  } as jwt.SignOptions);
}

export function signRefreshToken(payload: TokenPayload): string {
  return jwt.sign(payload, env.JWT_REFRESH_SECRET, {
    expiresIn: env.JWT_REFRESH_EXPIRES_IN,
  } as jwt.SignOptions);
}

export function verifyAccessToken(token: string): TokenPayload & jwt.JwtPayload {
  return jwt.verify(token, env.JWT_ACCESS_SECRET) as TokenPayload & jwt.JwtPayload;
}

export function verifyRefreshToken(token: string): TokenPayload & jwt.JwtPayload {
  return jwt.verify(token, env.JWT_REFRESH_SECRET) as TokenPayload & jwt.JwtPayload;
}
```

- [ ] **Step 2: Create `src/middlewares/authenticate.ts`**

```ts
import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { ApiError } from '../utils/ApiError';
import { verifyAccessToken } from '../modules/auth/auth.tokens';

export function authenticate(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    next(new ApiError('UNAUTHORIZED'));
    return;
  }
  const token = header.slice(7);
  try {
    const decoded = verifyAccessToken(token);
    req.user = { userId: decoded.sub, role: decoded.role, personId: decoded.personId };
    next();
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      next(new ApiError('TOKEN_EXPIRED'));
      return;
    }
    next(new ApiError('TOKEN_INVALID'));
  }
}
```

- [ ] **Step 3: Create `src/middlewares/authorize.ts`**

```ts
import { Request, Response, NextFunction } from 'express';
import { ApiError } from '../utils/ApiError';
import { Role } from '../constants/roles';

export const authorize =
  (...roles: Role[]) =>
  (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      next(new ApiError('UNAUTHORIZED'));
      return;
    }
    if (!roles.includes(req.user.role)) {
      next(new ApiError('FORBIDDEN'));
      return;
    }
    next();
  };
```

- [ ] **Step 4: Verify build and commit**

Run: `npx tsc --noEmit`
Expected: exit 0.
```bash
git add -A && git commit -m "feat: add JWT token helpers and auth middleware"
```

---

### Task 8: Auth module (login/refresh/logout)

**Files:**
- Create: `src/modules/auth/auth.schema.ts`, `src/modules/auth/auth.service.ts`, `src/modules/auth/auth.controller.ts`, `src/modules/auth/auth.routes.ts`

**Interfaces:**
- Consumes: `UserModel`, token helpers, `ApiError`, `sendSuccess`, `validate`, `loginLimiter`, `env`, bcrypt.
- Produces: `authRoutes` (Express Router) mounted at `/auth`. Sets/clears cookie `refreshToken`.

- [ ] **Step 1: Create `src/modules/auth/auth.schema.ts`**

```ts
import { z } from 'zod';

export const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});
```

- [ ] **Step 2: Create `src/modules/auth/auth.service.ts`**

```ts
import bcrypt from 'bcrypt';
import { UserModel } from '../users/users.model';
import { ApiError } from '../../utils/ApiError';
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  TokenPayload,
} from './auth.tokens';

const BCRYPT_ROUNDS = 12;

interface LoginResult {
  accessToken: string;
  refreshToken: string;
  user: { id: string; username: string; role: string; personId: string | null; mustChangePassword: boolean };
}

function payloadFor(user: { _id: unknown; role: TokenPayload['role']; person_id: unknown }): TokenPayload {
  return {
    sub: String(user._id),
    role: user.role,
    personId: user.person_id ? String(user.person_id) : null,
  };
}

export async function login(username: string, password: string): Promise<LoginResult> {
  const user = await UserModel.findOne({ username, is_active: true });
  if (!user) throw new ApiError('INVALID_CREDENTIALS');

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) throw new ApiError('INVALID_CREDENTIALS');

  const payload = payloadFor(user);
  const accessToken = signAccessToken(payload);
  const refreshToken = signRefreshToken(payload);
  user.refreshTokenHash = await bcrypt.hash(refreshToken, BCRYPT_ROUNDS);
  await user.save();

  return {
    accessToken,
    refreshToken,
    user: {
      id: String(user._id),
      username: user.username,
      role: user.role,
      personId: user.person_id ? String(user.person_id) : null,
      mustChangePassword: user.must_change_password,
    },
  };
}

export async function refresh(oldToken: string): Promise<{ accessToken: string; refreshToken: string }> {
  let decoded: TokenPayload;
  try {
    decoded = verifyRefreshToken(oldToken);
  } catch {
    throw new ApiError('TOKEN_INVALID');
  }

  const user = await UserModel.findById(decoded.sub);
  if (!user || !user.is_active || !user.refreshTokenHash) throw new ApiError('TOKEN_INVALID');

  const matches = await bcrypt.compare(oldToken, user.refreshTokenHash);
  if (!matches) throw new ApiError('TOKEN_INVALID');

  const payload = payloadFor(user);
  const accessToken = signAccessToken(payload);
  const refreshToken = signRefreshToken(payload);
  user.refreshTokenHash = await bcrypt.hash(refreshToken, BCRYPT_ROUNDS);
  await user.save();

  return { accessToken, refreshToken };
}

export async function logout(userId: string): Promise<void> {
  await UserModel.findByIdAndUpdate(userId, { refreshTokenHash: null });
}
```

- [ ] **Step 3: Create `src/modules/auth/auth.controller.ts`**

```ts
import { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { sendSuccess } from '../../utils/ApiResponse';
import { ApiError } from '../../utils/ApiError';
import { env } from '../../config/env';
import * as authService from './auth.service';

const REFRESH_COOKIE = 'refreshToken';
const cookieOptions = {
  httpOnly: true,
  secure: env.isProd,
  sameSite: 'strict' as const,
  path: '/',
  maxAge: 7 * 24 * 60 * 60 * 1000,
};

export const loginController = asyncHandler(async (req: Request, res: Response) => {
  const { username, password } = req.body;
  const result = await authService.login(username, password);
  res.cookie(REFRESH_COOKIE, result.refreshToken, cookieOptions);
  sendSuccess(res, { accessToken: result.accessToken, user: result.user });
});

export const refreshController = asyncHandler(async (req: Request, res: Response) => {
  const token = req.cookies?.[REFRESH_COOKIE];
  if (!token) throw new ApiError('TOKEN_INVALID', 'No refresh token');
  const result = await authService.refresh(token);
  res.cookie(REFRESH_COOKIE, result.refreshToken, cookieOptions);
  sendSuccess(res, { accessToken: result.accessToken });
});

export const logoutController = asyncHandler(async (req: Request, res: Response) => {
  if (req.user) await authService.logout(req.user.userId);
  res.clearCookie(REFRESH_COOKIE, { ...cookieOptions, maxAge: undefined });
  sendSuccess(res, { message: 'Logged out' });
});
```

- [ ] **Step 4: Create `src/modules/auth/auth.routes.ts`**

```ts
import { Router } from 'express';
import { validate } from '../../middlewares/validate';
import { authenticate } from '../../middlewares/authenticate';
import { loginLimiter } from '../../middlewares/rateLimiter';
import { loginSchema } from './auth.schema';
import { loginController, refreshController, logoutController } from './auth.controller';

export const authRoutes = Router();

authRoutes.post('/login', loginLimiter, validate(loginSchema), loginController);
authRoutes.post('/refresh', refreshController);
authRoutes.post('/logout', authenticate, logoutController);
```

- [ ] **Step 5: Verify build and commit**

Run: `npx tsc --noEmit`
Expected: exit 0.
```bash
git add -A && git commit -m "feat: add auth module (login, refresh rotation, logout)"
```

---

### Task 9: Persons module

**Files:**
- Create: `src/modules/persons/persons.schema.ts`, `src/modules/persons/persons.repository.ts`, `src/modules/persons/persons.service.ts`, `src/modules/persons/persons.controller.ts`, `src/modules/persons/persons.routes.ts`

**Interfaces:**
- Consumes: `PersonModel`, `IPerson`, pagination utils, `ApiError`, `sendSuccess`, `authenticate`, `authorize`, `validate`.
- Produces: `personRoutes` mounted at `/persons` (admin only). Repository functions: `create`, `findPaginated(filter, pagination)`, `findById`, `updateById`, `setStatus`, `reassignRfid`, `findByRfid`.

- [ ] **Step 1: Create `src/modules/persons/persons.schema.ts`**

```ts
import { z } from 'zod';

export const createPersonSchema = z.object({
  full_name: z.string().min(1),
  type: z.enum(['student', 'staff', 'employee']),
  id_number: z.string().min(1),
  department_section: z.string().optional(),
  contact_email: z.string().email().optional(),
  photo_url: z.string().url().optional(),
  rfid_uid: z.string().regex(/^[0-9A-Fa-f]+$/, 'rfid_uid must be hex'),
  status: z.enum(['active', 'inactive']).optional(),
});

export const updatePersonSchema = createPersonSchema.partial().omit({ rfid_uid: true });
export const statusSchema = z.object({ status: z.enum(['active', 'inactive']) });
export const reassignRfidSchema = z.object({
  rfid_uid: z.string().regex(/^[0-9A-Fa-f]+$/, 'rfid_uid must be hex'),
});
```

- [ ] **Step 2: Create `src/modules/persons/persons.repository.ts`**

```ts
import { FilterQuery } from 'mongoose';
import { PersonModel, IPerson } from './persons.model';
import { PaginationParams } from '../../utils/pagination';

export const personRepo = {
  create: (data: Partial<IPerson>) => PersonModel.create(data),

  async findPaginated(filter: FilterQuery<IPerson>, p: PaginationParams) {
    const [items, total] = await Promise.all([
      PersonModel.find(filter).sort({ createdAt: -1 }).skip(p.skip).limit(p.limit).lean(),
      PersonModel.countDocuments(filter),
    ]);
    return { items, total };
  },

  findById: (id: string) => PersonModel.findById(id).lean(),
  findByRfid: (rfid_uid: string) => PersonModel.findOne({ rfid_uid }),
  updateById: (id: string, data: Partial<IPerson>) =>
    PersonModel.findByIdAndUpdate(id, data, { new: true }).lean(),
};
```

- [ ] **Step 3: Create `src/modules/persons/persons.service.ts`**

```ts
import { FilterQuery } from 'mongoose';
import { personRepo } from './persons.repository';
import { IPerson } from './persons.model';
import { ApiError } from '../../utils/ApiError';
import { getPagination, buildMeta } from '../../utils/pagination';

interface ListQuery {
  page?: string;
  limit?: string;
  type?: string;
  status?: string;
  search?: string;
}

export const personService = {
  async list(query: ListQuery) {
    const p = getPagination(query);
    const filter: FilterQuery<IPerson> = {};
    if (query.type) filter.type = query.type;
    if (query.status) filter.status = query.status;
    if (query.search) filter.full_name = { $regex: query.search, $options: 'i' };
    const { items, total } = await personRepo.findPaginated(filter, p);
    return { items, meta: buildMeta(total, p.page, p.limit) };
  },

  async get(id: string) {
    const person = await personRepo.findById(id);
    if (!person) throw new ApiError('NOT_FOUND', 'Person not found');
    return person;
  },

  async create(data: Partial<IPerson>) {
    const existing = await personRepo.findByRfid(data.rfid_uid as string);
    if (existing) throw new ApiError('DUPLICATE_RFID');
    return personRepo.create(data);
  },

  async update(id: string, data: Partial<IPerson>) {
    const updated = await personRepo.updateById(id, data);
    if (!updated) throw new ApiError('NOT_FOUND', 'Person not found');
    return updated;
  },

  async setStatus(id: string, status: 'active' | 'inactive') {
    return this.update(id, { status });
  },

  async reassignRfid(id: string, rfid_uid: string) {
    const clash = await personRepo.findByRfid(rfid_uid);
    if (clash && String(clash._id) !== id) throw new ApiError('DUPLICATE_RFID');
    return this.update(id, { rfid_uid });
  },
};
```

- [ ] **Step 4: Create `src/modules/persons/persons.controller.ts`**

```ts
import { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { sendSuccess } from '../../utils/ApiResponse';
import { personService } from './persons.service';

export const personController = {
  list: asyncHandler(async (req: Request, res: Response) => {
    const { items, meta } = await personService.list(req.query);
    sendSuccess(res, items, 200, meta);
  }),
  get: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await personService.get(req.params.id));
  }),
  create: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await personService.create(req.body), 201);
  }),
  update: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await personService.update(req.params.id, req.body));
  }),
  setStatus: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await personService.setStatus(req.params.id, req.body.status));
  }),
  reassignRfid: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await personService.reassignRfid(req.params.id, req.body.rfid_uid));
  }),
};
```

- [ ] **Step 5: Create `src/modules/persons/persons.routes.ts`**

```ts
import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate';
import { authorize } from '../../middlewares/authorize';
import { validate } from '../../middlewares/validate';
import { ROLES } from '../../constants/roles';
import { personController } from './persons.controller';
import {
  createPersonSchema,
  updatePersonSchema,
  statusSchema,
  reassignRfidSchema,
} from './persons.schema';

export const personRoutes = Router();

personRoutes.use(authenticate, authorize(ROLES.ADMIN));
personRoutes.get('/', personController.list);
personRoutes.get('/:id', personController.get);
personRoutes.post('/', validate(createPersonSchema), personController.create);
personRoutes.patch('/:id', validate(updatePersonSchema), personController.update);
personRoutes.patch('/:id/status', validate(statusSchema), personController.setStatus);
personRoutes.patch('/:id/rfid', validate(reassignRfidSchema), personController.reassignRfid);
```

- [ ] **Step 6: Verify build and commit**

Run: `npx tsc --noEmit`
Expected: exit 0.
```bash
git add -A && git commit -m "feat: add persons module (CRUD, status, rfid reassign)"
```

---

### Task 10: Vehicles module

**Files:**
- Create: `src/modules/vehicles/vehicles.schema.ts`, `src/modules/vehicles/vehicles.repository.ts`, `src/modules/vehicles/vehicles.service.ts`, `src/modules/vehicles/vehicles.controller.ts`, `src/modules/vehicles/vehicles.routes.ts`

**Interfaces:**
- Consumes: `VehicleModel`, `IVehicle`, pagination, `ApiError`, `sendSuccess`, auth middleware.
- Produces: `vehicleRoutes` mounted at `/vehicles` (admin only).

- [ ] **Step 1: Create `src/modules/vehicles/vehicles.schema.ts`**

```ts
import { z } from 'zod';

export const createVehicleSchema = z.object({
  owner_person_id: z.string().min(1),
  plate_number: z.string().min(1),
  rfid_uid: z.string().regex(/^[0-9A-Fa-f]+$/, 'rfid_uid must be hex'),
  vehicle_type: z.string().min(1),
  vehicle_model: z.string().optional(),
  photo_url: z.string().url().optional(),
  status: z.enum(['active', 'inactive']).optional(),
});

export const updateVehicleSchema = createVehicleSchema.partial();
export const vehicleStatusSchema = z.object({ status: z.enum(['active', 'inactive']) });
```

- [ ] **Step 2: Create `src/modules/vehicles/vehicles.repository.ts`**

```ts
import { FilterQuery } from 'mongoose';
import { VehicleModel, IVehicle } from './vehicles.model';
import { PaginationParams } from '../../utils/pagination';

export const vehicleRepo = {
  create: (data: Partial<IVehicle>) => VehicleModel.create(data),
  async findPaginated(filter: FilterQuery<IVehicle>, p: PaginationParams) {
    const [items, total] = await Promise.all([
      VehicleModel.find(filter).sort({ createdAt: -1 }).skip(p.skip).limit(p.limit).lean(),
      VehicleModel.countDocuments(filter),
    ]);
    return { items, total };
  },
  findById: (id: string) => VehicleModel.findById(id).lean(),
  findByOwner: (owner_person_id: string) => VehicleModel.findOne({ owner_person_id }),
  findByRfid: (rfid_uid: string) => VehicleModel.findOne({ rfid_uid }),
  updateById: (id: string, data: Partial<IVehicle>) =>
    VehicleModel.findByIdAndUpdate(id, data, { new: true }).lean(),
};
```

- [ ] **Step 3: Create `src/modules/vehicles/vehicles.service.ts`**

```ts
import { FilterQuery } from 'mongoose';
import { vehicleRepo } from './vehicles.repository';
import { IVehicle } from './vehicles.model';
import { ApiError } from '../../utils/ApiError';
import { getPagination, buildMeta } from '../../utils/pagination';

interface ListQuery {
  page?: string;
  limit?: string;
  status?: string;
  vehicle_type?: string;
}

export const vehicleService = {
  async list(query: ListQuery) {
    const p = getPagination(query);
    const filter: FilterQuery<IVehicle> = {};
    if (query.status) filter.status = query.status;
    if (query.vehicle_type) filter.vehicle_type = query.vehicle_type;
    const { items, total } = await vehicleRepo.findPaginated(filter, p);
    return { items, meta: buildMeta(total, p.page, p.limit) };
  },
  async get(id: string) {
    const v = await vehicleRepo.findById(id);
    if (!v) throw new ApiError('NOT_FOUND', 'Vehicle not found');
    return v;
  },
  async create(data: Partial<IVehicle>) {
    const existingOwner = await vehicleRepo.findByOwner(String(data.owner_person_id));
    if (existingOwner) throw new ApiError('DUPLICATE_PLATE', 'Owner already has a vehicle');
    const existingRfid = await vehicleRepo.findByRfid(String(data.rfid_uid));
    if (existingRfid) throw new ApiError('DUPLICATE_RFID');
    return vehicleRepo.create(data);
  },
  async update(id: string, data: Partial<IVehicle>) {
    const updated = await vehicleRepo.updateById(id, data);
    if (!updated) throw new ApiError('NOT_FOUND', 'Vehicle not found');
    return updated;
  },
  async setStatus(id: string, status: 'active' | 'inactive') {
    return this.update(id, { status });
  },
};
```

- [ ] **Step 4: Create `src/modules/vehicles/vehicles.controller.ts`**

```ts
import { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { sendSuccess } from '../../utils/ApiResponse';
import { vehicleService } from './vehicles.service';

export const vehicleController = {
  list: asyncHandler(async (req: Request, res: Response) => {
    const { items, meta } = await vehicleService.list(req.query);
    sendSuccess(res, items, 200, meta);
  }),
  get: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await vehicleService.get(req.params.id));
  }),
  create: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await vehicleService.create(req.body), 201);
  }),
  update: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await vehicleService.update(req.params.id, req.body));
  }),
  setStatus: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await vehicleService.setStatus(req.params.id, req.body.status));
  }),
};
```

- [ ] **Step 5: Create `src/modules/vehicles/vehicles.routes.ts`**

```ts
import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate';
import { authorize } from '../../middlewares/authorize';
import { validate } from '../../middlewares/validate';
import { ROLES } from '../../constants/roles';
import { vehicleController } from './vehicles.controller';
import { createVehicleSchema, updateVehicleSchema, vehicleStatusSchema } from './vehicles.schema';

export const vehicleRoutes = Router();

vehicleRoutes.use(authenticate, authorize(ROLES.ADMIN));
vehicleRoutes.get('/', vehicleController.list);
vehicleRoutes.get('/:id', vehicleController.get);
vehicleRoutes.post('/', validate(createVehicleSchema), vehicleController.create);
vehicleRoutes.patch('/:id', validate(updateVehicleSchema), vehicleController.update);
vehicleRoutes.patch('/:id/status', validate(vehicleStatusSchema), vehicleController.setStatus);
```

- [ ] **Step 6: Verify build and commit**

Run: `npx tsc --noEmit`
Expected: exit 0.
```bash
git add -A && git commit -m "feat: add vehicles module"
```

---

### Task 11: Gates module

**Files:**
- Create: `src/modules/gates/gates.repository.ts`, `src/modules/gates/gates.service.ts`, `src/modules/gates/gates.controller.ts`, `src/modules/gates/gates.routes.ts`

**Interfaces:**
- Consumes: `GateModel`, `IGate`, auth middleware.
- Produces: `gateRoutes` mounted at `/gates` (authenticated; list open to all roles). Repo: `list()`, `findById(id)`.

- [ ] **Step 1: Create `src/modules/gates/gates.repository.ts`**

```ts
import { GateModel } from './gates.model';

export const gateRepo = {
  list: () => GateModel.find().lean(),
  findById: (id: string) => GateModel.findById(id).lean(),
};
```

- [ ] **Step 2: Create `src/modules/gates/gates.service.ts`**

```ts
import { gateRepo } from './gates.repository';
import { ApiError } from '../../utils/ApiError';

export const gateService = {
  list: () => gateRepo.list(),
  async get(id: string) {
    const gate = await gateRepo.findById(id);
    if (!gate) throw new ApiError('NOT_FOUND', 'Gate not found');
    return gate;
  },
};
```

- [ ] **Step 3: Create `src/modules/gates/gates.controller.ts`**

```ts
import { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { sendSuccess } from '../../utils/ApiResponse';
import { gateService } from './gates.service';

export const gateController = {
  list: asyncHandler(async (_req: Request, res: Response) => {
    sendSuccess(res, await gateService.list());
  }),
  get: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await gateService.get(req.params.id));
  }),
};
```

- [ ] **Step 4: Create `src/modules/gates/gates.routes.ts`**

```ts
import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate';
import { gateController } from './gates.controller';

export const gateRoutes = Router();

gateRoutes.use(authenticate);
gateRoutes.get('/', gateController.list);
gateRoutes.get('/:id', gateController.get);
```

- [ ] **Step 5: Verify build and commit**

Run: `npx tsc --noEmit`
Expected: exit 0.
```bash
git add -A && git commit -m "feat: add gates module"
```

---

### Task 12: Scan module (tap + logs) — core logic

**Files:**
- Create: `src/modules/scan/scan.schema.ts`, `src/modules/scan/scan.repository.ts`, `src/modules/attendance/attendance.repository.ts`, `src/modules/scan/scan.service.ts`, `src/modules/scan/scan.controller.ts`, `src/modules/scan/scan.routes.ts`

**Interfaces:**
- Consumes: `ScanLogModel`, `AttendanceModel`, `PersonModel`, `VehicleModel`, `GateModel`, `env.LATE_CUTOFF_TIME`, `scanLimiter`, auth.
- Produces:
  - `attendanceRepo` (shared, used again in Task 13): `upsertTimeIn(personId, date, when, status)`, `upsertTimeOut(personId, date, when)`, `findPaginated(filter, p)`, `findByPersonAndDate(personId, date)`, `findSummary(personId)`.
  - `scanRepo`: `createLog(data)`, `findLogsPaginated(filter, p)`.
  - `scanService.tap(input)` returning `{ access_result, person?, reason?, scan_time }`.
  - `scanRoutes` mounted at `/scan`: `POST /tap` (any authenticated), `GET /logs` (admin).

- [ ] **Step 1: Create `src/modules/scan/scan.schema.ts`**

```ts
import { z } from 'zod';

export const tapSchema = z.object({
  rfid_uid: z.string().regex(/^[0-9A-Fa-f]+$/, 'rfid_uid must be hex'),
  gate_id: z.string().min(1),
  direction: z.enum(['entry', 'exit']),
});
```

- [ ] **Step 2: Create `src/modules/attendance/attendance.repository.ts`**

```ts
import { FilterQuery } from 'mongoose';
import { AttendanceModel, IAttendance } from './attendance.model';
import { PaginationParams } from '../../utils/pagination';

export const attendanceRepo = {
  findByPersonAndDate: (person_id: string, date: string) =>
    AttendanceModel.findOne({ person_id, date }),

  upsertTimeIn: (person_id: string, date: string, when: Date, status: 'present' | 'late') =>
    AttendanceModel.findOneAndUpdate(
      { person_id, date },
      { $setOnInsert: { time_in: when, status } },
      { upsert: true, new: true }
    ),

  upsertTimeOut: (person_id: string, date: string, when: Date) =>
    AttendanceModel.findOneAndUpdate(
      { person_id, date },
      { $set: { time_out: when } },
      { upsert: true, new: true }
    ),

  async findPaginated(filter: FilterQuery<IAttendance>, p: PaginationParams) {
    const [items, total] = await Promise.all([
      AttendanceModel.find(filter).sort({ date: -1 }).skip(p.skip).limit(p.limit).lean(),
      AttendanceModel.countDocuments(filter),
    ]);
    return { items, total };
  },

  findSummary: (person_id: string) =>
    AttendanceModel.find({ person_id }).sort({ date: -1 }).limit(30).lean(),
};
```

- [ ] **Step 3: Create `src/modules/scan/scan.repository.ts`**

```ts
import { FilterQuery } from 'mongoose';
import { ScanLogModel, IScanLog } from './scan.model';
import { PaginationParams } from '../../utils/pagination';

export const scanRepo = {
  createLog: (data: Partial<IScanLog>) => ScanLogModel.create(data),

  async findLogsPaginated(filter: FilterQuery<IScanLog>, p: PaginationParams) {
    const [items, total] = await Promise.all([
      ScanLogModel.find(filter).sort({ scan_time: -1 }).skip(p.skip).limit(p.limit).lean(),
      ScanLogModel.countDocuments(filter),
    ]);
    return { items, total };
  },
};
```

- [ ] **Step 4: Create `src/modules/scan/scan.service.ts`**

```ts
import { Types } from 'mongoose';
import { scanRepo } from './scan.repository';
import { attendanceRepo } from '../attendance/attendance.repository';
import { PersonModel } from '../persons/persons.model';
import { VehicleModel } from '../vehicles/vehicles.model';
import { GateModel } from '../gates/gates.model';
import { ApiError } from '../../utils/ApiError';
import { env } from '../../config/env';

interface TapInput {
  rfid_uid: string;
  gate_id: string;
  direction: 'entry' | 'exit';
}

interface TapResult {
  access_result: 'granted' | 'denied';
  reason: string | null;
  scan_time: Date;
  person?: { full_name: string; type: string; photo_url?: string };
}

function dateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function isLate(when: Date): boolean {
  const [h, m] = env.LATE_CUTOFF_TIME.split(':').map((n) => parseInt(n, 10));
  const cutoff = new Date(when);
  cutoff.setHours(h, m, 0, 0);
  return when.getTime() > cutoff.getTime();
}

export const scanService = {
  async tap(input: TapInput): Promise<TapResult> {
    const gate = await GateModel.findById(input.gate_id).lean();
    if (!gate) throw new ApiError('NOT_FOUND', 'Gate not found');

    const scan_time = new Date();

    // Resolve entity by RFID: person first, then vehicle
    const person = await PersonModel.findOne({ rfid_uid: input.rfid_uid }).lean();
    let entity_type: 'person' | 'vehicle' = 'person';
    let entity_id: Types.ObjectId | null = null;
    let access_result: 'granted' | 'denied' = 'denied';
    let reason: string | null = 'unregistered_uid';
    let personView: TapResult['person'];

    if (person) {
      entity_type = 'person';
      entity_id = person._id;
      if (person.status === 'active') {
        access_result = 'granted';
        reason = null;
        personView = { full_name: person.full_name, type: person.type, photo_url: person.photo_url };
      } else {
        access_result = 'denied';
        reason = 'inactive_id';
      }
    } else {
      const vehicle = await VehicleModel.findOne({ rfid_uid: input.rfid_uid }).lean();
      if (vehicle) {
        entity_type = 'vehicle';
        entity_id = vehicle._id;
        if (vehicle.status === 'active') {
          access_result = 'granted';
          reason = null;
        } else {
          access_result = 'denied';
          reason = 'inactive_id';
        }
      }
    }

    await scanRepo.createLog({
      rfid_uid: input.rfid_uid,
      entity_type,
      entity_id,
      gate_id: new Types.ObjectId(input.gate_id),
      direction: input.direction,
      access_result,
      reason,
      scan_time,
    });

    // Attendance rollup only for granted person taps
    if (access_result === 'granted' && entity_type === 'person' && entity_id) {
      const key = dateKey(scan_time);
      if (input.direction === 'entry') {
        await attendanceRepo.upsertTimeIn(
          String(entity_id),
          key,
          scan_time,
          isLate(scan_time) ? 'late' : 'present'
        );
      } else {
        await attendanceRepo.upsertTimeOut(String(entity_id), key, scan_time);
      }
    }

    return { access_result, reason, scan_time, person: personView };
  },

  async listLogs(query: Record<string, string | undefined>) {
    const { getPagination, buildMeta } = await import('../../utils/pagination');
    const p = getPagination(query);
    const filter: Record<string, unknown> = {};
    if (query.gate_id) filter.gate_id = query.gate_id;
    if (query.direction) filter.direction = query.direction;
    if (query.from || query.to) {
      const range: Record<string, Date> = {};
      if (query.from) range.$gte = new Date(query.from);
      if (query.to) range.$lte = new Date(query.to);
      filter.scan_time = range;
    }
    const { items, total } = await scanRepo.findLogsPaginated(filter, p);
    return { items, meta: buildMeta(total, p.page, p.limit) };
  },
};
```

> Note: vehicles carry their own unique `rfid_uid` (added in Task 6/10). The tap flow resolves a person by UID first, then falls back to a vehicle by the same UID — a granted vehicle tap writes a `scan_logs` entry with `entity_type: 'vehicle'` but does not touch `attendance_summary` (attendance is person-only).

- [ ] **Step 5: Create `src/modules/scan/scan.controller.ts`**

```ts
import { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { sendSuccess } from '../../utils/ApiResponse';
import { scanService } from './scan.service';

export const scanController = {
  tap: asyncHandler(async (req: Request, res: Response) => {
    const result = await scanService.tap(req.body);
    sendSuccess(res, result, 200); // always 200 — denied is a business outcome
  }),
  logs: asyncHandler(async (req: Request, res: Response) => {
    const { items, meta } = await scanService.listLogs(req.query as Record<string, string>);
    sendSuccess(res, items, 200, meta);
  }),
};
```

- [ ] **Step 6: Create `src/modules/scan/scan.routes.ts`**

```ts
import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate';
import { authorize } from '../../middlewares/authorize';
import { validate } from '../../middlewares/validate';
import { scanLimiter } from '../../middlewares/rateLimiter';
import { ROLES } from '../../constants/roles';
import { scanController } from './scan.controller';
import { tapSchema } from './scan.schema';

export const scanRoutes = Router();

scanRoutes.use(authenticate);
scanRoutes.post('/tap', scanLimiter, validate(tapSchema), scanController.tap);
scanRoutes.get('/logs', authorize(ROLES.ADMIN), scanController.logs);
```

- [ ] **Step 7: Verify build and commit**

Run: `npx tsc --noEmit`
Expected: exit 0.
```bash
git add -A && git commit -m "feat: add scan module with tap logic and attendance rollup"
```

---

### Task 13: Attendance module (read endpoints)

**Files:**
- Create: `src/modules/attendance/attendance.service.ts`, `src/modules/attendance/attendance.controller.ts`, `src/modules/attendance/attendance.routes.ts`

**Interfaces:**
- Consumes: `attendanceRepo` (from Task 12), pagination, `ApiError`, `ROLES`, `AuthUser`.
- Produces: `attendanceRoutes` mounted at `/attendance`. `GET /` (admin: all, user: own), `GET /summary/:person_id` (admin).

- [ ] **Step 1: Create `src/modules/attendance/attendance.service.ts`**

```ts
import { FilterQuery } from 'mongoose';
import { attendanceRepo } from './attendance.repository';
import { IAttendance } from './attendance.model';
import { ApiError } from '../../utils/ApiError';
import { getPagination, buildMeta } from '../../utils/pagination';
import { ROLES, Role } from '../../constants/roles';

interface ListQuery {
  page?: string;
  limit?: string;
  person_id?: string;
  from?: string;
  to?: string;
  status?: string;
}

export const attendanceService = {
  async list(query: ListQuery, actor: { role: Role; personId: string | null }) {
    const p = getPagination(query);
    const filter: FilterQuery<IAttendance> = {};

    if (actor.role === ROLES.ADMIN) {
      if (query.person_id) filter.person_id = query.person_id;
    } else {
      if (!actor.personId) throw new ApiError('FORBIDDEN', 'Account not linked to a person');
      filter.person_id = actor.personId;
    }

    if (query.status) filter.status = query.status;
    if (query.from || query.to) {
      const range: Record<string, string> = {};
      if (query.from) range.$gte = query.from;
      if (query.to) range.$lte = query.to;
      filter.date = range;
    }

    const { items, total } = await attendanceRepo.findPaginated(filter, p);
    return { items, meta: buildMeta(total, p.page, p.limit) };
  },

  summary(person_id: string) {
    return attendanceRepo.findSummary(person_id);
  },
};
```

- [ ] **Step 2: Create `src/modules/attendance/attendance.controller.ts`**

```ts
import { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { sendSuccess } from '../../utils/ApiResponse';
import { ApiError } from '../../utils/ApiError';
import { attendanceService } from './attendance.service';

export const attendanceController = {
  list: asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw new ApiError('UNAUTHORIZED');
    const { items, meta } = await attendanceService.list(req.query, {
      role: req.user.role,
      personId: req.user.personId,
    });
    sendSuccess(res, items, 200, meta);
  }),
  summary: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await attendanceService.summary(req.params.person_id));
  }),
};
```

- [ ] **Step 3: Create `src/modules/attendance/attendance.routes.ts`**

```ts
import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate';
import { authorize } from '../../middlewares/authorize';
import { ROLES } from '../../constants/roles';
import { attendanceController } from './attendance.controller';

export const attendanceRoutes = Router();

attendanceRoutes.use(authenticate);
attendanceRoutes.get('/', attendanceController.list);
attendanceRoutes.get('/summary/:person_id', authorize(ROLES.ADMIN), attendanceController.summary);
```

- [ ] **Step 4: Verify build and commit**

Run: `npx tsc --noEmit`
Expected: exit 0.
```bash
git add -A && git commit -m "feat: add attendance read endpoints (role-scoped)"
```

---

### Task 14: Users module (admin account management)

**Files:**
- Create: `src/modules/users/users.schema.ts`, `src/modules/users/users.repository.ts`, `src/modules/users/users.service.ts`, `src/modules/users/users.controller.ts`, `src/modules/users/users.routes.ts`

**Interfaces:**
- Consumes: `UserModel`, `IUser`, bcrypt, pagination, `ApiError`, `ROLES`, auth.
- Produces: `userRoutes` mounted at `/users` (admin only). No register endpoint. `GET /`, `POST /`, `PATCH /:id/password`, `DELETE /:id` (soft delete).

- [ ] **Step 1: Create `src/modules/users/users.schema.ts`**

```ts
import { z } from 'zod';

export const createUserSchema = z.object({
  username: z.string().min(3),
  password: z.string().min(8),
  role: z.enum(['user']).default('user'), // admins are seeded only, never created via API
  person_id: z.string().nullable().optional(),
});

export const resetPasswordSchema = z.object({
  password: z.string().min(8),
});
```

- [ ] **Step 2: Create `src/modules/users/users.repository.ts`**

```ts
import { FilterQuery } from 'mongoose';
import { UserModel, IUser } from './users.model';
import { PaginationParams } from '../../utils/pagination';

const SAFE_FIELDS = '-password_hash -refreshTokenHash';

export const userRepo = {
  create: (data: Partial<IUser>) => UserModel.create(data),
  findByUsername: (username: string) => UserModel.findOne({ username }),
  findById: (id: string) => UserModel.findById(id),
  async findPaginated(filter: FilterQuery<IUser>, p: PaginationParams) {
    const [items, total] = await Promise.all([
      UserModel.find(filter).select(SAFE_FIELDS).sort({ createdAt: -1 }).skip(p.skip).limit(p.limit).lean(),
      UserModel.countDocuments(filter),
    ]);
    return { items, total };
  },
  updateById: (id: string, data: Partial<IUser>) =>
    UserModel.findByIdAndUpdate(id, data, { new: true }).select(SAFE_FIELDS).lean(),
};
```

- [ ] **Step 3: Create `src/modules/users/users.service.ts`**

```ts
import bcrypt from 'bcrypt';
import { userRepo } from './users.repository';
import { IUser } from './users.model';
import { ApiError } from '../../utils/ApiError';
import { getPagination, buildMeta } from '../../utils/pagination';
import { ROLES } from '../../constants/roles';

const BCRYPT_ROUNDS = 12;

interface CreateUserInput {
  username: string;
  password: string;
  person_id?: string | null;
}

export const userService = {
  async list(query: Record<string, string | undefined>) {
    const p = getPagination(query);
    const { items, total } = await userRepo.findPaginated({}, p);
    return { items, meta: buildMeta(total, p.page, p.limit) };
  },

  async create(input: CreateUserInput) {
    const existing = await userRepo.findByUsername(input.username);
    if (existing) throw new ApiError('DUPLICATE_USERNAME');
    const password_hash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
    const created = await userRepo.create({
      username: input.username,
      password_hash,
      role: ROLES.USER,
      person_id: (input.person_id as unknown as IUser['person_id']) ?? null,
      must_change_password: true,
      is_active: true,
    });
    return {
      id: String(created._id),
      username: created.username,
      role: created.role,
      person_id: created.person_id,
      must_change_password: created.must_change_password,
    };
  },

  async resetPassword(id: string, password: string) {
    const password_hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const updated = await userRepo.updateById(id, {
      password_hash,
      must_change_password: true,
      refreshTokenHash: null,
    });
    if (!updated) throw new ApiError('NOT_FOUND', 'User not found');
    return { id, updated: true };
  },

  async softDelete(id: string) {
    const updated = await userRepo.updateById(id, { is_active: false, refreshTokenHash: null });
    if (!updated) throw new ApiError('NOT_FOUND', 'User not found');
    return { id, is_active: false };
  },
};
```

- [ ] **Step 4: Create `src/modules/users/users.controller.ts`**

```ts
import { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { sendSuccess } from '../../utils/ApiResponse';
import { userService } from './users.service';

export const userController = {
  list: asyncHandler(async (req: Request, res: Response) => {
    const { items, meta } = await userService.list(req.query as Record<string, string>);
    sendSuccess(res, items, 200, meta);
  }),
  create: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await userService.create(req.body), 201);
  }),
  resetPassword: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await userService.resetPassword(req.params.id, req.body.password));
  }),
  remove: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await userService.softDelete(req.params.id));
  }),
};
```

- [ ] **Step 5: Create `src/modules/users/users.routes.ts`**

```ts
import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate';
import { authorize } from '../../middlewares/authorize';
import { validate } from '../../middlewares/validate';
import { ROLES } from '../../constants/roles';
import { userController } from './users.controller';
import { createUserSchema, resetPasswordSchema } from './users.schema';

export const userRoutes = Router();

userRoutes.use(authenticate, authorize(ROLES.ADMIN));
userRoutes.get('/', userController.list);
userRoutes.post('/', validate(createUserSchema), userController.create);
userRoutes.patch('/:id/password', validate(resetPasswordSchema), userController.resetPassword);
userRoutes.delete('/:id', userController.remove);
```

- [ ] **Step 6: Verify build and commit**

Run: `npx tsc --noEmit`
Expected: exit 0.
```bash
git add -A && git commit -m "feat: add users module (admin-managed accounts, soft delete)"
```

---

### Task 15: Logs module (admin scan-log query)

**Files:**
- Create: `src/modules/logs/logs.controller.ts`, `src/modules/logs/logs.routes.ts`

**Interfaces:**
- Consumes: `scanService.listLogs` (from Task 12), auth.
- Produces: `logRoutes` mounted at `/logs` (admin only). `GET /` — alias/dedicated endpoint over scan logs with the same filters as `/scan/logs`.

- [ ] **Step 1: Create `src/modules/logs/logs.controller.ts`**

```ts
import { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { sendSuccess } from '../../utils/ApiResponse';
import { scanService } from '../scan/scan.service';

export const logController = {
  list: asyncHandler(async (req: Request, res: Response) => {
    const { items, meta } = await scanService.listLogs(req.query as Record<string, string>);
    sendSuccess(res, items, 200, meta);
  }),
};
```

- [ ] **Step 2: Create `src/modules/logs/logs.routes.ts`**

```ts
import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate';
import { authorize } from '../../middlewares/authorize';
import { ROLES } from '../../constants/roles';
import { logController } from './logs.controller';

export const logRoutes = Router();

logRoutes.use(authenticate, authorize(ROLES.ADMIN));
logRoutes.get('/', logController.list);
```

- [ ] **Step 3: Verify build and commit**

Run: `npx tsc --noEmit`
Expected: exit 0.
```bash
git add -A && git commit -m "feat: add logs module (admin scan-log query)"
```

---

### Task 16: Dashboard module (role-branched)

**Files:**
- Create: `src/modules/dashboard/dashboard.service.ts`, `src/modules/dashboard/dashboard.controller.ts`, `src/modules/dashboard/dashboard.routes.ts`

**Interfaces:**
- Consumes: `PersonModel`, `VehicleModel`, `ScanLogModel`, `AttendanceModel`, `GateModel`, `attendanceRepo`, `AuthUser`, `ROLES`.
- Produces: `dashboardRoutes` mounted at `/dashboard`. `GET /` branches on role in the service.

- [ ] **Step 1: Create `src/modules/dashboard/dashboard.service.ts`**

```ts
import { PersonModel } from '../persons/persons.model';
import { VehicleModel } from '../vehicles/vehicles.model';
import { ScanLogModel } from '../scan/scan.model';
import { GateModel } from '../gates/gates.model';
import { AttendanceModel } from '../attendance/attendance.model';
import { ROLES, Role } from '../../constants/roles';

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

async function gateStatuses() {
  const gates = await GateModel.find().lean();
  return Promise.all(
    gates.map(async (g) => {
      const last = await ScanLogModel.findOne({ gate_id: g._id }).sort({ scan_time: -1 }).lean();
      const lastScan = last?.scan_time ?? null;
      const online = lastScan ? Date.now() - new Date(lastScan).getTime() < 5 * 60 * 1000 : false;
      return { name: g.name, last_scan: lastScan, status: online ? 'online' : 'offline' };
    })
  );
}

export const dashboardService = {
  async get(actor: { role: Role; personId: string | null }) {
    if (actor.role === ROLES.ADMIN) return this.adminView();
    if (actor.personId) return this.userView(actor.personId);
    return { gates: await gateStatuses() }; // unlinked / guard
  },

  async adminView() {
    const today = startOfToday();
    const [total_persons, total_vehicles, scan_events_today, denied_today, active_today, gates] =
      await Promise.all([
        PersonModel.countDocuments({}),
        VehicleModel.countDocuments({}),
        ScanLogModel.countDocuments({ scan_time: { $gte: today } }),
        ScanLogModel.countDocuments({ scan_time: { $gte: today }, access_result: 'denied' }),
        AttendanceModel.countDocuments({ date: todayKey() }),
        gateStatuses(),
      ]);
    return { total_persons, active_today, total_vehicles, scan_events_today, denied_today, gates };
  },

  async userView(personId: string) {
    const [person, vehicle, today, recent] = await Promise.all([
      PersonModel.findById(personId).lean(),
      VehicleModel.findOne({ owner_person_id: personId }).lean(),
      AttendanceModel.findOne({ person_id: personId, date: todayKey() }).lean(),
      AttendanceModel.find({ person_id: personId }).sort({ date: -1 }).limit(7).lean(),
    ]);
    return {
      person: person ? { full_name: person.full_name, status: person.status } : null,
      today: today
        ? { time_in: today.time_in, time_out: today.time_out, status: today.status }
        : null,
      recent_attendance: recent,
      vehicle: vehicle ? { plate_number: vehicle.plate_number, status: vehicle.status } : null,
    };
  },
};
```

- [ ] **Step 2: Create `src/modules/dashboard/dashboard.controller.ts`**

```ts
import { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { sendSuccess } from '../../utils/ApiResponse';
import { ApiError } from '../../utils/ApiError';
import { dashboardService } from './dashboard.service';

export const dashboardController = {
  get: asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw new ApiError('UNAUTHORIZED');
    const data = await dashboardService.get({ role: req.user.role, personId: req.user.personId });
    sendSuccess(res, data);
  }),
};
```

- [ ] **Step 3: Create `src/modules/dashboard/dashboard.routes.ts`**

```ts
import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate';
import { dashboardController } from './dashboard.controller';

export const dashboardRoutes = Router();

dashboardRoutes.use(authenticate);
dashboardRoutes.get('/', dashboardController.get);
```

- [ ] **Step 4: Verify build and commit**

Run: `npx tsc --noEmit`
Expected: exit 0.
```bash
git add -A && git commit -m "feat: add role-branched dashboard module"
```

---

### Task 17: Reports module (admin JSON reports)

**Files:**
- Create: `src/modules/reports/reports.service.ts`, `src/modules/reports/reports.controller.ts`, `src/modules/reports/reports.routes.ts`

**Interfaces:**
- Consumes: `AttendanceModel`, `PersonModel`, `ScanLogModel`, auth.
- Produces: `reportRoutes` mounted at `/reports` (admin only). `GET /attendance`, `GET /gate-activity`. JSON only.

- [ ] **Step 1: Create `src/modules/reports/reports.service.ts`**

```ts
import { FilterQuery } from 'mongoose';
import { AttendanceModel, IAttendance } from '../attendance/attendance.model';
import { ScanLogModel, IScanLog } from '../scan/scan.model';

interface AttendanceReportQuery {
  from?: string;
  to?: string;
  status?: string;
}

interface GateActivityQuery {
  gate_id?: string;
  from?: string;
  to?: string;
}

export const reportService = {
  async attendance(query: AttendanceReportQuery) {
    const filter: FilterQuery<IAttendance> = {};
    if (query.status) filter.status = query.status;
    if (query.from || query.to) {
      const range: Record<string, string> = {};
      if (query.from) range.$gte = query.from;
      if (query.to) range.$lte = query.to;
      filter.date = range;
    }
    const rows = await AttendanceModel.find(filter).sort({ date: -1 }).lean();
    return { count: rows.length, rows };
  },

  async gateActivity(query: GateActivityQuery) {
    const match: FilterQuery<IScanLog> = {};
    if (query.gate_id) match.gate_id = query.gate_id as unknown as IScanLog['gate_id'];
    if (query.from || query.to) {
      const range: Record<string, Date> = {};
      if (query.from) range.$gte = new Date(query.from);
      if (query.to) range.$lte = new Date(query.to);
      match.scan_time = range;
    }
    const rows = await ScanLogModel.aggregate([
      { $match: match },
      {
        $group: {
          _id: { gate_id: '$gate_id', access_result: '$access_result' },
          count: { $sum: 1 },
        },
      },
    ]);
    return { count: rows.length, rows };
  },
};
```

- [ ] **Step 2: Create `src/modules/reports/reports.controller.ts`**

```ts
import { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { sendSuccess } from '../../utils/ApiResponse';
import { reportService } from './reports.service';

export const reportController = {
  attendance: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await reportService.attendance(req.query as Record<string, string>));
  }),
  gateActivity: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await reportService.gateActivity(req.query as Record<string, string>));
  }),
};
```

- [ ] **Step 3: Create `src/modules/reports/reports.routes.ts`**

```ts
import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate';
import { authorize } from '../../middlewares/authorize';
import { ROLES } from '../../constants/roles';
import { reportController } from './reports.controller';

export const reportRoutes = Router();

reportRoutes.use(authenticate, authorize(ROLES.ADMIN));
reportRoutes.get('/attendance', reportController.attendance);
reportRoutes.get('/gate-activity', reportController.gateActivity);
```

- [ ] **Step 4: Verify build and commit**

Run: `npx tsc --noEmit`
Expected: exit 0.
```bash
git add -A && git commit -m "feat: add reports module (attendance, gate-activity)"
```

---

### Task 18: App + server wiring

**Files:**
- Create: `src/app.ts`, `src/server.ts`

**Interfaces:**
- Consumes: every `*Routes` router, all middleware, `connectDB`, `disconnectDB`, `env`.
- Produces: `createApp(): Express` and a running server with graceful shutdown.

- [ ] **Step 1: Create `src/app.ts`**

```ts
import express, { Express } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { env } from './config/env';
import { requestLogger } from './middlewares/requestLogger';
import { globalLimiter } from './middlewares/rateLimiter';
import { notFound } from './middlewares/notFound';
import { errorHandler } from './middlewares/errorHandler';

import { authRoutes } from './modules/auth/auth.routes';
import { personRoutes } from './modules/persons/persons.routes';
import { vehicleRoutes } from './modules/vehicles/vehicles.routes';
import { gateRoutes } from './modules/gates/gates.routes';
import { scanRoutes } from './modules/scan/scan.routes';
import { attendanceRoutes } from './modules/attendance/attendance.routes';
import { userRoutes } from './modules/users/users.routes';
import { logRoutes } from './modules/logs/logs.routes';
import { dashboardRoutes } from './modules/dashboard/dashboard.routes';
import { reportRoutes } from './modules/reports/reports.routes';

export function createApp(): Express {
  const app = express();

  app.use(helmet());
  app.use(
    cors({
      origin: env.ALLOWED_ORIGINS_LIST,
      credentials: true,
    })
  );
  app.use(cookieParser(env.COOKIE_SECRET));
  app.use(express.json());
  app.use(requestLogger);
  app.use(globalLimiter);

  app.get('/health', (_req, res) => res.json({ success: true, data: { status: 'ok' } }));

  const prefix = env.API_PREFIX;
  app.use(`${prefix}/auth`, authRoutes);
  app.use(`${prefix}/persons`, personRoutes);
  app.use(`${prefix}/vehicles`, vehicleRoutes);
  app.use(`${prefix}/gates`, gateRoutes);
  app.use(`${prefix}/scan`, scanRoutes);
  app.use(`${prefix}/attendance`, attendanceRoutes);
  app.use(`${prefix}/users`, userRoutes);
  app.use(`${prefix}/logs`, logRoutes);
  app.use(`${prefix}/dashboard`, dashboardRoutes);
  app.use(`${prefix}/reports`, reportRoutes);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
```

- [ ] **Step 2: Create `src/server.ts`**

```ts
import { createApp } from './app';
import { connectDB, disconnectDB } from './config/db';
import { env } from './config/env';

async function bootstrap(): Promise<void> {
  await connectDB();
  const app = createApp();
  const server = app.listen(env.PORT, () => {
    console.log(`[server] listening on port ${env.PORT} (${env.NODE_ENV})`);
  });

  const shutdown = async (signal: string) => {
    console.log(`[server] ${signal} received, shutting down`);
    server.close(async () => {
      await disconnectDB();
      process.exit(0);
    });
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

bootstrap().catch((err) => {
  console.error('[server] failed to start', err);
  process.exit(1);
});
```

- [ ] **Step 3: Verify build (full compile to dist)**

Run: `npm run build`
Expected: exit 0, `dist/` populated.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: wire Express app and server bootstrap"
```

---

### Task 19: Seed script + README

**Files:**
- Create: `src/config/seed.ts`, `README.md`

**Interfaces:**
- Consumes: `connectDB`, `disconnectDB`, `UserModel`, `GateModel`, `env`, bcrypt, `ROLES`.
- Produces: runnable `npm run seed` that creates the admin (idempotent) + 4 fixed gates (idempotent). README documents setup/run.

- [ ] **Step 1: Create `src/config/seed.ts`**

```ts
import bcrypt from 'bcrypt';
import { connectDB, disconnectDB } from './db';
import { env } from './env';
import { UserModel } from '../modules/users/users.model';
import { GateModel } from '../modules/gates/gates.model';
import { ROLES } from '../constants/roles';

const GATES = [
  { name: 'Main Entrance', type: 'person' as const, location: 'Front Building Gate A' },
  { name: 'Side Gate', type: 'person' as const, location: 'South Wing Gate B' },
  { name: 'Parking Entrance', type: 'vehicle' as const, location: 'Parking Lot Entry' },
  { name: 'Parking Exit', type: 'vehicle' as const, location: 'Parking Lot Exit' },
];

async function seed(): Promise<void> {
  await connectDB();

  // Admin (idempotent)
  const existingAdmin = await UserModel.findOne({ username: env.ADMIN_USERNAME });
  if (existingAdmin) {
    console.log(`[seed] admin '${env.ADMIN_USERNAME}' already exists — skipping`);
  } else {
    const password_hash = await bcrypt.hash(env.ADMIN_PASSWORD, 12);
    await UserModel.create({
      username: env.ADMIN_USERNAME,
      password_hash,
      role: ROLES.ADMIN,
      person_id: null,
      must_change_password: true,
      is_active: true,
    });
    console.log(`[seed] created admin '${env.ADMIN_USERNAME}'`);
  }

  // Gates (idempotent by name)
  for (const g of GATES) {
    const exists = await GateModel.findOne({ name: g.name });
    if (exists) {
      console.log(`[seed] gate '${g.name}' already exists — skipping`);
    } else {
      await GateModel.create(g);
      console.log(`[seed] created gate '${g.name}'`);
    }
  }

  await disconnectDB();
  console.log('[seed] done');
}

seed().catch(async (err) => {
  console.error('[seed] failed', err);
  await disconnectDB().catch(() => undefined);
  process.exit(1);
});
```

- [ ] **Step 2: Create `README.md`**

```markdown
# NCST RFID Backend

TypeScript + Express + MongoDB (Atlas) backend for the NCST campus RFID gate system.
See `../userpage/ncst_rfid_serverside_flow.md` for the full API blueprint.

## Setup

```bash
npm install
cp .env.example .env   # fill in MONGODB_URI, JWT secrets, admin creds
npm run seed           # creates admin + 4 gates (run once)
npm run dev            # start with hot reload
```

## Scripts

- `npm run dev` — ts-node-dev hot reload
- `npm run build` — compile to `dist/`
- `npm start` — run compiled server
- `npm run seed` — seed admin + gates (idempotent)
- `npm run lint` — eslint

## Notes

- No public registration — admin is seeded, users are admin-created.
- Access token (15m) in response body; refresh token (7d) in httpOnly cookie with rotation.
- `scan/tap` always returns HTTP 200; `granted`/`denied` is in the body.
- After first seed, remove `ADMIN_PASSWORD` from the production `.env`.
```

- [ ] **Step 3: Verify build and commit**

Run: `npm run build`
Expected: exit 0.
```bash
git add -A && git commit -m "feat: add seed script and README"
```

---

## Self-Review Notes

**Spec coverage:** All 10 modules (auth, persons, vehicles, gates, scan, attendance, users, logs, dashboard, reports) → Tasks 8–17. Config/env/db → Task 2. Models with all indexes (unique rfid_uid, unique plate, unique owner_person_id, TTL scan_time, compound attendance) → Task 6. Auth (HS256, 15m/7d, httpOnly cookie, refresh rotation via `refreshTokenHash`) → Tasks 7–8. Role matrix → per-route `authorize` + in-service branching (dashboard, attendance). Error code table → Task 3 `errors.ts` + Task 5 `errorHandler`. Seed (admin + 4 gates, idempotent) → Task 19. `.env.example` with all vars incl. `LATE_CUTOFF_TIME` → Task 1.

**Vehicle RFID (amended):** Vehicles carry a unique `rfid_uid` (Task 6/10) so gate taps resolve vehicles as well as persons. Person lookup wins first; vehicle is the fallback. Granted vehicle taps log to `scan_logs` but never touch `attendance_summary`. Duplicate `rfid_uid` across the vehicles collection is rejected with `DUPLICATE_RFID`.

**Type consistency:** `attendanceRepo` defined in Task 12, reused in Tasks 13/16. `scanService.listLogs` defined in Task 12, reused in Task 15. `TokenPayload`/`AuthUser` consistent across Tasks 4/7/8. Repo method names (`findPaginated`, `updateById`, `findByRfid`) consistent across consumers.

**No placeholders:** every step carries full file content and exact commands.
