# Registration Photos and Gate Terminals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a photo upload pipeline to person registration, and four browser-based gate terminal pages that read USB RFID cards and display the access decision with the cardholder's face.

**Architecture:** Photos live in a separate `PersonPhoto` MongoDB collection served by an authenticated endpoint; because the API uses `Authorization: Bearer`, every photo is fetched as a blob rather than through a plain `<img src>`. Each gate terminal is a Next.js page authenticated by a per-gate device key in `X-Gate-Key`; the server derives gate and direction from the key, so the terminal posts only a UID.

**Tech Stack:** Express 4 + Mongoose 8 + Zod 3 + TypeScript 5 (serverside); Next.js 16.2.10 App Router + React 19 + Tailwind 4 (userpage). No test framework — verification is a `ts-node` harness following `src/config/verifyRoles.ts`.

**Spec:** `docs/superpowers/specs/2026-07-27-photo-and-gate-terminals-design.md`

## Global Constraints

- **Two repos.** `C:\thesis_rfid\serverside` (API) and `C:\thesis_rfid\userpage` (Next.js). Every task states which. Commit in the repo you changed; never stage across both.
- **Next.js 16.2.10 is not the Next.js you know.** `userpage/AGENTS.md` requires reading the relevant guide in `node_modules/next/dist/docs/` before writing App Router code. For this plan: `01-app/01-getting-started/03-layouts-and-pages.md` and `01-app/03-api-reference/03-file-conventions/route-groups.md`.
- **No test framework.** Do not add Jest, Vitest, or Supertest. Backend verification extends `src/config/verifyGates.ts`, run with `npm run verify:gates`, following `verifyRoles.ts` conventions exactly.
- **Harness standards** (each caught a real defect in Subsystem A): every assertion must be able to fail; assertions over collections need a length floor because `.every()` on `[]` is `true`; any assertion comparing two values must confirm both are present rather than comparing `undefined` to `undefined`; two consecutive runs produce byte-identical output.
- **Harness state:** the harness restores what it can reach over HTTP (photos it uploaded, for instance). Scan logs and attendance rollups are append-only by design — writing them *is* the behavior under test, and no endpoint deletes them. Assertions therefore read the newest row and check freshness rather than counting rows, which is what keeps repeated runs deterministic. Do not add direct database access to the harness to work around this; `verify:roles` is black-box HTTP and this one stays that way.
- **Photo dimensions:** cover-crop to exactly `400x400`, JPEG quality `0.82`.
- **Upload cap:** `1048576` bytes (1MB) hard limit.
- **Key format:** `gk_live_` + 8 hex chars (the stored `key_prefix`) + 32 hex chars (the secret). Total 48 characters.
- **Photo route value:** `Person.photo_url` is set to exactly `/persons/<id>/photo` on upload.
- **Auto-reset delay** on the gate terminal: `5000` ms.
- **UID validation regex** (client and server): `/^[0-9A-Fa-f]{6,32}$/`.
- **Never log a plaintext device key.** Log `key_prefix` only.
- Running services for harness runs: `npm run dev` in `serverside`, and `npm run seed:test` already applied.

## File Structure

**serverside — create**

| File | Responsibility |
|---|---|
| `src/utils/imageType.ts` | Magic-byte image sniffing. Pure, no I/O. |
| `src/modules/persons/personPhotos.model.ts` | `PersonPhoto` schema. |
| `src/modules/persons/personPhotos.repository.ts` | Photo data access. |
| `src/modules/persons/personPhotos.service.ts` | Upload/fetch/delete rules and validation. |
| `src/middlewares/uploadPhoto.ts` | Multer instance + error translation. |
| `src/modules/gates/gateKeys.model.ts` | `GateKey` schema. |
| `src/modules/gates/gateKeys.repository.ts` | Key data access. |
| `src/modules/gates/gateKeys.service.ts` | Mint, revoke, authenticate a key. |
| `src/middlewares/authenticateGate.ts` | `X-Gate-Key` -> `req.gate`. |
| `src/middlewares/authenticateAny.ts` | Gate key OR JWT, for the photo GET. |
| `src/config/verifyGates.ts` | The 12-assertion harness. |

**serverside — modify**

| File | Change |
|---|---|
| `src/constants/errors.ts` | Add `PAYLOAD_TOO_LARGE`. |
| `src/types/express.d.ts` | Add `req.gate`. |
| `src/types/index.ts` | Add `GateContext`. |
| `src/modules/gates/gates.model.ts` | Add `direction`. |
| `src/modules/gates/gates.repository.ts` | Add `findByTypeAndDirection`. |
| `src/modules/gates/gates.routes.ts` | Add `POST /:id/key`. |
| `src/modules/gates/gates.controller.ts` | Add `mintKey`. |
| `src/modules/persons/persons.routes.ts` | Add three photo routes. |
| `src/modules/persons/persons.controller.ts` | Add photo handlers. |
| `src/modules/scan/scan.routes.ts` | Per-route auth instead of blanket `use`. |
| `src/modules/scan/scan.schema.ts` | Split device vs JWT tap schemas. |
| `src/modules/scan/scan.service.ts` | `wrong_gate_type` rule. |
| `src/config/seed.ts`, `src/config/testSeed.ts` | `direction`, keys, seeded photos. |
| `package.json` | `multer` dep, `verify:gates` script. |

**userpage — create**

| File | Responsibility |
|---|---|
| `lib/photos.ts` | Classify a `photo_url` into a render strategy. |
| `lib/gateTerminal.ts` | Device-key storage + the tap call. |
| `components/AuthedImage.tsx` | Credentialed fetch -> blob -> `<img>`. |
| `components/PhotoCapture.tsx` | Upload/camera tabs -> one JPEG blob. |
| `components/gate/GateTerminal.tsx` | Terminal states and wedge capture. |
| `components/gate/GateProvisioning.tsx` | First-run setup screen. |
| `app/gate/person-entry/page.tsx` (and 3 siblings) | The four routes. |

**userpage — modify**

| File | Change |
|---|---|
| `lib/auth.ts` | Add `apiUpload`, `apiDelete`, `authedBlob`. |
| `components/PersonForm.tsx` | Replace the Photo URL text input. |
| `components/RegistrationForm.tsx`, `components/PersonProfile.tsx`, `components/ProfileView.tsx` | Render via `AuthedImage`. |

---

## Task 1: Image type detection and the PersonPhoto model

**Files:**
- Create: `serverside/src/utils/imageType.ts`
- Create: `serverside/src/modules/persons/personPhotos.model.ts`
- Create: `serverside/src/config/verifyGates.ts`
- Modify: `serverside/src/constants/errors.ts`
- Modify: `serverside/package.json`

**Interfaces:**
- Consumes: nothing.
- Produces: `detectImageType(buf: Buffer): 'image/jpeg' | 'image/png' | 'image/webp' | null`; `PersonPhotoModel` with `IPersonPhoto { person_id, data, mime, byte_size, updatedAt }`; harness helpers `expectEqual(name, actual, expected)`, `summary()`.

- [ ] **Step 1: Write the failing assertions**

Create `serverside/src/config/verifyGates.ts`. This file grows across later tasks; it starts with the pure checks that need no server.

```ts
/**
 * Asserts the photo pipeline and gate terminal behavior in
 * docs/superpowers/specs/2026-07-27-photo-and-gate-terminals-design.md.
 *
 * Requires: `npm run dev` running, and `npm run seed:test` already applied.
 * Run with: npm run verify:gates
 */
import { detectImageType } from '../utils/imageType';

const failures: string[] = [];
let checks = 0;

function expectEqual(name: string, actual: unknown, expected: unknown): void {
  checks++;
  if (actual !== expected) {
    failures.push(`${name}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
    console.log(`  FAIL ${name} — ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
    return;
  }
  console.log(`  ok   ${name}`);
}

function summary(): void {
  console.log(`\n${checks - failures.length}/${checks} checks passed`);
  if (failures.length) {
    console.log('\nFAILURES:');
    failures.forEach((f) => console.log(`  - ${f}`));
    process.exit(1);
  }
  console.log('All gate and photo checks passed.');
}

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.from([0x24, 0x00, 0x00, 0x00]),
  Buffer.from('WEBP'),
]);
const TEXT = Buffer.from('this is not an image at all, not even close');

async function main(): Promise<void> {
  console.log('\n== magic-byte detection ==');
  expectEqual('jpeg detected', detectImageType(JPEG), 'image/jpeg');
  expectEqual('png detected', detectImageType(PNG), 'image/png');
  expectEqual('webp detected', detectImageType(WEBP), 'image/webp');
  expectEqual('text rejected', detectImageType(TEXT), null);
  expectEqual('empty buffer rejected', detectImageType(Buffer.alloc(0)), null);
  expectEqual('truncated jpeg rejected', detectImageType(Buffer.from([0xff, 0xd8])), null);

  summary();
}

main().catch((err) => {
  console.error('[verify:gates] failed', err);
  process.exit(1);
});
```

Add the script to `serverside/package.json`:

```json
    "verify:gates": "ts-node src/config/verifyGates.ts",
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd C:\thesis_rfid\serverside && npm run verify:gates`
Expected: FAIL — `Cannot find module '../utils/imageType'`.

- [ ] **Step 3: Implement the detector**

Create `serverside/src/utils/imageType.ts`:

```ts
export type ImageMime = 'image/jpeg' | 'image/png' | 'image/webp';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWith(buf: Buffer, bytes: number[], offset = 0): boolean {
  if (buf.length < offset + bytes.length) return false;
  return bytes.every((b, i) => buf[offset + i] === b);
}

/**
 * Identifies an image by its leading bytes. A client-declared Content-Type is
 * not evidence of content, so uploads are classified from the bytes alone and
 * the result is what gets stored and later served.
 *
 * Returns null for anything not on the whitelist.
 */
export function detectImageType(buf: Buffer): ImageMime | null {
  // JPEG: FF D8 FF, then a marker byte — 3 bytes alone is a truncated file.
  if (buf.length >= 4 && startsWith(buf, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(buf, PNG_SIGNATURE)) return 'image/png';
  // WebP: "RIFF" then 4 size bytes then "WEBP".
  if (
    buf.length >= 12 &&
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}
```

- [ ] **Step 4: Run the harness and verify it passes**

Run: `npm run verify:gates`
Expected: PASS — `6/6 checks passed`.

- [ ] **Step 5: Create the PersonPhoto model**

Create `serverside/src/modules/persons/personPhotos.model.ts`:

```ts
import { Schema, model, Document, Types } from 'mongoose';
import { ImageMime } from '../../utils/imageType';

export interface IPersonPhoto extends Document {
  _id: Types.ObjectId;
  person_id: Types.ObjectId;
  data: Buffer;
  mime: ImageMime;
  byte_size: number;
  updatedAt: Date;
}

const personPhotoSchema = new Schema<IPersonPhoto>(
  {
    // Unique: a second upload replaces the first rather than orphaning it.
    person_id: {
      type: Schema.Types.ObjectId,
      ref: 'Person',
      required: true,
      unique: true,
      index: true,
    },
    data: { type: Buffer, required: true },
    mime: {
      type: String,
      enum: ['image/jpeg', 'image/png', 'image/webp'],
      required: true,
    },
    byte_size: { type: Number, required: true },
  },
  { timestamps: { createdAt: false, updatedAt: true } }
);

export const PersonPhotoModel = model<IPersonPhoto>('PersonPhoto', personPhotoSchema);
```

- [ ] **Step 6: Add the payload-size error code**

In `serverside/src/constants/errors.ts`, add inside `ERROR_CODES`, after `VALIDATION_ERROR`:

```ts
  PAYLOAD_TOO_LARGE: { status: 413, message: 'Uploaded file is too large' },
```

- [ ] **Step 7: Verify it compiles**

Run: `npm run build`
Expected: exit 0, no TypeScript errors.

- [ ] **Step 8: Commit**

```bash
cd C:\thesis_rfid\serverside
git add src/utils/imageType.ts src/modules/persons/personPhotos.model.ts src/config/verifyGates.ts src/constants/errors.ts package.json
git commit -m "feat(photos): magic-byte image detection and PersonPhoto model"
```

---

## Task 2: Photo upload, serve, and delete endpoints

**Files:**
- Create: `serverside/src/modules/persons/personPhotos.repository.ts`
- Create: `serverside/src/modules/persons/personPhotos.service.ts`
- Create: `serverside/src/middlewares/uploadPhoto.ts`
- Modify: `serverside/src/modules/persons/persons.controller.ts`
- Modify: `serverside/src/modules/persons/persons.routes.ts`
- Modify: `serverside/src/config/verifyGates.ts`

**Interfaces:**
- Consumes: `detectImageType`, `PersonPhotoModel`, `PAYLOAD_TOO_LARGE` (Task 1).
- Produces: `POST /persons/:id/photo` (field name `photo`, returns `{ photo_url, byte_size, mime }`), `GET /persons/:id/photo` (raw bytes), `DELETE /persons/:id/photo`; harness helpers `login`, `request`, `uploadPhoto`.

- [ ] **Step 1: Install multer**

Run:
```bash
cd C:\thesis_rfid\serverside
npm install multer
npm install --save-dev @types/multer
```

- [ ] **Step 2: Write the failing assertions**

In `verifyGates.ts`, add these helpers above `main` (they mirror `verifyRoles.ts`):

```ts
const BASE = process.env.VERIFY_BASE_URL ?? 'http://localhost:3000/api';

async function login(username: string, password: string): Promise<string> {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const body = (await res.json()) as { data?: { accessToken?: string } };
  const token = body.data?.accessToken;
  if (!token) throw new Error(`login failed for '${username}' (HTTP ${res.status})`);
  return token;
}

async function request(
  token: string | null,
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    // Some responses have no JSON body; the status is what matters.
  }
  return { status: res.status, json };
}

/** Posts a multipart photo. `headers` supplies the credential (Bearer or X-Gate-Key). */
async function uploadPhoto(
  headers: Record<string, string>,
  personId: string,
  bytes: Buffer,
  filename: string,
  declaredMime: string
): Promise<{ status: number; json: Record<string, unknown> }> {
  const form = new FormData();
  form.append('photo', new Blob([bytes], { type: declaredMime }), filename);
  const res = await fetch(`${BASE}/persons/${personId}/photo`, {
    method: 'POST',
    headers,
    body: form,
  });
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    // no body
  }
  return { status: res.status, json };
}

/** A real 1x1 JPEG, so uploads exercise the same path a browser would. */
const TINY_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
    'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
    'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64'
);
```

Add to `main`, after the magic-byte block:

```ts
  const superadmin = await login('testadmin', 'Admin@123');
  const registrar = await login('testregistrar', 'Registrar@123');
  const student = await login('2025-0001', 'Student@123');
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  // Juan Dela Cruz — seeded by seed:test.
  const list = await request(superadmin, 'GET', '/persons?limit=100');
  const persons = (list.json.data ?? []) as { _id: string; id_number: string }[];
  if (persons.length < 4) {
    throw new Error(`expected at least 4 seeded persons, got ${persons.length}`);
  }
  const juan = persons.find((p) => p.id_number === '2025-0001');
  if (!juan) throw new Error('seeded person 2025-0001 not found — run npm run seed:test');
  const personId = juan._id;

  console.log('\n== photo upload validation ==');

  const notAnImage = await uploadPhoto(
    auth(registrar),
    personId,
    Buffer.from('definitely not an image, but I claim to be a jpeg'),
    'evil.jpg',
    'image/jpeg'
  );
  expectEqual('non-image with jpeg mime rejected', notAnImage.status, 422);

  const tooBig = await uploadPhoto(
    auth(registrar),
    personId,
    Buffer.concat([TINY_JPEG, Buffer.alloc(1_100_000, 0x20)]),
    'huge.jpg',
    'image/jpeg'
  );
  expectEqual('over-1MB upload rejected', tooBig.status, 413);

  console.log('\n== photo upload, serve, replace ==');

  const first = await uploadPhoto(auth(registrar), personId, TINY_JPEG, 'a.jpg', 'image/jpeg');
  expectEqual('registrar can upload', first.status, 201);
  expectEqual(
    'photo_url points at the internal route',
    (first.json.data as { photo_url?: string } | undefined)?.photo_url,
    `/persons/${personId}/photo`
  );

  const second = await uploadPhoto(auth(registrar), personId, TINY_JPEG, 'b.jpg', 'image/jpeg');
  expectEqual('re-upload replaces rather than erroring', second.status, 201);

  // The delete at the end of this block proves the re-upload replaced rather
  // than duplicated: if two documents existed, deleteOne would leave one behind
  // and the final 404 assertion would fail.
  const asStudent = await fetch(`${BASE}/persons/${personId}/photo`, {
    headers: auth(student),
  });
  expectEqual('any authenticated user may fetch a photo', asStudent.status, 200);
  expectEqual(
    'photo served as image/jpeg',
    asStudent.headers.get('content-type'),
    'image/jpeg'
  );
  expectEqual(
    'photo served with nosniff',
    asStudent.headers.get('x-content-type-options'),
    'nosniff'
  );

  const noCred = await fetch(`${BASE}/persons/${personId}/photo`);
  expectEqual('photo requires a credential', noCred.status, 401);

  // Restore: the seed leaves Juan without a photo, so remove what we added.
  const cleaned = await request(superadmin, 'DELETE', `/persons/${personId}/photo`);
  expectEqual('photo deleted', cleaned.status, 200);
  const afterDelete = await fetch(`${BASE}/persons/${personId}/photo`, { headers: auth(student) });
  expectEqual('deleted photo returns 404', afterDelete.status, 404);
```

- [ ] **Step 3: Run it to make sure it fails**

Run: `npm run verify:gates` (with `npm run dev` running in another terminal)
Expected: FAIL — the upload checks return 404, because the route does not exist.

- [ ] **Step 4: Write the repository**

Create `serverside/src/modules/persons/personPhotos.repository.ts`:

```ts
import { Types } from 'mongoose';
import { PersonPhotoModel, IPersonPhoto } from './personPhotos.model';
import { ImageMime } from '../../utils/imageType';

export const personPhotoRepo = {
  findByPersonId: (personId: string) =>
    PersonPhotoModel.findOne({ person_id: new Types.ObjectId(personId) }).lean<IPersonPhoto | null>(),

  /** Upsert keeps the unique person_id index satisfied on re-upload. */
  upsert: (personId: string, data: Buffer, mime: ImageMime) =>
    PersonPhotoModel.findOneAndUpdate(
      { person_id: new Types.ObjectId(personId) },
      { data, mime, byte_size: data.length },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean<IPersonPhoto>(),

  deleteByPersonId: (personId: string) =>
    PersonPhotoModel.deleteOne({ person_id: new Types.ObjectId(personId) }),

  countByPersonId: (personId: string) =>
    PersonPhotoModel.countDocuments({ person_id: new Types.ObjectId(personId) }),
};
```

- [ ] **Step 5: Write the multer middleware**

Create `serverside/src/middlewares/uploadPhoto.ts`:

```ts
import { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { ApiError } from '../utils/ApiError';

export const MAX_PHOTO_BYTES = 1_048_576;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PHOTO_BYTES, files: 1 },
}).single('photo');

/**
 * Multer reports its own errors rather than throwing ApiError, so they are
 * translated here. A size overrun is 413, not a generic validation failure.
 */
export function uploadPhoto(req: Request, res: Response, next: NextFunction): void {
  upload(req, res, (err: unknown) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        next(new ApiError('PAYLOAD_TOO_LARGE'));
        return;
      }
      next(new ApiError('VALIDATION_ERROR', err.message));
      return;
    }
    if (err) {
      next(err);
      return;
    }
    next();
  });
}
```

- [ ] **Step 6: Write the service**

Create `serverside/src/modules/persons/personPhotos.service.ts`:

```ts
import { Types } from 'mongoose';
import { personPhotoRepo } from './personPhotos.repository';
import { PersonModel } from './persons.model';
import { detectImageType } from '../../utils/imageType';
import { ApiError } from '../../utils/ApiError';

const INTERNAL_PHOTO_URL = (id: string) => `/persons/${id}/photo`;

function assertValidId(id: string): void {
  if (!Types.ObjectId.isValid(id)) throw new ApiError('NOT_FOUND', 'Person not found');
}

export const personPhotoService = {
  async upload(personId: string, file: Express.Multer.File | undefined) {
    assertValidId(personId);
    if (!file) throw new ApiError('VALIDATION_ERROR', 'No photo uploaded (field name: photo)');

    const person = await PersonModel.findById(personId);
    if (!person) throw new ApiError('NOT_FOUND', 'Person not found');

    // The declared Content-Type is ignored; only the bytes decide.
    const mime = detectImageType(file.buffer);
    if (!mime) {
      throw new ApiError('VALIDATION_ERROR', 'File is not a JPEG, PNG, or WebP image');
    }

    const saved = await personPhotoRepo.upsert(personId, file.buffer, mime);
    person.photo_url = INTERNAL_PHOTO_URL(personId);
    await person.save();

    return { photo_url: person.photo_url, mime: saved.mime, byte_size: saved.byte_size };
  },

  async get(personId: string) {
    assertValidId(personId);
    const photo = await personPhotoRepo.findByPersonId(personId);
    if (!photo) throw new ApiError('NOT_FOUND', 'No photo on file');
    return photo;
  },

  async remove(personId: string) {
    assertValidId(personId);
    const person = await PersonModel.findById(personId);
    if (!person) throw new ApiError('NOT_FOUND', 'Person not found');

    await personPhotoRepo.deleteByPersonId(personId);

    // Only clear photo_url when it points at us. An externally hosted URL
    // (bulk CSV import) is not ours to erase.
    if (person.photo_url === INTERNAL_PHOTO_URL(personId)) {
      person.photo_url = undefined;
      await person.save();
    }
    return { photo_url: person.photo_url ?? null };
  },
};
```

- [ ] **Step 7: Add the controller handlers**

In `serverside/src/modules/persons/persons.controller.ts`, add the import:

```ts
import { personPhotoService } from './personPhotos.service';
```

and add these handlers inside the `personController` object:

```ts
  uploadPhoto: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await personPhotoService.upload(req.params.id, req.file), 201);
  }),
  getPhoto: asyncHandler(async (req: Request, res: Response) => {
    const photo = await personPhotoService.get(req.params.id);
    const etag = `W/"${photo.updatedAt.getTime()}-${photo.byte_size}"`;
    // A gate terminal re-requests the same faces all day.
    if (req.headers['if-none-match'] === etag) {
      res.status(304).end();
      return;
    }
    res.setHeader('Content-Type', photo.mime);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('ETag', etag);
    res.status(200).send(photo.data);
  }),
  deletePhoto: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await personPhotoService.remove(req.params.id));
  }),
```

- [ ] **Step 8: Wire the routes**

In `serverside/src/modules/persons/persons.routes.ts`, add `uploadPhoto` to the imports:

```ts
import { uploadPhoto } from '../../middlewares/uploadPhoto';
```

Insert this **above** the existing `personRoutes.use(authenticate, authorize(...))` line — the router-level authorize would otherwise lock students out of a photo their own dashboard renders:

```ts
// Declared before the router-level authorize on purpose: any authenticated
// user may fetch a photo (a student's dashboard renders their own), while
// everything below is registrar/superadmin only.
personRoutes.get('/:id/photo', authenticate, personController.getPhoto);
```

Then add these after the existing `personRoutes.patch('/:id/rfid', ...)` line:

```ts
personRoutes.post('/:id/photo', uploadPhoto, personController.uploadPhoto);
personRoutes.delete('/:id/photo', personController.deletePhoto);
```

- [ ] **Step 9: Run the harness and verify it passes**

Run: `npm run verify:gates`
Expected: PASS — all magic-byte and photo checks pass.

- [ ] **Step 10: Verify re-runnability**

Run: `npm run verify:gates && npm run verify:gates`
Expected: identical output both times. The delete at the end restores the seeded state, so the second run behaves like the first.

- [ ] **Step 11: Commit**

```bash
cd C:\thesis_rfid\serverside
git add src/modules/persons src/middlewares/uploadPhoto.ts src/config/verifyGates.ts package.json package-lock.json
git commit -m "feat(photos): upload, serve, and delete person photos"
```

---

## Task 3: Frontend photo fetching primitives

**Files:**
- Create: `userpage/lib/photos.ts`
- Create: `userpage/components/AuthedImage.tsx`
- Modify: `userpage/lib/auth.ts`

**Interfaces:**
- Consumes: `GET /persons/:id/photo` (Task 2).
- Produces: `classifyPhotoUrl(url)` returning `{ kind: 'internal' | 'external' | 'none'; src: string }`; `<AuthedImage src alt className fallback />`; `apiUpload<T>(path, form)`, `apiDelete<T>(path)`, `authedBlob(path, headers?)` in `lib/auth.ts`.

- [ ] **Step 1: Read the Next.js client component guide**

Read `userpage/node_modules/next/dist/docs/01-app/03-api-reference/01-directives/use-client.md`. `AGENTS.md` requires this; this version's conventions may differ from what you expect.

- [ ] **Step 2: Add the transport helpers**

In `userpage/lib/auth.ts`, add after the existing `apiPost`:

```ts
/** POST multipart form data. The browser sets Content-Type with its own boundary. */
export async function apiUpload<T>(path: string, form: FormData): Promise<T> {
  const token = getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    credentials: "include",
    body: form,
  });
  const body = (await res.json().catch(() => null)) as
    | { success: true; data: T }
    | { success: false; code?: string; message?: string }
    | null;
  if (!res.ok || !body || body.success !== true) {
    const failure = body as { code?: string; message?: string } | null;
    const err: ApiError = new Error(failure?.message ?? "Upload failed");
    err.code = failure?.code;
    err.status = res.status;
    throw err;
  }
  return body.data;
}

export async function apiDelete<T>(path: string): Promise<T> {
  const token = getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    method: "DELETE",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    credentials: "include",
  });
  const body = (await res.json().catch(() => null)) as
    | { success: true; data: T }
    | { success: false; code?: string; message?: string }
    | null;
  if (!res.ok || !body || body.success !== true) {
    const failure = body as { code?: string; message?: string } | null;
    const err: ApiError = new Error(failure?.message ?? "Request failed");
    err.code = failure?.code;
    err.status = res.status;
    throw err;
  }
  return body.data;
}

/**
 * Fetches binary content with a credential. An <img src> cannot send an
 * Authorization header, so protected images must come through fetch and be
 * handed to the DOM as an object URL.
 *
 * `extraHeaders` lets a gate terminal pass X-Gate-Key instead of a Bearer token.
 */
export async function authedBlob(
  path: string,
  extraHeaders?: Record<string, string>
): Promise<Blob> {
  const token = getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    headers: {
      ...(token && !extraHeaders ? { Authorization: `Bearer ${token}` } : {}),
      ...(extraHeaders ?? {}),
    },
    credentials: "include",
  });
  if (!res.ok) {
    const err: ApiError = new Error(`Image request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return res.blob();
}
```

- [ ] **Step 3: Write the photo URL classifier**

Create `userpage/lib/photos.ts`:

```ts
export type PhotoKind = "internal" | "external" | "none";

/**
 * Decides how a stored photo_url should be rendered.
 *
 * Uploaded photos are stored as a relative API path and need a credential, so
 * they go through AuthedImage. CSV-imported records may hold an absolute URL
 * to somebody else's host, which takes a plain <img> and no credential.
 */
export function classifyPhotoUrl(url?: string | null): { kind: PhotoKind; src: string } {
  const value = (url ?? "").trim();
  if (!value) return { kind: "none", src: "" };
  if (/^https?:\/\//i.test(value)) return { kind: "external", src: value };
  if (value.startsWith("/")) return { kind: "internal", src: value };
  // Anything else (a bare filename, a data: URI from an older record) is not
  // something we can authenticate or trust — treat it as absent.
  return { kind: "none", src: "" };
}

/** Initials for the placeholder shown when there is no photo. */
export function initialsOf(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
```

- [ ] **Step 4: Write AuthedImage**

Create `userpage/components/AuthedImage.tsx`:

```tsx
"use client";

import { useEffect, useState } from "react";
import { authedBlob } from "@/lib/auth";

export default function AuthedImage({
  path,
  alt,
  className,
  headers,
  fallback,
}: {
  /** API-relative path, e.g. "/persons/<id>/photo". */
  path: string;
  alt: string;
  className?: string;
  /** Overrides the Bearer token — a gate terminal passes X-Gate-Key. */
  headers?: Record<string, string>;
  fallback: React.ReactNode;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let objectUrl: string | null = null;
    let cancelled = false;

    setUrl(null);
    setFailed(false);

    authedBlob(path, headers)
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
      // Object URLs leak the whole blob until revoked, and a gate terminal
      // renders hundreds of faces per shift without ever reloading.
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
    // headers is recreated per render by callers; key off its content.
  }, [path, JSON.stringify(headers ?? {})]);

  if (failed || !url) return <>{fallback}</>;

  // eslint-disable-next-line @next/next/no-img-element
  return <img src={url} alt={alt} className={className} />;
}
```

- [ ] **Step 5: Verify it compiles and lints**

Run:
```bash
cd C:\thesis_rfid\userpage
npx tsc --noEmit
npm run lint
```
Expected: both exit 0.

- [ ] **Step 6: Commit**

```bash
cd C:\thesis_rfid\userpage
git add lib/auth.ts lib/photos.ts components/AuthedImage.tsx
git commit -m "feat(photos): credentialed image fetching and photo_url classification"
```

---

## Task 4: Photo capture in the registration form

**Files:**
- Create: `userpage/components/PhotoCapture.tsx`
- Modify: `userpage/components/PersonForm.tsx`

**Interfaces:**
- Consumes: `apiUpload` (Task 3), `POST /persons/:id/photo` (Task 2).
- Produces: `<PhotoCapture onChange={(blob: Blob | null) => void} />`.

- [ ] **Step 1: Write PhotoCapture**

Create `userpage/components/PhotoCapture.tsx`:

```tsx
"use client";

import { useEffect, useRef, useState } from "react";

const SIZE = 400;
const QUALITY = 0.82;

type Tab = "upload" | "camera";

/** Cover-crops a source image to a square canvas and returns a JPEG blob. */
async function toSquareJpeg(source: CanvasImageSource, w: number, h: number): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas is unavailable in this browser");

  // Cover: scale so the shorter edge fills, then centre the overflow.
  const scale = Math.max(SIZE / w, SIZE / h);
  const dw = w * scale;
  const dh = h * scale;
  ctx.drawImage(source, (SIZE - dw) / 2, (SIZE - dh) / 2, dw, dh);

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Could not encode the image"))),
      "image/jpeg",
      QUALITY
    );
  });
}

export default function PhotoCapture({
  onChange,
}: {
  onChange: (blob: Blob | null) => void;
}) {
  const [tab, setTab] = useState<Tab>("upload");
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cameraOn, setCameraOn] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // getUserMedia needs a secure context; localhost qualifies, plain http does not.
  const cameraSupported =
    typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;

  function stopCamera() {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setCameraOn(false);
  }

  // A live camera indicator left on after the form closes looks alarming at a
  // registration desk, so the stream is released on unmount and on tab change.
  useEffect(() => stopCamera, []);
  useEffect(() => {
    if (tab !== "camera") stopCamera();
  }, [tab]);

  function setResult(blob: Blob | null) {
    setPreview((old) => {
      if (old) URL.revokeObjectURL(old);
      return blob ? URL.createObjectURL(blob) : null;
    });
    onChange(blob);
  }

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    try {
      const bitmap = await createImageBitmap(file);
      setResult(await toSquareJpeg(bitmap, bitmap.width, bitmap.height));
      bitmap.close();
    } catch {
      setError("That file could not be read as an image.");
    }
  }

  async function startCamera() {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user" },
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setCameraOn(true);
    } catch {
      setError("Camera unavailable. Check permissions, or use the Upload tab.");
    }
  }

  async function capture() {
    const video = videoRef.current;
    if (!video) return;
    setError(null);
    try {
      setResult(await toSquareJpeg(video, video.videoWidth, video.videoHeight));
      stopCamera();
    } catch {
      setError("Could not capture a frame. Try again.");
    }
  }

  const tabCls = (active: boolean) =>
    active
      ? "rounded-lg bg-navy px-3 py-1.5 text-[13px] font-600 text-white"
      : "rounded-lg border border-line bg-white px-3 py-1.5 text-[13px] font-600 text-ink-soft hover:text-navy";

  return (
    <div className="rounded-xl border border-line bg-paper p-3">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-[13px] font-600 text-ink-soft">Photo</p>
        <div className="flex gap-1.5">
          <button type="button" onClick={() => setTab("upload")} className={tabCls(tab === "upload")}>
            Upload
          </button>
          {cameraSupported && (
            <button
              type="button"
              onClick={() => setTab("camera")}
              className={tabCls(tab === "camera")}
            >
              Camera
            </button>
          )}
        </div>
      </div>

      {error && <p className="mb-2 rounded-lg bg-red/10 px-3 py-1.5 text-[12px] text-red">{error}</p>}

      <div className="flex items-start gap-3">
        <div className="grid h-28 w-28 shrink-0 place-items-center overflow-hidden rounded-xl border border-line bg-white text-[11px] text-ink-soft">
          {preview ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={preview} alt="Selected" className="h-full w-full object-cover" />
          ) : tab === "camera" && cameraOn ? (
            <video ref={videoRef} className="h-full w-full object-cover" muted playsInline />
          ) : (
            "No photo"
          )}
        </div>

        <div className="space-y-2">
          {tab === "upload" ? (
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              onChange={handleFile}
              className="text-[13px] text-ink-soft file:mr-3 file:rounded-lg file:border file:border-line file:bg-white file:px-3 file:py-1.5 file:text-[13px] file:font-600 file:text-ink-soft"
            />
          ) : (
            <div className="flex gap-2">
              {!cameraOn ? (
                <button
                  type="button"
                  onClick={startCamera}
                  className="rounded-lg border border-line bg-white px-3 py-1.5 text-[13px] font-600 text-ink-soft hover:text-navy"
                >
                  Turn on camera
                </button>
              ) : (
                <button
                  type="button"
                  onClick={capture}
                  className="rounded-lg bg-navy px-3 py-1.5 text-[13px] font-600 text-white"
                >
                  Capture
                </button>
              )}
            </div>
          )}

          {preview && (
            <button
              type="button"
              onClick={() => setResult(null)}
              className="block text-[12px] font-600 text-ink-soft hover:text-red"
            >
              Remove photo
            </button>
          )}
          <p className="text-[11px] text-ink-soft">Saved as a 400x400 JPEG.</p>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Wire it into PersonForm**

In `userpage/components/PersonForm.tsx`:

Replace the import line `import { apiPost } from "@/lib/auth";` with:

```tsx
import { apiPost, apiUpload } from "@/lib/auth";
import PhotoCapture from "@/components/PhotoCapture";
```

Remove `photo_url: "",` from the `useState` form object, and remove `"photo_url"` from the optional-field loop so it reads:

```tsx
    for (const k of ["department_section", "contact_email", "rfid_uid"] as const) {
```

Add this state beside the existing `error` and `saving` state:

```tsx
  const [photo, setPhoto] = useState<Blob | null>(null);
  // Set when the person saved but their photo did not — the record exists and
  // must not be rolled back, so the failure is offered as a retry instead.
  const [photoRetry, setPhotoRetry] = useState<{ personId: string; name: string } | null>(null);
```

Replace the whole `Photo URL` label block with:

```tsx
        <PhotoCapture onChange={setPhoto} />
```

Replace the body of `submit`'s `try` block with:

```tsx
    try {
      const created = await apiPost<PersonRecord & { _id: string }>("/persons", payload);
      if (photo) {
        try {
          const form = new FormData();
          form.append("photo", photo, "photo.jpg");
          const uploaded = await apiUpload<{ photo_url: string }>(
            `/persons/${created._id}/photo`,
            form
          );
          created.photo_url = uploaded.photo_url;
        } catch {
          // The person exists and is usable. Deleting them over a flaky upload
          // is worse, and id_number is unique so a retry would collide.
          setPhotoRetry({ personId: created._id, name: created.full_name });
          setSaving(false);
          return;
        }
      }
      onCreated(created);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
```

Add this retry panel immediately after the existing `{error && ...}` block:

```tsx
        {photoRetry && (
          <div className="rounded-xl bg-gold/10 px-4 py-3 text-[13px] text-ink">
            <p className="font-600">
              Registered {photoRetry.name} — the photo didn&apos;t upload.
            </p>
            <p className="mt-0.5 text-ink-soft">
              The record is saved. You can retry now, or add the photo later from their
              profile.
            </p>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                disabled={!photo || saving}
                onClick={async () => {
                  if (!photo) return;
                  setSaving(true);
                  try {
                    const form = new FormData();
                    form.append("photo", photo, "photo.jpg");
                    await apiUpload(`/persons/${photoRetry.personId}/photo`, form);
                    setPhotoRetry(null);
                    onClose();
                  } catch (err) {
                    setError((err as Error).message);
                  } finally {
                    setSaving(false);
                  }
                }}
                className="rounded-lg bg-navy px-3 py-1.5 text-[13px] font-600 text-white disabled:opacity-60"
              >
                Retry photo
              </button>
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg border border-line bg-white px-3 py-1.5 text-[13px] font-600 text-ink-soft"
              >
                Continue without it
              </button>
            </div>
          </div>
        )}
```

- [ ] **Step 3: Verify it compiles and lints**

Run:
```bash
cd C:\thesis_rfid\userpage
npx tsc --noEmit
npm run lint
```
Expected: both exit 0.

- [ ] **Step 4: Verify by hand**

With `serverside` `npm run dev` and `userpage` `npm run dev` both running:

1. Sign in at `http://localhost:5173/login` as `testadmin` / `Admin@123`.
2. Go to **Register** -> **Single person**.
3. Confirm there is no longer a "Photo URL" text box, and a Photo control with **Upload** / **Camera** tabs is present.
4. Fill in a name and a unique ID number, pick an image file, and submit.
   Expected: the record saves and the printable record shows the photo.
5. Register a second person using the **Camera** tab.
   Expected: the browser asks for camera permission; after **Capture**, the preview shows the frame and the camera indicator light goes out.
6. In DevTools -> Network, confirm `POST /persons/<id>/photo` returned `201` and the request payload is under 100KB.

- [ ] **Step 5: Commit**

```bash
cd C:\thesis_rfid\userpage
git add components/PhotoCapture.tsx components/PersonForm.tsx
git commit -m "feat(photos): capture photos by upload or webcam during registration"
```

---

## Task 5: Render stored photos wherever people are shown

**Files:**
- Modify: `userpage/components/RegistrationForm.tsx`
- Modify: `userpage/components/PersonProfile.tsx`
- Modify: `userpage/components/ProfileView.tsx`

**Interfaces:**
- Consumes: `classifyPhotoUrl`, `initialsOf`, `AuthedImage` (Task 3).
- Produces: `<PersonAvatar person={{ full_name, photo_url }} className />` exported from `components/AuthedImage.tsx`.

- [ ] **Step 1: Add the shared avatar**

Append to `userpage/components/AuthedImage.tsx`:

```tsx
import { classifyPhotoUrl, initialsOf } from "@/lib/photos";

/**
 * Renders a person's photo by whichever strategy their photo_url calls for:
 * credentialed fetch for uploaded photos, a plain img for externally hosted
 * ones (CSV import), initials when there is none.
 */
export function PersonAvatar({
  person,
  className = "h-full w-full object-cover",
  headers,
}: {
  person: { full_name: string; photo_url?: string | null };
  className?: string;
  headers?: Record<string, string>;
}) {
  const { kind, src } = classifyPhotoUrl(person.photo_url);
  const initials = (
    <span className="font-display text-lg font-700 text-ink-soft">
      {initialsOf(person.full_name)}
    </span>
  );

  if (kind === "none") return initials;
  if (kind === "external") {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt={person.full_name} className={className} />;
  }
  return (
    <AuthedImage
      path={src}
      alt={person.full_name}
      className={className}
      headers={headers}
      fallback={initials}
    />
  );
}
```

- [ ] **Step 2: Use it in the printable record**

In `userpage/components/RegistrationForm.tsx`, add to the imports:

```tsx
import { PersonAvatar } from "@/components/AuthedImage";
```

Replace the photo block (the `{person.photo_url ? (<img .../>) : (...)}` conditional inside the `h-24 w-24` container) with:

```tsx
              <PersonAvatar person={person} />
```

- [ ] **Step 3: Use it in PersonProfile and ProfileView**

Run this to find every remaining raw photo render:

```bash
cd C:\thesis_rfid\userpage
grep -n "photo_url" components/PersonProfile.tsx components/ProfileView.tsx
```

For each `<img src={...photo_url...}>` found, replace the element with `<PersonAvatar person={<the person object in scope>} />` and add the import to that file. Leave the surrounding sizing container untouched — `PersonAvatar` fills its parent.

- [ ] **Step 4: Verify it compiles and lints**

Run:
```bash
npx tsc --noEmit
npm run lint
```
Expected: both exit 0.

- [ ] **Step 5: Verify by hand**

1. Sign in as `testadmin`, open **Directory**, and view the person you gave a photo in Task 4.
   Expected: the photo renders.
2. Open a seeded person with no photo (`Maria Santos`).
   Expected: initials `MS`, no broken-image icon.
3. Sign in as `2025-0001` / `Student@123` and open the dashboard.
   Expected: their own photo renders — this is the case the route ordering in Task 2 protects.

- [ ] **Step 6: Commit**

```bash
git add components/AuthedImage.tsx components/RegistrationForm.tsx components/PersonProfile.tsx components/ProfileView.tsx
git commit -m "feat(photos): render stored photos across profile and record views"
```

---

## Task 6: Gate direction

**Files:**
- Modify: `serverside/src/modules/gates/gates.model.ts`
- Modify: `serverside/src/modules/gates/gates.repository.ts`
- Modify: `serverside/src/config/seed.ts`
- Modify: `serverside/src/config/testSeed.ts`
- Modify: `serverside/src/config/verifyGates.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `IGate.direction: 'entry' | 'exit'`; `gateRepo.findByTypeAndDirection(type, direction)`.

- [ ] **Step 1: Write the failing assertions**

In `verifyGates.ts`, add to `main` after the photo block:

```ts
  console.log('\n== gate direction ==');
  const gatesRes = await request(superadmin, 'GET', '/gates');
  const gates = (gatesRes.json.data ?? []) as {
    _id: string;
    name: string;
    type: string;
    direction?: string;
  }[];
  expectEqual('all four gates are seeded', gates.length, 4);

  const expectedGates: Record<string, { type: string; direction: string }> = {
    'Main Entrance': { type: 'person', direction: 'entry' },
    'Side Gate': { type: 'person', direction: 'exit' },
    'Parking Entrance': { type: 'vehicle', direction: 'entry' },
    'Parking Exit': { type: 'vehicle', direction: 'exit' },
  };
  for (const [name, want] of Object.entries(expectedGates)) {
    const gate = gates.find((g) => g.name === name);
    // Comparing undefined to undefined would pass vacuously; assert presence first.
    expectEqual(`gate '${name}' exists`, !!gate, true);
    expectEqual(`gate '${name}' type`, gate?.type, want.type);
    expectEqual(`gate '${name}' direction`, gate?.direction, want.direction);
  }
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npm run verify:gates`
Expected: FAIL — every `direction` check reports `undefined`.

- [ ] **Step 3: Add the field**

In `serverside/src/modules/gates/gates.model.ts`, add to the interface after `type`:

```ts
  direction: 'entry' | 'exit';
```

and to the schema after the `type` field:

```ts
  direction: { type: String, enum: ['entry', 'exit'], required: true },
```

- [ ] **Step 4: Add the lookup**

In `serverside/src/modules/gates/gates.repository.ts`, add to `gateRepo`:

```ts
  findByTypeAndDirection: (type: 'person' | 'vehicle', direction: 'entry' | 'exit') =>
    GateModel.findOne({ type, direction }).lean(),
```

- [ ] **Step 5: Update both seeds**

`direction` is required, so existing gate documents must be backfilled. Both seeds create gates idempotently by name; make them update instead of skip.

In `serverside/src/config/seed.ts`, replace the `GATES` constant:

```ts
const GATES = [
  { name: 'Main Entrance', type: 'person' as const, direction: 'entry' as const, location: 'Front Building Gate A' },
  { name: 'Side Gate', type: 'person' as const, direction: 'exit' as const, location: 'South Wing Gate B' },
  { name: 'Parking Entrance', type: 'vehicle' as const, direction: 'entry' as const, location: 'Parking Lot Entry' },
  { name: 'Parking Exit', type: 'vehicle' as const, direction: 'exit' as const, location: 'Parking Lot Exit' },
];
```

and replace the gate loop body so an existing gate is backfilled rather than skipped:

```ts
  for (const g of GATES) {
    // Upsert rather than skip: `direction` is new and required, so gates
    // created before this field existed must be backfilled here.
    await GateModel.updateOne({ name: g.name }, { $set: g }, { upsert: true });
    console.log(`[seed] gate '${g.name}' ready (${g.type}/${g.direction})`);
  }
```

Apply the same `GATES` constant to `serverside/src/config/testSeed.ts`, and replace its gate loop with:

```ts
  for (const g of GATES) {
    await GateModel.updateOne({ name: g.name }, { $set: g }, { upsert: true });
    const gate = await GateModel.findOne({ name: g.name });
    if (!gate) throw new Error(`[test-seed] gate '${g.name}' missing after upsert`);
    gateMap[g.name] = gate._id;
  }
```

- [ ] **Step 6: Reseed and verify**

Run:
```bash
cd C:\thesis_rfid\serverside
npm run seed:test
npm run verify:gates
```
Expected: all direction checks pass.

- [ ] **Step 7: Confirm nothing else regressed**

Run: `npm run verify:roles`
Expected: same pass count as before this task.

- [ ] **Step 8: Commit**

```bash
git add src/modules/gates src/config/seed.ts src/config/testSeed.ts src/config/verifyGates.ts
git commit -m "feat(gates): give each gate a fixed entry/exit direction"
```

---

## Task 7: Device keys — model, minting, and authentication

**Files:**
- Create: `serverside/src/modules/gates/gateKeys.model.ts`
- Create: `serverside/src/modules/gates/gateKeys.repository.ts`
- Create: `serverside/src/modules/gates/gateKeys.service.ts`
- Create: `serverside/src/middlewares/authenticateGate.ts`
- Modify: `serverside/src/types/index.ts`, `serverside/src/types/express.d.ts`
- Modify: `serverside/src/modules/gates/gates.controller.ts`, `gates.routes.ts`
- Modify: `serverside/src/config/verifyGates.ts`

**Interfaces:**
- Consumes: `IGate.direction` (Task 6).
- Produces: `POST /gates/:id/key` returning `{ key, key_prefix, gate: { _id, name, type, direction } }`; `authenticateGate` middleware setting `req.gate: GateContext`; `gateKeyService.mint(gateId, userId)`, `gateKeyService.authenticate(presented)`.

- [ ] **Step 1: Write the failing assertions**

In `verifyGates.ts`, add to `main`:

```ts
  console.log('\n== device key minting ==');
  const mainGate = gates.find((g) => g.name === 'Main Entrance');
  const parkingIn = gates.find((g) => g.name === 'Parking Entrance');
  if (!mainGate || !parkingIn) throw new Error('expected gates missing — run npm run seed:test');

  const registrarMint = await request(registrar, 'POST', `/gates/${mainGate._id}/key`);
  expectEqual('registrar cannot mint a key', registrarMint.status, 403);

  const firstMint = await request(superadmin, 'POST', `/gates/${mainGate._id}/key`);
  expectEqual('superadmin can mint a key', firstMint.status, 201);
  const firstKey = (firstMint.json.data as { key?: string } | undefined)?.key;
  expectEqual('minted key has the documented shape', /^gk_live_[0-9a-f]{40}$/.test(firstKey ?? ''), true);

  const parkingMint = await request(superadmin, 'POST', `/gates/${parkingIn._id}/key`);
  const parkingKey = (parkingMint.json.data as { key?: string } | undefined)?.key;
  expectEqual('parking key minted', typeof parkingKey, 'string');

  // Minting again must revoke the first key.
  const secondMint = await request(superadmin, 'POST', `/gates/${mainGate._id}/key`);
  const secondKey = (secondMint.json.data as { key?: string } | undefined)?.key;
  expectEqual('second mint succeeded', secondMint.status, 201);
  expectEqual('second key differs from the first', firstKey !== secondKey, true);
```

The tap assertions that consume these keys arrive in Task 8; for now this only proves minting and authorization.

- [ ] **Step 2: Run it to make sure it fails**

Run: `npm run verify:gates`
Expected: FAIL — mint requests return 404.

- [ ] **Step 3: Write the model**

Create `serverside/src/modules/gates/gateKeys.model.ts`:

```ts
import { Schema, model, Document, Types } from 'mongoose';

export interface IGateKey extends Document {
  _id: Types.ObjectId;
  gate_id: Types.ObjectId;
  key_hash: string;
  /** The 8-char lookup segment. Bcrypt hashes are not searchable. */
  key_prefix: string;
  is_active: boolean;
  last_used_at: Date | null;
  created_by: Types.ObjectId;
  createdAt: Date;
}

const gateKeySchema = new Schema<IGateKey>(
  {
    gate_id: { type: Schema.Types.ObjectId, ref: 'Gate', required: true, index: true },
    key_hash: { type: String, required: true },
    key_prefix: { type: String, required: true, unique: true, index: true },
    is_active: { type: Boolean, default: true, index: true },
    last_used_at: { type: Date, default: null },
    created_by: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

export const GateKeyModel = model<IGateKey>('GateKey', gateKeySchema);
```

- [ ] **Step 4: Write the repository**

Create `serverside/src/modules/gates/gateKeys.repository.ts`:

```ts
import { Types } from 'mongoose';
import { GateKeyModel, IGateKey } from './gateKeys.model';

export const gateKeyRepo = {
  create: (doc: {
    gate_id: Types.ObjectId;
    key_hash: string;
    key_prefix: string;
    created_by: Types.ObjectId;
  }) => GateKeyModel.create(doc),

  findActiveByPrefix: (prefix: string) =>
    GateKeyModel.findOne({ key_prefix: prefix, is_active: true }).lean<IGateKey | null>(),

  /** Keys are never deleted — which key a scan ran under stays auditable. */
  deactivateForGate: (gateId: Types.ObjectId) =>
    GateKeyModel.updateMany({ gate_id: gateId, is_active: true }, { $set: { is_active: false } }),

  touch: (id: Types.ObjectId) =>
    GateKeyModel.updateOne({ _id: id }, { $set: { last_used_at: new Date() } }),
};
```

- [ ] **Step 5: Write the service**

Create `serverside/src/modules/gates/gateKeys.service.ts`:

```ts
import { randomBytes } from 'crypto';
import bcrypt from 'bcrypt';
import { Types } from 'mongoose';
import { gateKeyRepo } from './gateKeys.repository';
import { gateRepo } from './gates.repository';
import { ApiError } from '../../utils/ApiError';
import { GateContext } from '../../types';

const PREFIX_LITERAL = 'gk_live_';
const PREFIX_LEN = 8;
const SECRET_LEN = 32;

/** gk_live_<8 hex prefix><32 hex secret>. Fixed length so parsing is positional. */
function generateKey(): { key: string; prefix: string } {
  const prefix = randomBytes(PREFIX_LEN / 2).toString('hex');
  const secret = randomBytes(SECRET_LEN / 2).toString('hex');
  return { key: `${PREFIX_LITERAL}${prefix}${secret}`, prefix };
}

function parseKey(presented: string): { prefix: string } | null {
  if (!presented.startsWith(PREFIX_LITERAL)) return null;
  const rest = presented.slice(PREFIX_LITERAL.length);
  if (rest.length !== PREFIX_LEN + SECRET_LEN) return null;
  if (!/^[0-9a-f]+$/.test(rest)) return null;
  return { prefix: rest.slice(0, PREFIX_LEN) };
}

export const gateKeyService = {
  /**
   * Mints a key and revokes the gate's previous ones, so a gate has at most one
   * live terminal. Returns the plaintext exactly once — it is never recoverable.
   */
  async mint(gateId: string, userId: string) {
    if (!Types.ObjectId.isValid(gateId)) throw new ApiError('NOT_FOUND', 'Gate not found');
    const gate = await gateRepo.findById(gateId);
    if (!gate) throw new ApiError('NOT_FOUND', 'Gate not found');

    const { key, prefix } = generateKey();
    const key_hash = await bcrypt.hash(key, 12);

    await gateKeyRepo.deactivateForGate(gate._id);
    await gateKeyRepo.create({
      gate_id: gate._id,
      key_hash,
      key_prefix: prefix,
      created_by: new Types.ObjectId(userId),
    });

    console.log(`[gate-key] minted ${prefix} for gate '${gate.name}'`); // never log the key
    return {
      key,
      key_prefix: prefix,
      gate: {
        _id: String(gate._id),
        name: gate.name,
        type: gate.type,
        direction: gate.direction,
        location: gate.location,
      },
    };
  },

  /** Resolves a presented key to its gate, or null if it is not valid and active. */
  async authenticate(presented: string): Promise<GateContext | null> {
    const parsed = parseKey(presented);
    if (!parsed) return null;

    const record = await gateKeyRepo.findActiveByPrefix(parsed.prefix);
    if (!record) return null;

    // The prefix is only a lookup handle; the whole key is what gets compared.
    const ok = await bcrypt.compare(presented, record.key_hash);
    if (!ok) return null;

    const gate = await gateRepo.findById(String(record.gate_id));
    if (!gate) return null;

    await gateKeyRepo.touch(record._id);
    return {
      gateId: String(gate._id),
      name: gate.name,
      type: gate.type,
      direction: gate.direction,
      keyPrefix: record.key_prefix,
    };
  },
};
```

- [ ] **Step 6: Add the types**

In `serverside/src/types/index.ts`, append:

```ts
export interface GateContext {
  gateId: string;
  name: string;
  type: 'person' | 'vehicle';
  direction: 'entry' | 'exit';
  keyPrefix: string;
}
```

In `serverside/src/types/express.d.ts`, change the import and the interface:

```ts
import { AuthUser, GateContext } from './index';

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      gate?: GateContext;
    }
  }
}

export {};
```

- [ ] **Step 7: Write the middleware**

Create `serverside/src/middlewares/authenticateGate.ts`:

```ts
import { Request, Response, NextFunction } from 'express';
import { ApiError } from '../utils/ApiError';
import { gateKeyService } from '../modules/gates/gateKeys.service';

export const GATE_KEY_HEADER = 'x-gate-key';

/** Authenticates a gate terminal by its device key. Requires the header. */
export function authenticateGate(req: Request, _res: Response, next: NextFunction): void {
  const presented = req.headers[GATE_KEY_HEADER];
  if (typeof presented !== 'string' || !presented) {
    next(new ApiError('UNAUTHORIZED'));
    return;
  }
  gateKeyService
    .authenticate(presented)
    .then((gate) => {
      if (!gate) {
        next(new ApiError('UNAUTHORIZED', 'Invalid or revoked gate key'));
        return;
      }
      req.gate = gate;
      next();
    })
    .catch(next);
}
```

- [ ] **Step 8: Add the mint endpoint**

In `serverside/src/modules/gates/gates.controller.ts`, add the import and handler:

```ts
import { gateKeyService } from './gateKeys.service';
```

```ts
  mintKey: asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw new ApiError('UNAUTHORIZED');
    sendSuccess(res, await gateKeyService.mint(req.params.id, req.user.userId), 201);
  }),
```

Add any of `asyncHandler`, `sendSuccess`, `ApiError`, `Request`, `Response` that the file does not already import, matching the import style of `persons.controller.ts`.

In `serverside/src/modules/gates/gates.routes.ts`:

```ts
import { authorize } from '../../middlewares/authorize';
import { ROLES } from '../../constants/roles';
```

```ts
// Superadmin only — provisioning a terminal is not a registrar action.
gateRoutes.post('/:id/key', authorize(ROLES.SUPERADMIN), gateController.mintKey);
```

- [ ] **Step 9: Run the harness and verify it passes**

Run: `npm run verify:gates`
Expected: all minting checks pass.

- [ ] **Step 10: Commit**

```bash
git add src/modules/gates src/middlewares/authenticateGate.ts src/types src/config/verifyGates.ts
git commit -m "feat(gates): per-gate device keys with minting and authentication"
```

---

## Task 8: Tap by device key, and the wrong_gate_type rule

**Files:**
- Modify: `serverside/src/modules/scan/scan.routes.ts`
- Modify: `serverside/src/modules/scan/scan.schema.ts`
- Modify: `serverside/src/modules/scan/scan.controller.ts`
- Modify: `serverside/src/modules/scan/scan.service.ts`
- Modify: `serverside/src/config/verifyGates.ts`

**Interfaces:**
- Consumes: `authenticateGate`, `GateContext` (Task 7).
- Produces: `POST /scan/tap` accepting `{ rfid_uid }` with `X-Gate-Key`, or `{ rfid_uid, gate_id, direction }` with a JWT; denial reason `wrong_gate_type`.

- [ ] **Step 1: Write the failing assertions**

In `verifyGates.ts`, add to `main`:

```ts
  console.log('\n== tapping with a device key ==');
  const gateKey = (h: string) => ({ 'X-Gate-Key': h, 'Content-Type': 'application/json' });

  async function tap(
    headers: Record<string, string>,
    body: Record<string, unknown>
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await fetch(`${BASE}/scan/tap`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    let json: Record<string, unknown> = {};
    try {
      json = (await res.json()) as Record<string, unknown>;
    } catch {
      // no body
    }
    return { status: res.status, json };
  }

  if (!secondKey || !parkingKey) throw new Error('key minting did not return a key');

  // Juan Dela Cruz's card, seeded active.
  const granted = await tap(gateKey(secondKey), { rfid_uid: 'A1B2C3D4' });
  expectEqual('valid key taps successfully', granted.status, 200);
  expectEqual(
    'person card granted at a person gate',
    (granted.json.data as { access_result?: string } | undefined)?.access_result,
    'granted'
  );

  // The device is not trusted to name its own gate.
  const spoofed = await tap(gateKey(secondKey), {
    rfid_uid: 'A1B2C3D4',
    gate_id: parkingIn._id,
    direction: 'exit',
  });
  expectEqual('body-supplied gate is ignored, not honoured', spoofed.status, 200);

  // scanRepo.findLogsPaginated sorts scan_time: -1, so [0] is the newest row.
  // The freshness guard keeps this from passing on some unrelated old row if
  // that sort ever changes.
  const logs = await request(superadmin, 'GET', '/scan/logs?limit=1');
  const latest = (logs.json.data ?? []) as {
    gate_id?: string;
    direction?: string;
    scan_time?: string;
  }[];
  expectEqual('a log row was written', latest.length >= 1, true);
  expectEqual('newest log row is from this run', !!latest[0]?.scan_time, true);
  expectEqual(
    'newest log row is fresh',
    latest[0]?.scan_time ? Date.now() - new Date(latest[0].scan_time).getTime() < 60_000 : false,
    true
  );
  expectEqual('log records the key\'s gate, not the body\'s', latest[0]?.gate_id, mainGate._id);
  expectEqual('log records the gate\'s direction', latest[0]?.direction, 'entry');

  // A person card at a vehicle gate must not open the barrier.
  const wrongGate = await tap(gateKey(parkingKey), { rfid_uid: 'A1B2C3D4' });
  expectEqual(
    'person card denied at a vehicle gate',
    (wrongGate.json.data as { access_result?: string } | undefined)?.access_result,
    'denied'
  );
  expectEqual(
    'denial reason is wrong_gate_type',
    (wrongGate.json.data as { reason?: string } | undefined)?.reason,
    'wrong_gate_type'
  );

  // An exit gate must close the attendance day the entry gate opened.
  const sideGate = gates.find((g) => g.name === 'Side Gate');
  if (!sideGate) throw new Error('Side Gate missing — run npm run seed:test');
  const sideMint = await request(superadmin, 'POST', `/gates/${sideGate._id}/key`);
  const sideKey = (sideMint.json.data as { key?: string } | undefined)?.key;
  expectEqual('side gate key minted', typeof sideKey, 'string');

  const exitTap = await tap(gateKey(sideKey ?? ''), { rfid_uid: 'A1B2C3D4' });
  expectEqual(
    'exit gate grants',
    (exitTap.json.data as { access_result?: string } | undefined)?.access_result,
    'granted'
  );

  const today = new Date().toISOString().slice(0, 10);
  const att = await request(
    superadmin,
    'GET',
    `/attendance?person_id=${personId}&from=${today}&to=${today}&limit=5`
  );
  const rows = (att.json.data ?? []) as { time_in?: string | null; time_out?: string | null }[];
  // A length floor: .find on an empty array yields undefined, and every
  // assertion below it would then compare undefined to undefined and pass.
  expectEqual('an attendance row exists for today', rows.length >= 1, true);
  expectEqual('entry gate recorded a time_in', !!rows[0]?.time_in, true);
  expectEqual('exit gate recorded a time_out', !!rows[0]?.time_out, true);
  // Re-runnable: each run's exit tap refreshes time_out to now, so this holds
  // on the first run and every run after.
  expectEqual(
    'time_out came from this run',
    rows[0]?.time_out ? Date.now() - new Date(rows[0].time_out).getTime() < 60_000 : false,
    true
  );

  const unknownKey = await tap(gateKey('gk_live_' + 'a'.repeat(40)), { rfid_uid: 'A1B2C3D4' });
  expectEqual('unknown key rejected', unknownKey.status, 401);

  // firstKey was revoked when the second was minted.
  const revoked = await tap(gateKey(firstKey ?? ''), { rfid_uid: 'A1B2C3D4' });
  expectEqual('revoked key rejected', revoked.status, 401);

  console.log('\n== photo fetch by a gate terminal ==');
  await uploadPhoto(auth(registrar), personId, TINY_JPEG, 'gate.jpg', 'image/jpeg');
  const byGate = await fetch(`${BASE}/persons/${personId}/photo`, {
    headers: { 'X-Gate-Key': secondKey },
  });
  expectEqual('gate key may fetch a photo', byGate.status, 200);
  await request(superadmin, 'DELETE', `/persons/${personId}/photo`);
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npm run verify:gates`
Expected: FAIL — key-authenticated taps return 401, since `/scan/tap` only accepts a JWT.

- [ ] **Step 3: Split the tap schemas**

Replace `serverside/src/modules/scan/scan.schema.ts` with:

```ts
import { z } from 'zod';

const rfid = z
  .string()
  .regex(/^[0-9A-Fa-f]{6,32}$/, 'rfid_uid must be 6-32 hex characters');

/** JWT callers name the gate themselves. */
export const tapSchema = z.object({
  rfid_uid: rfid,
  gate_id: z.string().regex(/^[0-9a-fA-F]{24}$/, 'invalid gate_id'),
  direction: z.enum(['entry', 'exit']),
});

/**
 * Device callers send only the UID. Gate and direction come from the key, so
 * any gate_id or direction in the body is stripped rather than trusted.
 */
export const tapDeviceSchema = z
  .object({ rfid_uid: rfid })
  .transform((v) => ({ rfid_uid: v.rfid_uid }));
```

- [ ] **Step 4: Apply the gate-type rule**

In `serverside/src/modules/scan/scan.service.ts`, change the `TapInput` interface to:

```ts
interface TapInput {
  rfid_uid: string;
  gate_id: string;
  direction: 'entry' | 'exit';
}
```

(unchanged — the controller resolves gate and direction before calling).

Then, immediately after the block that resolves `person` / `vehicle` and before `scanRepo.createLog`, insert:

```ts
    // A gate has a fixed type now, so a person card must not open the parking
    // barrier and a vehicle tag must not register attendance at a walking gate.
    // Gadgets (Subsystem B) are deliberately exempt when they are added: the
    // check applies only to person and vehicle entities.
    if (access_result === 'granted' && entity_type !== gate.type) {
      access_result = 'denied';
      reason = 'wrong_gate_type';
      personView = undefined;
    }
```

- [ ] **Step 5: Resolve the credential in the controller**

Replace the `tap` handler in `serverside/src/modules/scan/scan.controller.ts`:

```ts
  tap: asyncHandler(async (req: Request, res: Response) => {
    // A device key names its own gate; a JWT caller supplies one in the body.
    const input = req.gate
      ? {
          rfid_uid: req.body.rfid_uid as string,
          gate_id: req.gate.gateId,
          direction: req.gate.direction,
        }
      : req.body;
    const result = await scanService.tap(input);
    sendSuccess(res, result, 200); // always 200 — denied is a business outcome
  }),
```

- [ ] **Step 6: Rewire the routes**

Replace `serverside/src/modules/scan/scan.routes.ts`:

```ts
import { Router, Request, Response, NextFunction } from 'express';
import { authenticate } from '../../middlewares/authenticate';
import { authenticateGate, GATE_KEY_HEADER } from '../../middlewares/authenticateGate';
import { authorize } from '../../middlewares/authorize';
import { validate } from '../../middlewares/validate';
import { scanLimiter } from '../../middlewares/rateLimiter';
import { ROLES } from '../../constants/roles';
import { scanController } from './scan.controller';
import { tapSchema, tapDeviceSchema } from './scan.schema';

export const scanRoutes = Router();

/**
 * A tap arrives either from a gate terminal holding a device key, or from a
 * logged-in user (the role harness taps this way). The credential decides
 * which validation applies, so the blanket `authenticate` this router used to
 * carry has been replaced with per-route middleware.
 */
function tapAuth(req: Request, res: Response, next: NextFunction): void {
  if (req.headers[GATE_KEY_HEADER]) {
    authenticateGate(req, res, next);
    return;
  }
  authenticate(req, res, next);
}

function tapValidate(req: Request, res: Response, next: NextFunction): void {
  const schema = req.gate ? tapDeviceSchema : tapSchema;
  validate(schema)(req, res, next);
}

scanRoutes.post('/tap', scanLimiter, tapAuth, tapValidate, scanController.tap);
scanRoutes.get('/logs', authenticate, authorize(ROLES.SUPERADMIN), scanController.logs);
```

- [ ] **Step 7: Let the photo route accept a gate key**

Create `serverside/src/middlewares/authenticateAny.ts`:

```ts
import { Request, Response, NextFunction } from 'express';
import { authenticate } from './authenticate';
import { authenticateGate, GATE_KEY_HEADER } from './authenticateGate';

/**
 * Accepts a gate device key or a user JWT. Used by the photo endpoint: a gate
 * terminal has no user session but is the main consumer of face photos.
 */
export function authenticateAny(req: Request, res: Response, next: NextFunction): void {
  if (req.headers[GATE_KEY_HEADER]) {
    authenticateGate(req, res, next);
    return;
  }
  authenticate(req, res, next);
}
```

In `serverside/src/modules/persons/persons.routes.ts`, change the photo GET route added in Task 2 to use it:

```ts
import { authenticateAny } from '../../middlewares/authenticateAny';
```

```ts
personRoutes.get('/:id/photo', authenticateAny, personController.getPhoto);
```

- [ ] **Step 8: Run the harness and verify it passes**

Run: `npm run verify:gates`
Expected: every check passes.

- [ ] **Step 9: Confirm the role harness still passes**

Run: `npm run verify:roles`
Expected: same pass count as before. This is the check that catches a regression from replacing the blanket `authenticate`.

- [ ] **Step 10: Verify re-runnability**

Run: `npm run verify:gates && npm run verify:gates`
Expected: identical output. Note that taps write scan-log rows by design — the assertions read only the most recent row, so accumulating history does not change the result.

- [ ] **Step 11: Commit**

```bash
git add src/modules/scan src/middlewares/authenticateAny.ts src/modules/persons/persons.routes.ts src/config/verifyGates.ts
git commit -m "feat(gates): tap by device key and deny cross-type gate access"
```

---

## Task 9: Gate terminal client library

**Files:**
- Create: `userpage/lib/gateTerminal.ts`

**Interfaces:**
- Consumes: `POST /scan/tap`, `GET /gates`, `POST /gates/:id/key` (Tasks 7-8).
- Produces: `getStoredGate()`, `storeGate(config)`, `clearStoredGate()`, `postTap(uid)`, `GATE_ROUTES`, and types `GateConfig`, `TapOutcome`.

- [ ] **Step 1: Write the module**

Create `userpage/lib/gateTerminal.ts`:

```ts
import { API_BASE } from "@/lib/auth";

const STORAGE_KEY = "ncst_gate_terminal";

export interface GateConfig {
  key: string;
  gateId: string;
  name: string;
  type: "person" | "vehicle";
  direction: "entry" | "exit";
}

/** The four routes, each pre-declaring which gate it expects to be provisioned as. */
export const GATE_ROUTES = {
  "person-entry": { type: "person", direction: "entry", label: "Person · Entry" },
  "person-exit": { type: "person", direction: "exit", label: "Person · Exit" },
  "vehicle-entry": { type: "vehicle", direction: "entry", label: "Vehicle · Entry" },
  "vehicle-exit": { type: "vehicle", direction: "exit", label: "Vehicle · Exit" },
} as const;

export type GateRouteId = keyof typeof GATE_ROUTES;

export function getStoredGate(routeId: GateRouteId): GateConfig | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(`${STORAGE_KEY}:${routeId}`);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as GateConfig;
    return parsed.key && parsed.gateId ? parsed : null;
  } catch {
    return null;
  }
}

export function storeGate(routeId: GateRouteId, config: GateConfig): void {
  window.localStorage.setItem(`${STORAGE_KEY}:${routeId}`, JSON.stringify(config));
}

export function clearStoredGate(routeId: GateRouteId): void {
  window.localStorage.removeItem(`${STORAGE_KEY}:${routeId}`);
}

export type TapOutcome =
  | {
      state: "granted" | "denied";
      access_result: "granted" | "denied";
      reason: string | null;
      scan_time: string;
      person?: { full_name: string; type: string; photo_url?: string; person_id?: string };
      rfid_uid: string;
    }
  /** Amber: the system did not decide. Never rendered like a grant. */
  | { state: "offline" | "ratelimited" | "error"; message: string; rfid_uid: string }
  /** The stored key is dead; the terminal must be re-provisioned. */
  | { state: "unauthorized"; rfid_uid: string };

export async function postTap(key: string, rfid_uid: string): Promise<TapOutcome> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/scan/tap`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Gate-Key": key },
      body: JSON.stringify({ rfid_uid }),
    });
  } catch {
    return { state: "offline", message: "Not recording scans", rfid_uid };
  }

  if (res.status === 401) return { state: "unauthorized", rfid_uid };
  if (res.status === 429) {
    return { state: "ratelimited", message: "Too many taps — wait a moment", rfid_uid };
  }

  const body = (await res.json().catch(() => null)) as
    | { success: true; data: Omit<Extract<TapOutcome, { state: "granted" }>, "state" | "rfid_uid"> }
    | { success: false; message?: string }
    | null;

  if (!res.ok || !body || body.success !== true) {
    const message = (body as { message?: string } | null)?.message ?? "System error";
    return { state: "error", message, rfid_uid };
  }

  return {
    ...body.data,
    state: body.data.access_result === "granted" ? "granted" : "denied",
    rfid_uid,
  };
}

/** Mints a key for a gate. Requires a superadmin token in the Authorization header. */
export async function mintGateKey(
  token: string,
  gateId: string
): Promise<{ key: string; gate: { _id: string; name: string; type: string; direction: string } }> {
  const res = await fetch(`${API_BASE}/gates/${gateId}/key`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = (await res.json().catch(() => null)) as
    | { success: true; data: { key: string; gate: { _id: string; name: string; type: string; direction: string } } }
    | { success: false; message?: string }
    | null;
  if (!res.ok || !body || body.success !== true) {
    throw new Error((body as { message?: string } | null)?.message ?? "Could not mint a device key");
  }
  return body.data;
}
```

- [ ] **Step 2: Export API_BASE if it is not already exported**

Run:
```bash
cd C:\thesis_rfid\userpage
grep -n "export const API_BASE" lib/auth.ts
```
Expected: a match. If `API_BASE` is declared without `export`, add the keyword.

- [ ] **Step 3: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add lib/gateTerminal.ts lib/auth.ts
git commit -m "feat(gates): gate terminal storage, tap, and key minting client"
```

---

## Task 10: The gate terminal screen

**Files:**
- Create: `userpage/components/gate/GateTerminal.tsx`
- Create: `userpage/components/gate/GateProvisioning.tsx`
- Create: `userpage/app/gate/person-entry/page.tsx`
- Create: `userpage/app/gate/person-exit/page.tsx`
- Create: `userpage/app/gate/vehicle-entry/page.tsx`
- Create: `userpage/app/gate/vehicle-exit/page.tsx`

**Interfaces:**
- Consumes: everything from Task 9, `PersonAvatar` (Task 5).
- Produces: four routes rendering `<GateTerminal routeId={...} />`.

- [ ] **Step 1: Read the Next.js routing guide**

Read `userpage/node_modules/next/dist/docs/01-app/01-getting-started/03-layouts-and-pages.md`. `AGENTS.md` requires it before writing App Router files, and this version's conventions may differ from what you expect.

- [ ] **Step 2: Write the provisioning screen**

Create `userpage/components/gate/GateProvisioning.tsx`:

```tsx
"use client";

import { useState } from "react";
import { API_BASE } from "@/lib/auth";
import {
  GATE_ROUTES,
  mintGateKey,
  storeGate,
  type GateConfig,
  type GateRouteId,
} from "@/lib/gateTerminal";

interface Gate {
  _id: string;
  name: string;
  type: "person" | "vehicle";
  direction: "entry" | "exit";
  location?: string;
}

export default function GateProvisioning({
  routeId,
  onProvisioned,
}: {
  routeId: GateRouteId;
  onProvisioned: (config: GateConfig) => void;
}) {
  const expected = GATE_ROUTES[routeId];
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function provision(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const loginRes = await fetch(`${API_BASE}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ username, password }),
      });
      const loginBody = (await loginRes.json().catch(() => null)) as
        | { success: true; data: { accessToken: string; user: { role: string } } }
        | { success: false; message?: string }
        | null;
      if (!loginRes.ok || !loginBody || loginBody.success !== true) {
        throw new Error((loginBody as { message?: string } | null)?.message ?? "Sign-in failed");
      }
      if (loginBody.data.user.role !== "superadmin") {
        throw new Error("Only a superadmin can set up a gate terminal.");
      }
      const token = loginBody.data.accessToken;

      const gatesRes = await fetch(`${API_BASE}/gates`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const gatesBody = (await gatesRes.json().catch(() => null)) as
        | { success: true; data: Gate[] }
        | null;
      if (!gatesBody || gatesBody.success !== true) throw new Error("Could not load gates");

      const gate = gatesBody.data.find(
        (g) => g.type === expected.type && g.direction === expected.direction
      );
      if (!gate) {
        throw new Error(
          `No ${expected.type}/${expected.direction} gate exists. Run the seed on the server first.`
        );
      }

      const minted = await mintGateKey(token, gate._id);
      const config: GateConfig = {
        key: minted.key,
        gateId: gate._id,
        name: gate.name,
        type: gate.type,
        direction: gate.direction,
      };
      storeGate(routeId, config);

      // The terminal runs as a device from here; the admin session is not kept.
      await fetch(`${API_BASE}/auth/logout`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        credentials: "include",
      }).catch(() => undefined);

      onProvisioned(config);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="grid min-h-dvh place-items-center bg-ink p-6">
      <form
        onSubmit={provision}
        className="w-full max-w-sm space-y-4 rounded-2xl bg-white p-8"
      >
        <div>
          <p className="text-[11px] font-600 uppercase tracking-[0.18em] text-ink-soft">
            Gate terminal
          </p>
          <h1 className="font-display text-xl font-700 text-navy">This terminal isn&apos;t set up</h1>
          <p className="mt-1 text-[13px] text-ink-soft">
            A superadmin signs in once to bind this screen to the{" "}
            <strong>{expected.label}</strong> gate. The sign-in is not kept.
          </p>
        </div>

        {error && <p className="rounded-xl bg-red/10 px-4 py-2 text-[13px] text-red">{error}</p>}

        <label className="block text-[13px] font-600 text-ink-soft">
          Username
          <input
            required
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="mt-1 w-full rounded-xl border border-line px-3 py-2 text-[14px] text-ink outline-none focus:border-blue"
          />
        </label>
        <label className="block text-[13px] font-600 text-ink-soft">
          Password
          <input
            required
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 w-full rounded-xl border border-line px-3 py-2 text-[14px] text-ink outline-none focus:border-blue"
          />
        </label>
        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-xl bg-navy px-4 py-2.5 text-sm font-600 text-white disabled:opacity-60"
        >
          {busy ? "Setting up…" : "Set up this gate"}
        </button>
      </form>
    </main>
  );
}
```

- [ ] **Step 3: Write the terminal**

Create `userpage/components/gate/GateTerminal.tsx`:

```tsx
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { PersonAvatar } from "@/components/AuthedImage";
import GateProvisioning from "./GateProvisioning";
import {
  GATE_ROUTES,
  clearStoredGate,
  getStoredGate,
  postTap,
  type GateConfig,
  type GateRouteId,
  type TapOutcome,
} from "@/lib/gateTerminal";

const RESET_MS = 5000;
const UID_RE = /^[0-9A-Fa-f]{6,32}$/;

const REASON_TEXT: Record<string, string> = {
  unregistered_uid: "Unregistered card",
  inactive_id: "ID inactive",
  wrong_gate_type: "Wrong gate for this card",
};

export default function GateTerminal({ routeId }: { routeId: GateRouteId }) {
  const meta = GATE_ROUTES[routeId];
  const [config, setConfig] = useState<GateConfig | null>(null);
  const [ready, setReady] = useState(false);
  const [outcome, setOutcome] = useState<TapOutcome | null>(null);
  const [recent, setRecent] = useState<{ label: string; at: string; ok: boolean }[]>([]);

  const inputRef = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // localStorage is unavailable during SSR, so config resolves after mount.
  useEffect(() => {
    setConfig(getStoredGate(routeId));
    setReady(true);
  }, [routeId]);

  const focusInput = useCallback(() => inputRef.current?.focus(), []);

  useEffect(() => {
    if (!config) return;
    focusInput();
    // The reader is a keyboard: if focus drifts, taps are silently lost.
    const id = window.setInterval(focusInput, 1000);
    window.addEventListener("focus", focusInput);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("focus", focusInput);
    };
  }, [config, focusInput]);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  async function handleUid(uid: string) {
    if (!config) return;
    // Ignore, never queue: a queued tap would let the next person through on a
    // result the guard has already read.
    if (busyRef.current) return;
    if (!UID_RE.test(uid)) return;

    busyRef.current = true;
    const result = await postTap(config.key, uid);

    if (result.state === "unauthorized") {
      // The key is dead. Say so rather than silently refusing to grant.
      clearStoredGate(routeId);
      setConfig(null);
      busyRef.current = false;
      return;
    }

    setOutcome(result);
    if (result.state === "granted" || result.state === "denied") {
      const label =
        result.state === "granted" ? result.person?.full_name ?? "Vehicle" : "Denied";
      setRecent((r) =>
        [
          { label, at: new Date(result.scan_time).toLocaleTimeString(), ok: result.state === "granted" },
          ...r,
        ].slice(0, 5)
      );
    }

    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      setOutcome(null);
      busyRef.current = false;
      focusInput();
    }, RESET_MS);
  }

  if (!ready) return <main className="min-h-dvh bg-ink" />;
  if (!config) return <GateProvisioning routeId={routeId} onProvisioned={setConfig} />;

  // Green and red mean the system decided; amber means it did not. A guard must
  // never read a network failure as a grant.
  const tone =
    outcome?.state === "granted"
      ? "bg-green-700"
      : outcome?.state === "denied"
        ? "bg-red-700"
        : outcome
          ? "bg-amber-600"
          : "bg-ink";

  return (
    <main className={`min-h-dvh ${tone} text-white transition-colors`} onClick={focusInput}>
      <input
        ref={inputRef}
        aria-hidden
        tabIndex={-1}
        className="pointer-events-none absolute h-0 w-0 opacity-0"
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          const value = e.currentTarget.value.trim();
          e.currentTarget.value = "";
          void handleUid(value);
        }}
      />

      <div className="mx-auto flex min-h-dvh max-w-4xl flex-col px-8 py-6">
        <header className="flex items-baseline justify-between opacity-80">
          <p className="font-display text-lg font-700 uppercase tracking-[0.12em]">{config.name}</p>
          <p className="text-sm font-600 uppercase tracking-[0.18em]">{meta.label}</p>
        </header>

        <div className="flex flex-1 items-center justify-center">
          {!outcome && (
            <div className="text-center">
              <p className="font-display text-6xl font-700">Tap your card</p>
              <p className="mt-3 text-lg opacity-70">Hold it against the reader</p>
            </div>
          )}

          {(outcome?.state === "granted" || outcome?.state === "denied") && (
            <div className="w-full">
              <p className="text-center font-display text-7xl font-700 uppercase tracking-tight">
                {outcome.access_result}
              </p>
              <div className="mt-8 flex items-center justify-center gap-8">
                <div className="grid h-44 w-44 shrink-0 place-items-center overflow-hidden rounded-2xl bg-white/15">
                  {outcome.person ? (
                    <PersonAvatar
                      person={{
                        full_name: outcome.person.full_name,
                        photo_url: outcome.person.photo_url,
                      }}
                      headers={{ "X-Gate-Key": config.key }}
                    />
                  ) : (
                    <span className="font-display text-5xl font-700 opacity-60">?</span>
                  )}
                </div>
                <div className="min-w-0">
                  <p className="font-display text-4xl font-700">
                    {outcome.person?.full_name ?? "Unknown card"}
                  </p>
                  {outcome.person && (
                    <p className="mt-1 text-xl capitalize opacity-80">{outcome.person.type}</p>
                  )}
                  {outcome.reason && (
                    <p className="mt-2 text-xl opacity-90">
                      {REASON_TEXT[outcome.reason] ?? outcome.reason}
                    </p>
                  )}
                  {outcome.access_result === "granted" && !outcome.person?.photo_url && (
                    <p className="mt-2 text-base opacity-70">No photo on file</p>
                  )}
                  <p className="mt-2 font-mono text-base opacity-60">{outcome.rfid_uid}</p>
                </div>
              </div>
            </div>
          )}

          {outcome &&
            outcome.state !== "granted" &&
            outcome.state !== "denied" && (
              <div className="text-center">
                <p className="font-display text-6xl font-700 uppercase">
                  {outcome.state === "offline"
                    ? "Offline"
                    : outcome.state === "ratelimited"
                      ? "Slow down"
                      : "System error"}
                </p>
                <p className="mt-3 text-xl opacity-90">{outcome.message}</p>
                <p className="mt-1 text-lg opacity-70">The tap was not recorded.</p>
              </div>
            )}
        </div>

        <footer className="border-t border-white/20 pt-3 text-sm opacity-70">
          {recent.length === 0 ? (
            <span>No scans yet</span>
          ) : (
            <div className="flex flex-wrap gap-x-6 gap-y-1">
              {recent.map((r, i) => (
                <span key={i}>
                  {r.ok ? "ok" : "no"} · {r.at} · {r.label}
                </span>
              ))}
            </div>
          )}
        </footer>
      </div>
    </main>
  );
}
```

- [ ] **Step 4: Create the four routes**

Create `userpage/app/gate/person-entry/page.tsx`:

```tsx
import GateTerminal from "@/components/gate/GateTerminal";

export const metadata = { title: "Person Entry · Gate Terminal" };

export default function Page() {
  return <GateTerminal routeId="person-entry" />;
}
```

Create the three siblings identically, changing only the directory, the `routeId`, and the title:

| File | `routeId` | title |
|---|---|---|
| `app/gate/person-exit/page.tsx` | `"person-exit"` | `Person Exit · Gate Terminal` |
| `app/gate/vehicle-entry/page.tsx` | `"vehicle-entry"` | `Vehicle Entry · Gate Terminal` |
| `app/gate/vehicle-exit/page.tsx` | `"vehicle-exit"` | `Vehicle Exit · Gate Terminal` |

- [ ] **Step 5: Verify it compiles, lints, and builds**

Run:
```bash
cd C:\thesis_rfid\userpage
npx tsc --noEmit
npm run lint
npm run build
```
Expected: all three exit 0, and the build output lists the four `/gate/*` routes.

- [ ] **Step 6: Verify by hand**

With both dev servers running:

1. Open `http://localhost:5173/gate/person-entry`.
   Expected: the "This terminal isn't set up" screen.
2. Sign in as `testregistrar` / `Registrar@123`.
   Expected: refused with "Only a superadmin can set up a gate terminal."
3. Sign in as `testadmin` / `Admin@123`.
   Expected: the READY screen showing `MAIN ENTRANCE` and `Person · Entry`.
4. Reload the page.
   Expected: straight to READY — no setup prompt, because the key persisted.
5. Type `A1B2C3D4` and press Enter (this is exactly what a USB reader does).
   Expected: full-screen green GRANTED with Juan Dela Cruz's name, and the photo if you gave him one in Task 4.
6. Type `DEADBEEF` and press Enter.
   Expected: full-screen red DENIED, "Unregistered card".
7. Open `http://localhost:5173/gate/vehicle-entry`, provision it, then tap `A1B2C3D4`.
   Expected: red DENIED, "Wrong gate for this card".
8. Stop the `serverside` dev server and tap again.
   Expected: **amber** OFFLINE, "The tap was not recorded." Confirm it is visually distinct from green. Restart the server afterwards.
9. Re-provision `person-entry` from a second browser, then tap on the first.
   Expected: the first terminal drops back to the setup screen, because minting revoked its key.

- [ ] **Step 7: Commit**

```bash
git add app/gate components/gate
git commit -m "feat(gates): four gate terminal pages with wedge capture and provisioning"
```

---

## Task 11: Seed data and documentation

**Files:**
- Modify: `serverside/src/config/testSeed.ts`
- Modify: `serverside/README.md`
- Modify: `userpage/README.md`

**Interfaces:**
- Consumes: everything prior.
- Produces: seeded photos for two people, one device key per gate printed at seed time.

- [ ] **Step 1: Seed photos and keys**

In `serverside/src/config/testSeed.ts`, add the imports:

```ts
import { randomBytes } from 'crypto';
import { PersonPhotoModel } from '../modules/persons/personPhotos.model';
import { GateKeyModel } from '../modules/gates/gateKeys.model';
```

Add this constant near the other module-level constants — a real 1x1 JPEG, so the photo endpoint has valid bytes to serve:

```ts
/** A 1x1 JPEG. Placeholder pixels, not a face — enough for the terminal to render. */
const PLACEHOLDER_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
    'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
    'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64'
);
```

Add this function above `seedTest`:

```ts
async function seedPhotosAndKeys(persons: IPerson[], adminId: Types.ObjectId): Promise<void> {
  // Photos for two people, so the gate terminal has faces to show.
  for (const idNumber of ['2025-0001', 'EMP-1001']) {
    const person = persons.find((p) => p.id_number === idNumber);
    if (!person) continue;
    const existing = await PersonPhotoModel.findOne({ person_id: person._id });
    if (existing) {
      console.log(`[test-seed] photo for '${idNumber}' already exists — skipping`);
      continue;
    }
    await PersonPhotoModel.create({
      person_id: person._id,
      data: PLACEHOLDER_JPEG,
      mime: 'image/jpeg',
      byte_size: PLACEHOLDER_JPEG.length,
    });
    await PersonModel.updateOne(
      { _id: person._id },
      { $set: { photo_url: `/persons/${person._id}/photo` } }
    );
    console.log(`[test-seed] created placeholder photo for '${idNumber}'`);
  }

  // One device key per gate, so a terminal can be provisioned without the UI.
  const gates = await GateModel.find();
  for (const gate of gates) {
    const active = await GateKeyModel.findOne({ gate_id: gate._id, is_active: true });
    if (active) {
      console.log(`[test-seed] gate '${gate.name}' already has an active key — skipping`);
      continue;
    }
    const prefix = randomBytes(4).toString('hex');
    const secret = randomBytes(16).toString('hex');
    const key = `gk_live_${prefix}${secret}`;
    await GateKeyModel.create({
      gate_id: gate._id,
      key_hash: await bcrypt.hash(key, 12),
      key_prefix: prefix,
      created_by: adminId,
    });
    // Printed once, and never in production — the plaintext is unrecoverable.
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[test-seed] gate '${gate.name}' (${gate.type}/${gate.direction}) key: ${key}`);
    }
  }
}
```

In `seedTest`, capture the admin id where the superadmin is created or found, and call the new function after `seedDemoActivity(persons)`:

```ts
  const adminDoc = await UserModel.findOne({ username: HARDCODED_ADMIN.username });
  if (!adminDoc) throw new Error('[test-seed] superadmin missing after seeding');
  await seedPhotosAndKeys(persons, adminDoc._id);
```

Add `PersonModel` to the existing `persons.model` import if it is not already there.

- [ ] **Step 2: Reseed and verify**

Run:
```bash
cd C:\thesis_rfid\serverside
npm run seed:test
```
Expected: four `key:` lines printed, and two placeholder-photo lines.

Run it a second time.
Expected: every line reports "already exists — skipping", and **no** new keys are printed. Idempotence matters here: re-minting on every seed would silently kill provisioned terminals.

- [ ] **Step 3: Run both harnesses**

Run:
```bash
npm run verify:roles
npm run verify:gates
```
Expected: both pass. Note that `verify:gates` mints its own keys, which revokes the seeded key for Main Entrance and Parking Entrance — this is expected, and a terminal provisioned from those seeded keys must be re-provisioned after a harness run.

- [ ] **Step 4: Document it**

Add to `serverside/README.md`, under the existing scripts section:

```markdown
### Gate terminals

Each of the four gates has a fixed `type` (person/vehicle) and `direction`
(entry/exit). A terminal authenticates with a per-gate device key sent as
`X-Gate-Key`; the server derives the gate and direction from the key, so a
terminal posts only `{ rfid_uid }`.

- `POST /gates/:id/key` (superadmin) mints a key and revokes that gate's
  previous ones. The plaintext is returned once and is not recoverable.
- `npm run seed:test` prints one key per gate for local development.
- `npm run verify:gates` asserts the photo pipeline and gate behavior. It mints
  its own keys, so terminals provisioned beforehand need re-provisioning after.

### Photos

`POST /persons/:id/photo` (registrar/superadmin, multipart field `photo`, 1MB
cap) stores bytes in the `personphotos` collection and sets `photo_url` to
`/persons/<id>/photo`. Uploads are classified by magic bytes, not by the
declared Content-Type. `GET /persons/:id/photo` accepts a user JWT or a gate
key.
```

Add to `userpage/README.md`:

```markdown
### Gate terminal pages

`/gate/person-entry`, `/gate/person-exit`, `/gate/vehicle-entry`,
`/gate/vehicle-exit`.

Each page is a scan receiver for one gate. A USB RFID reader enumerates as a
keyboard and types the UID followed by Enter into a hidden focused input; the
page posts the tap and shows the decision full-screen for 5 seconds.

On first open, a superadmin signs in on the terminal to bind it to its gate.
The minted device key is kept in `localStorage` and the admin session is
discarded. If the key is later revoked, the next tap returns the page to the
setup screen.

Green means granted, red means denied, **amber means the system did not
decide** (offline, rate limited, or a server error) and the tap was not
recorded.

Photos are fetched through `AuthedImage`, because the API authenticates with a
Bearer token and a plain `<img src>` cannot send headers.
```

- [ ] **Step 5: Commit**

```bash
cd C:\thesis_rfid\serverside
git add src/config/testSeed.ts README.md
git commit -m "feat(seed): seed gate device keys and placeholder photos"

cd C:\thesis_rfid\userpage
git add README.md
git commit -m "docs: gate terminal pages and photo rendering"
```

---

## Verification checklist

Run before considering the plan complete:

```bash
cd C:\thesis_rfid\serverside
npm run build        # exit 0
npm run lint         # exit 0
npm run verify:roles # unchanged pass count
npm run verify:gates # all checks pass
npm run verify:gates # byte-identical to the previous run

cd C:\thesis_rfid\userpage
npx tsc --noEmit     # exit 0
npm run lint         # exit 0
npm run build        # exit 0, four /gate/* routes listed
```

## Deferred, and why

- **Hardware readers that post scans themselves.** The page is the terminal. An ESP32 would post to the same endpoint with the same key, but nothing here builds or tests that path.
- **Several terminals per gate.** Minting revokes; this is the accepted cost of never storing a recoverable key.
- **A key-management admin screen.** Revocation is minting a replacement.
- **Server-side image re-encoding.** The size cap plus magic-byte validation carries the risk; `sharp` is a native dependency for marginal gain.
- **Gadget photos and the gadget gate-type exemption.** Subsystem B is not implemented. When it lands, `scan.service.ts` must apply the `wrong_gate_type` check only to `person` and `vehicle` entities.
