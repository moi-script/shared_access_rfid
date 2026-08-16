# Vehicle Limits and Photos Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the four-value vehicle type enum with six types carrying per-person registration limits, store vehicle photos in MongoDB, and show both the vehicle and its owner on the parking-gate terminal.

**Architecture:** A new server-side constants module becomes the single source of truth for vehicle types and their per-person limits; the Mongoose enums, both zod schemas, and the limit checks all read from it. The one-active-vehicle rule in `vehicles.service.ts` is replaced by a per-type count over the vehicles a person may currently use. Vehicle photos get their own collection and route trio mirroring the existing `PersonPhoto` implementation field for field, and the scan response gains a `vehicle_photo_url` alongside a fix for the owner photo the vehicle-tag path never sent.

**Tech Stack:** Express 4 + Mongoose 8 + zod 3 on `serverside`; Next.js 16 + React 19 + Tailwind 4 on `userpage`. TypeScript 5 throughout.

## Global Constraints

- **Vehicle types, exact and ordered:** `motorcycle`, `multicab`, `van`, `pickup`, `auv`, `truck`.
- **Per-person limits, exact:** motorcycle 1, multicab 3, van 3, pickup 3, auv 1, truck 1. Twelve total.
- **A vehicle counts toward a limit only when it is active AND unexpired** — `status: 'active'` and `valid_until >= now`. This is exactly what `vehicleRepo.findActiveByOwner` already returns.
- **Migration mapping:** `car` → `pickup`, `tricycle` → `motorcycle`, `other` → `van`, `motorcycle` unchanged.
- **There is no git repository** at `C:\thesis_rfid` or in either subproject, so no task has a commit step. Each task ends with a compile gate instead. If you want commits, run `git init` in `C:\thesis_rfid` first and add `git add -A && git commit` to the end of each task.
- **There is no unit test framework.** This codebase verifies behaviour with hand-rolled scripts in `serverside/src/config/verify*.ts` that drive a running server over HTTP. Task 8 writes one for this feature. Every other task's gate is `npm run build` (which is `tsc`).
- **Never write the literal type list twice.** Server code imports `VEHICLE_TYPES`; the frontend has exactly one mirror, in `userpage/lib/vehicleTypes.ts`.
- Server commands run from `C:\thesis_rfid\serverside`, frontend commands from `C:\thesis_rfid\userpage`.

---

## File Structure

**Created:**

| File | Responsibility |
| --- | --- |
| `serverside/src/constants/vehicleTypes.ts` | The six types, their per-person limits, and the `VehicleType` union. Single source of truth. |
| `serverside/src/config/migrateVehicleTypes.ts` | One-off idempotent rewrite of old type values in two collections. |
| `serverside/src/modules/vehicles/vehiclePhotos.model.ts` | `VehiclePhoto` collection: bytes, mime, size, keyed uniquely by vehicle. |
| `serverside/src/modules/vehicles/vehiclePhotos.repository.ts` | The three data operations, plus the lean()-read Buffer fix. |
| `serverside/src/modules/vehicles/vehiclePhotos.service.ts` | Authority, magic-byte validation, and keeping `vehicle.photo_url` in sync. |
| `serverside/src/config/verifyVehicles.ts` | HTTP-level verification of limits and photo display. |
| `userpage/lib/vehicleTypes.ts` | Frontend mirror of the type list and limits. |

**Modified:**

| File | Change |
| --- | --- |
| `serverside/src/modules/vehicles/vehicles.model.ts:8,27-31` | Enum reads from constants. |
| `serverside/src/modules/vehicles/vehicles.schema.ts:12` | zod enum reads from constants. |
| `serverside/src/modules/vehicles/vehicles.service.ts:64-72,139-151` | Per-type limits replace the one-vehicle rule. |
| `serverside/src/modules/vehicles/vehicles.repository.ts:42` | Projection gains `photo_url`. |
| `serverside/src/modules/vehicles/vehicles.controller.ts` | Three photo handlers. |
| `serverside/src/modules/vehicles/vehicles.routes.ts` | Three photo routes, GET before the router-level authorize. |
| `serverside/src/modules/vehicleApplications/vehicleApplications.model.ts:9,66-70` | Enum reads from constants. |
| `serverside/src/modules/vehicleApplications/vehicleApplications.schema.ts:10` | zod enum reads from constants. |
| `serverside/src/modules/vehicleApplications/vehicleApplications.service.ts:26,125-131` | Type import; limit pre-check. |
| `serverside/src/modules/scan/scan.service.ts:32,126-134,177-184` | `vehicle_photo_url`; owner `photo_url` fix; comment rewrite. |
| `serverside/src/config/testSeed.ts:176,180` | New type names. |
| `serverside/src/config/verifyGates.ts`, `verifyRoles.ts` | New type names; one-vehicle assertions rewritten. |
| `serverside/package.json` | Two new scripts. |
| `userpage/lib/gateTerminal.ts:57` | `vehicle_photo_url` on the tap shape. |
| `userpage/lib/reasonText.ts:17` | New `multiple_vehicles` wording. |
| `userpage/components/vehicles/VehicleApplicationForm.tsx` | Six types; two photo captures; two uploads after create. |
| `userpage/components/gate/GateTerminal.tsx:276-289` | Two-frame vehicle layout. |

---

### Task 1: Vehicle type constants and enums

Introduces the single source of truth and points every enum at it. After this task the server refuses to register `car` and accepts `pickup`, but no limit logic has changed yet.

**Files:**
- Create: `serverside/src/constants/vehicleTypes.ts`
- Modify: `serverside/src/modules/vehicles/vehicles.model.ts`
- Modify: `serverside/src/modules/vehicles/vehicles.schema.ts`
- Modify: `serverside/src/modules/vehicleApplications/vehicleApplications.model.ts`
- Modify: `serverside/src/modules/vehicleApplications/vehicleApplications.schema.ts`
- Modify: `serverside/src/modules/vehicleApplications/vehicleApplications.service.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `VEHICLE_TYPES: readonly VehicleType[]`, `type VehicleType`, `VEHICLE_LIMITS: Record<VehicleType, number>` from `../../constants/vehicleTypes`.

- [ ] **Step 1: Create the constants module**

Create `serverside/src/constants/vehicleTypes.ts`:

```ts
/**
 * The vehicle types the OSS office registers, and how many of each one
 * person may hold at once.
 *
 * This is the ONLY place the list lives on the server. The Mongoose enums on
 * Vehicle and VehicleApplication, both zod schemas, and the limit check in
 * vehicles.service all read from here — the list used to be repeated at eight
 * sites, which is how a model and its schema drift apart and start accepting
 * values the other rejects.
 *
 * `userpage/lib/vehicleTypes.ts` mirrors this for the browser; the two are
 * separate deployables and cannot share an import. Change both together.
 */
export const VEHICLE_TYPES = [
  'motorcycle',
  'multicab',
  'van',
  'pickup',
  'auv',
  'truck',
] as const;

export type VehicleType = (typeof VEHICLE_TYPES)[number];

/**
 * Per-person allowance, counted over ACTIVE and UNEXPIRED vehicles only (see
 * vehicleRepo.findActiveByOwner). Deactivating a pass or letting it expire
 * frees the slot, so a person who replaces a van three times is not locked
 * out — the old rows survive for history without consuming the allowance.
 *
 * There is deliberately no TOTAL constant. The total is the sum of these
 * numbers; a second figure that has to agree with the first is a defect
 * waiting for someone to edit one and not the other.
 */
export const VEHICLE_LIMITS: Record<VehicleType, number> = {
  motorcycle: 1,
  multicab: 3,
  van: 3,
  pickup: 3,
  auv: 1,
  truck: 1,
};

/** Plural for an error message: 1 van, 3 vans. */
export function pluralizeType(type: VehicleType, count: number): string {
  return count === 1 ? type : `${type}s`;
}
```

- [ ] **Step 2: Point the Vehicle model at it**

In `serverside/src/modules/vehicles/vehicles.model.ts`, add the import at the top:

```ts
import { VEHICLE_TYPES, VehicleType } from '../../constants/vehicleTypes';
```

Change the interface field (line 8) from the inline union to:

```ts
  vehicle_type: VehicleType;
```

Change the schema field (lines 27-31) to:

```ts
    vehicle_type: {
      type: String,
      // Spread to a mutable array: `as const` gives a readonly tuple, which
      // Mongoose's enum option does not accept.
      enum: [...VEHICLE_TYPES],
      required: true,
    },
```

- [ ] **Step 3: Point the Vehicle zod schema at it**

In `serverside/src/modules/vehicles/vehicles.schema.ts`, add:

```ts
import { VEHICLE_TYPES } from '../../constants/vehicleTypes';
```

and replace line 12 with:

```ts
  // zod's enum needs a mutable [string, ...string[]] tuple, so the readonly
  // const array is spread and re-asserted. This is the whole cost of having
  // one list instead of two.
  vehicle_type: z.enum([...VEHICLE_TYPES] as [string, ...string[]]),
```

- [ ] **Step 4: Point the VehicleApplication model and schema at it**

In `serverside/src/modules/vehicleApplications/vehicleApplications.model.ts`, add the same import (path `'../../constants/vehicleTypes'`), change line 9 to `vehicle_type: VehicleType;`, and change lines 66-70 to:

```ts
    vehicle_type: {
      type: String,
      enum: [...VEHICLE_TYPES],
      required: true,
    },
```

In `serverside/src/modules/vehicleApplications/vehicleApplications.schema.ts`, add the import and replace line 10 with the same `z.enum([...VEHICLE_TYPES] as [string, ...string[]])` expression used in Step 3.

- [ ] **Step 5: Fix the application service's input type**

In `serverside/src/modules/vehicleApplications/vehicleApplications.service.ts`, add to the imports:

```ts
import { VehicleType } from '../../constants/vehicleTypes';
```

and change line 26 from the inline union to:

```ts
  vehicle_type: VehicleType;
```

- [ ] **Step 6: Compile**

Run from `serverside`: `npm run build`

Expected: clean. If `verifyGates.ts` / `verifyRoles.ts` / `testSeed.ts` report errors about `'motorcycle' | 'car' | ...`, leave them — Task 7 fixes those files, and they are standalone scripts that do not affect the server build output. If `npm run build` itself fails because of them, note the failing lines and proceed; Task 7 is the fix.

---

### Task 2: Migration script for existing rows

Rewrites old type values in place so nothing in the database is left holding a value the enum no longer accepts.

**Files:**
- Create: `serverside/src/config/migrateVehicleTypes.ts`
- Modify: `serverside/package.json`

**Interfaces:**
- Consumes: nothing from Task 1 at runtime (it writes raw values through the native driver, deliberately bypassing Mongoose validation — the whole point is to fix rows the new enum would reject).
- Produces: `npm run migrate:vehicle-types`.

- [ ] **Step 1: Read the existing connection helper**

Open `serverside/src/config/db.ts` and `serverside/src/config/rebuildOccupancy.ts`. `rebuildOccupancy.ts` is the closest existing example of a standalone maintenance script — copy its connect/disconnect and env-loading shape exactly rather than inventing a new one.

- [ ] **Step 2: Write the migration**

Create `serverside/src/config/migrateVehicleTypes.ts`:

```ts
/**
 * One-off, idempotent rewrite of the old vehicle_type values to the six-type
 * list in constants/vehicleTypes.ts.
 *
 * Run with: npm run migrate:vehicle-types
 *
 * Writes through the native collection driver rather than the Mongoose model
 * on purpose: the model's enum no longer accepts the OLD values, so a
 * model-level update of a row holding `car` would fail validation on the very
 * documents this script exists to repair.
 *
 * Idempotent because the replacement values are disjoint from the keys it
 * matches — `pickup` is not `car`, so a second run matches nothing. It prints
 * per-collection counts so an already-migrated database reads as a visible
 * no-op instead of an ambiguous silence.
 */
import mongoose from 'mongoose';
import { env } from './env';

// motorcycle is absent deliberately: it survives the change unmodified, and
// listing it as motorcycle -> motorcycle would make the run non-idempotent in
// appearance (a nonzero modified count forever) without changing anything.
const MAPPING: Record<string, string> = {
  car: 'pickup',
  tricycle: 'motorcycle',
  other: 'van',
};

const COLLECTIONS = ['vehicles', 'vehicleapplications'];

async function main(): Promise<void> {
  await mongoose.connect(env.MONGO_URI);
  console.log(`Connected. Migrating vehicle_type across ${COLLECTIONS.join(', ')}.`);

  let grandTotal = 0;
  for (const name of COLLECTIONS) {
    const collection = mongoose.connection.collection(name);
    let collectionTotal = 0;
    for (const [from, to] of Object.entries(MAPPING)) {
      const result = await collection.updateMany(
        { vehicle_type: from },
        { $set: { vehicle_type: to } }
      );
      if (result.modifiedCount > 0) {
        console.log(`  ${name}: ${from} -> ${to}  (${result.modifiedCount})`);
      }
      collectionTotal += result.modifiedCount;
    }
    console.log(`  ${name}: ${collectionTotal} document(s) updated`);
    grandTotal += collectionTotal;

    // Anything still holding a value outside the new list is a row this
    // mapping did not anticipate. Report it rather than leaving it to fail
    // silently the next time someone edits that record.
    const leftover = await collection
      .aggregate([
        { $match: { vehicle_type: { $nin: ['motorcycle', 'multicab', 'van', 'pickup', 'auv', 'truck'] } } },
        { $group: { _id: '$vehicle_type', count: { $sum: 1 } } },
      ])
      .toArray();
    for (const row of leftover) {
      console.log(`  WARNING ${name}: ${row.count} document(s) still hold '${row._id}'`);
    }
  }

  console.log(`\nDone. ${grandTotal} document(s) updated in total.`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

If `env.MONGO_URI` is not the export name in `config/env.ts`, use whatever that file actually exports — check it, do not guess.

- [ ] **Step 3: Register the script**

In `serverside/package.json`, add to `"scripts"`, after `"rebuild:occupancy"`:

```json
    "migrate:vehicle-types": "ts-node src/config/migrateVehicleTypes.ts",
```

- [ ] **Step 4: Run it**

Run from `serverside`: `npm run migrate:vehicle-types`

Expected: a per-collection count and no WARNING lines.

- [ ] **Step 5: Run it a second time to prove idempotence**

Run: `npm run migrate:vehicle-types`

Expected: `0 document(s) updated in total.` If the second run reports a nonzero count, the mapping has a cycle — stop and fix it before continuing.

---

### Task 3: Per-person type limits

Replaces the one-active-vehicle rule at all three sites that can arm the barrier.

**Files:**
- Modify: `serverside/src/modules/vehicles/vehicles.service.ts:64-72` and `:139-151`
- Modify: `serverside/src/modules/vehicleApplications/vehicleApplications.service.ts:125-131`

**Interfaces:**
- Consumes: `VEHICLE_LIMITS`, `VehicleType`, `pluralizeType` from Task 1.
- Produces: `assertWithinLimit(active, type, ownerName, excludeId?)` — a module-private helper in `vehicles.service.ts`, exported so `vehicleApplications.service.ts` can pre-check with identical wording.

- [ ] **Step 1: Add the shared limit helper**

At the top of `serverside/src/modules/vehicles/vehicles.service.ts`, add:

```ts
import { VEHICLE_LIMITS, VehicleType, pluralizeType } from '../../constants/vehicleTypes';
```

Then, above the `vehicleService` object, add:

```ts
/** The shape findActiveByOwner projects. Not the full IVehicle. */
interface ActiveVehicle {
  _id: unknown;
  vehicle_type: string;
}

/**
 * Refuses a registration that would put an owner over their allowance for
 * that vehicle type.
 *
 * `active` must come from vehicleRepo.findActiveByOwner, which already scopes
 * to status 'active' AND valid_until >= now — the exact definition of "a
 * vehicle this person may currently use". Counting all rows instead would
 * mean a replaced van consumes its slot forever.
 *
 * `excludeId` is the vehicle being updated. Without it, a no-op PATCH that
 * resends an already-active vehicle's own fields counts that vehicle against
 * its own limit and rejects itself.
 *
 * Exported so vehicleApplications.service can pre-check with identical
 * wording before it writes its immutable application row.
 */
export function assertWithinLimit(
  active: ActiveVehicle[],
  type: VehicleType,
  ownerName: string,
  excludeId?: unknown
): void {
  const limit = VEHICLE_LIMITS[type];
  const used = active.filter(
    (v) => v.vehicle_type === type && (!excludeId || String(v._id) !== String(excludeId))
  ).length;
  if (used >= limit) {
    throw new ApiError(
      'CONFLICT',
      `${ownerName} already has ${limit} active ${pluralizeType(type, limit)} (the limit). ` +
        'Deactivate one first.'
    );
  }
}
```

- [ ] **Step 2: Replace the one-vehicle rule in `create`**

In `vehicles.service.ts`, delete the entire block at lines 64-72 (the comment beginning "One ACTIVE vehicle per owner" through its closing brace) and put in its place:

```ts
    // Per-type allowance, replacing the old one-active-vehicle-per-owner
    // rule. That rule existed because the owner's CARD was the only key, so
    // two active passes gave the barrier no way to know which car was being
    // driven. Each vehicle now carries its own RFID sticker, so the barrier
    // identifies the vehicle directly and several active passes are fine.
    // scan.service.tap still denies an owner-CARD tap on a multi-vehicle
    // owner — see the multiple_vehicles branch there.
    if ((data.status ?? 'active') === 'active') {
      const active = await vehicleRepo.findActiveByOwner(owner._id, new Date());
      assertWithinLimit(active, data.vehicle_type as VehicleType, owner.full_name);
    }
```

- [ ] **Step 3: Replace the one-vehicle rule in `update`**

In `vehicles.service.ts`, inside the `if (willBeActive) {` block (lines 142-151), delete the `const active = ...` through the closing brace of the `if (others.length > 0)` throw, and put in its place:

```ts
        const active = await vehicleRepo.findActiveByOwner(owner._id, new Date());
        const effectiveType = (data.vehicle_type ?? current.vehicle_type) as VehicleType;
        // current._id is excluded: an already-active vehicle must not count
        // against its own limit on a PATCH that merely re-sends its fields.
        assertWithinLimit(active, effectiveType, owner.full_name, current._id);
```

Leave every surrounding comment in `update` intact — the three re-arming fields (`status`, `owner_person_id`, `valid_until`) and the `willBeActive` derivation are unchanged and their reasoning still holds.

- [ ] **Step 4: Pre-check in the application service**

In `serverside/src/modules/vehicleApplications/vehicleApplications.service.ts`, add to the imports:

```ts
import { vehicleService, assertWithinLimit } from '../vehicles/vehicles.service';
```

(replacing the existing `import { vehicleService } from '../vehicles/vehicles.service';`)

Then replace lines 125-131 (the `activeForOwner` block) with:

```ts
    // Pre-checked here for the same reason as DUPLICATE_RFID above: the write
    // order below is application-then-vehicle and applications are immutable,
    // so a limit breach discovered at the vehicle insert would leave an orphan
    // application nobody can edit or delete. Identical wording to the check
    // vehicleService.create runs, so a clerk sees one message, not two.
    const activeForOwner = await vehicleRepo.findActiveByOwner(owner._id, new Date());
    assertWithinLimit(activeForOwner, input.vehicle_type, owner.full_name);
```

- [ ] **Step 5: Compile**

Run from `serverside`: `npm run build`

Expected: clean apart from any pre-existing errors in the `verify*.ts` / `testSeed.ts` scripts that Task 7 will fix.

---

### Task 4: Vehicle photo storage

Mirrors the `PersonPhoto` trio field for field. After this task a vehicle photo can be uploaded, fetched, and deleted over HTTP; nothing displays it yet.

**Files:**
- Create: `serverside/src/modules/vehicles/vehiclePhotos.model.ts`
- Create: `serverside/src/modules/vehicles/vehiclePhotos.repository.ts`
- Create: `serverside/src/modules/vehicles/vehiclePhotos.service.ts`
- Modify: `serverside/src/modules/vehicles/vehicles.controller.ts`
- Modify: `serverside/src/modules/vehicles/vehicles.routes.ts`
- Modify: `serverside/src/modules/vehicles/vehicles.repository.ts:42`

**Interfaces:**
- Consumes: `detectImageType` / `ImageMime` from `utils/imageType`, `assertCanWrite` / `Actor` from `utils/authority`, `uploadPhoto` from `middlewares/uploadImage`, `authenticateAny` from `middlewares/authenticateAny`.
- Produces: `vehiclePhotoService.upload(vehicleId, actor, file)`, `.get(vehicleId)`, `.remove(vehicleId, actor)`; routes `GET|POST|DELETE /api/vehicles/:id/photo`.

- [ ] **Step 1: Read the model being mirrored**

Open `serverside/src/modules/persons/personPhotos.model.ts`, `personPhotos.repository.ts`, and `personPhotos.service.ts`. Every decision below is copied from them; read them so the copy is faithful rather than approximate.

- [ ] **Step 2: Create the model**

Create `serverside/src/modules/vehicles/vehiclePhotos.model.ts`:

```ts
import { Schema, model, Document, Types } from 'mongoose';
import { ImageMime } from '../../utils/imageType';

export interface IVehiclePhoto extends Document {
  _id: Types.ObjectId;
  vehicle_id: Types.ObjectId;
  data: Buffer;
  mime: ImageMime;
  byte_size: number;
  updatedAt: Date;
}

const vehiclePhotoSchema = new Schema<IVehiclePhoto>(
  {
    // Unique: a second upload replaces the first rather than orphaning it.
    vehicle_id: {
      type: Schema.Types.ObjectId,
      ref: 'Vehicle',
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

export const VehiclePhotoModel = model<IVehiclePhoto>('VehiclePhoto', vehiclePhotoSchema);
```

- [ ] **Step 3: Create the repository**

Create `serverside/src/modules/vehicles/vehiclePhotos.repository.ts`:

```ts
import { Types } from 'mongoose';
import { VehiclePhotoModel, IVehiclePhoto } from './vehiclePhotos.model';
import { ImageMime } from '../../utils/imageType';

export const vehiclePhotoRepo = {
  findByVehicleId: async (vehicleId: string) => {
    const photo = await VehiclePhotoModel.findOne({
      vehicle_id: new Types.ObjectId(vehicleId),
    }).lean<IVehiclePhoto | null>();
    // The MongoDB driver hands lean() reads back as a raw BSON Binary, not a
    // Node Buffer — left as-is, Express's res.send() fails Buffer.isBuffer()
    // and silently JSON-serializes the wrapper instead of sending image bytes.
    // Same fix as personPhotos.repository, same reason.
    if (photo && !Buffer.isBuffer(photo.data)) {
      photo.data = Buffer.from((photo.data as unknown as { buffer: Buffer }).buffer);
    }
    return photo;
  },

  /** Upsert keeps the unique vehicle_id index satisfied on re-upload. */
  upsert: (vehicleId: string, data: Buffer, mime: ImageMime) =>
    VehiclePhotoModel.findOneAndUpdate(
      { vehicle_id: new Types.ObjectId(vehicleId) },
      { data, mime, byte_size: data.length },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean<IVehiclePhoto>(),

  deleteByVehicleId: (vehicleId: string) =>
    VehiclePhotoModel.deleteOne({ vehicle_id: new Types.ObjectId(vehicleId) }),
};
```

- [ ] **Step 4: Create the service**

Create `serverside/src/modules/vehicles/vehiclePhotos.service.ts`:

```ts
import { Types } from 'mongoose';
import { vehiclePhotoRepo } from './vehiclePhotos.repository';
import { VehicleModel } from './vehicles.model';
import { detectImageType } from '../../utils/imageType';
import { ApiError } from '../../utils/ApiError';
import { Actor, assertCanWrite } from '../../utils/authority';

const INTERNAL_PHOTO_URL = (id: string) => `/vehicles/${id}/photo`;

function assertValidId(id: string): void {
  if (!Types.ObjectId.isValid(id)) throw new ApiError('NOT_FOUND', 'Vehicle not found');
}

export const vehiclePhotoService = {
  async upload(vehicleId: string, actor: Actor, file: Express.Multer.File | undefined) {
    assertValidId(vehicleId);
    if (!file) throw new ApiError('VALIDATION_ERROR', 'No photo uploaded (field name: photo)');

    assertCanWrite(actor, 'vehicle');
    const vehicle = await VehicleModel.findById(vehicleId);
    if (!vehicle) throw new ApiError('NOT_FOUND', 'Vehicle not found');

    // The declared Content-Type is ignored; only the bytes decide.
    const mime = detectImageType(file.buffer);
    if (!mime) {
      throw new ApiError('VALIDATION_ERROR', 'File is not a JPEG, PNG, or WebP image');
    }

    const saved = await vehiclePhotoRepo.upsert(vehicleId, file.buffer, mime);
    vehicle.photo_url = INTERNAL_PHOTO_URL(vehicleId);
    await vehicle.save();

    return { photo_url: vehicle.photo_url, mime: saved.mime, byte_size: saved.byte_size };
  },

  /**
   * No actor argument, unlike personPhotoService.get. A person photo needs an
   * ownership check because a student may fetch their own face and nobody
   * else's; a vehicle has no such self-service surface, so any caller the
   * route already authenticated — staff session or gate device key — may read
   * it. The route is what restricts this, not the service.
   */
  async get(vehicleId: string) {
    assertValidId(vehicleId);
    const photo = await vehiclePhotoRepo.findByVehicleId(vehicleId);
    if (!photo) throw new ApiError('NOT_FOUND', 'No photo on file');
    return photo;
  },

  async remove(vehicleId: string, actor: Actor) {
    assertValidId(vehicleId);
    assertCanWrite(actor, 'vehicle');
    const vehicle = await VehicleModel.findById(vehicleId);
    if (!vehicle) throw new ApiError('NOT_FOUND', 'Vehicle not found');

    await vehiclePhotoRepo.deleteByVehicleId(vehicleId);

    // Only clear photo_url when it points at us. An externally hosted URL is
    // not ours to erase.
    if (vehicle.photo_url === INTERNAL_PHOTO_URL(vehicleId)) {
      vehicle.photo_url = undefined;
      await vehicle.save();
    }
    return { photo_url: vehicle.photo_url ?? null };
  },
};
```

- [ ] **Step 5: Add the controller handlers**

In `serverside/src/modules/vehicles/vehicles.controller.ts`, add the import:

```ts
import { vehiclePhotoService } from './vehiclePhotos.service';
```

and add these three handlers inside the `vehicleController` object:

```ts
  uploadPhoto: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await vehiclePhotoService.upload(req.params.id, actorOf(req), req.file), 201);
  }),
  getPhoto: asyncHandler(async (req: Request, res: Response) => {
    const photo = await vehiclePhotoService.get(req.params.id);
    const etag = `W/"${photo.updatedAt.getTime()}-${photo.byte_size}"`;
    // A gate terminal re-requests the same vehicles all day.
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
    sendSuccess(res, await vehiclePhotoService.remove(req.params.id, actorOf(req)));
  }),
```

- [ ] **Step 6: Add the routes — ordering is load-bearing**

In `serverside/src/modules/vehicles/vehicles.routes.ts`, add these imports:

```ts
import { authenticateAny } from '../../middlewares/authenticateAny';
import { uploadPhoto } from '../../middlewares/uploadImage';
```

Insert this **above** the existing `vehicleRoutes.use(authenticate, authorize(...))` call:

```ts
// Declared BEFORE the router-level authenticate/authorize on purpose. A gate
// terminal has no user session — it authenticates with X-Gate-Key, which
// `authenticate` rejects. Put this route below the .use() and every terminal
// fetch 401s, the AuthedImage falls back to its placeholder, and the failure
// looks like "the photo didn't upload" rather than "the route is unreachable".
// persons.routes.ts:24 uses the identical pattern for face photos.
vehicleRoutes.get('/:id/photo', authenticateAny, vehicleController.getPhoto);
```

Then add these two **after** the existing `vehicleRoutes.patch('/:id/status', ...)` line, where the router-level guards apply:

```ts
vehicleRoutes.post('/:id/photo', uploadPhoto, vehicleController.uploadPhoto);
vehicleRoutes.delete('/:id/photo', vehicleController.deletePhoto);
```

- [ ] **Step 7: Include `photo_url` in the gate-facing projection**

In `serverside/src/modules/vehicles/vehicles.repository.ts`, change the `.select()` on line 42 from:

```ts
      .select('vehicle_type make plate_number')
```

to:

```ts
      // photo_url joins the projection for the gate terminal's vehicle frame.
      // Without it the single-card grant path in scan.service reads
      // `v.photo_url` as undefined and the terminal shows a placeholder for a
      // vehicle that does have a photo.
      .select('vehicle_type make plate_number photo_url')
```

- [ ] **Step 8: Compile**

Run from `serverside`: `npm run build`

Expected: clean apart from the pre-existing `verify*.ts` errors Task 7 fixes.

---

### Task 5: Photo fields on the scan response

Adds `vehicle_photo_url` and fixes the owner photo the vehicle-tag path never sent.

**Files:**
- Modify: `serverside/src/modules/scan/scan.service.ts:32`, `:111-118`, `:126-134`, `:176-184`

**Interfaces:**
- Consumes: `photo_url` on the `findActiveByOwner` projection (Task 4, Step 7).
- Produces: `TapResult['person'].vehicle_photo_url?: string` — consumed by Task 6's `TapDecision` mirror.

- [ ] **Step 1: Extend the result type**

In `serverside/src/modules/scan/scan.service.ts`, inside the `TapResult` interface's `person` block, add after `photo_url` (line 30):

```ts
    /** The VEHICLE's photo. `photo_url` above stays the owner's face — the
     *  terminal shows both side by side on a vehicle gate. */
    vehicle_photo_url?: string;
```

- [ ] **Step 2: Rewrite the `multiple_vehicles` comment**

Replace the comment at lines 112-116 (beginning "Registration enforces one active vehicle per owner") with:

```ts
              // Expected, not exceptional. A person may now hold several
              // active vehicles (see constants/vehicleTypes VEHICLE_LIMITS),
              // so their CARD cannot say which one they are driving. The
              // vehicle's own RFID sticker can, and is the intended lane —
              // this denial tells the guard to use it. Refusing to guess is
              // the point: granting here would log a plate nobody verified
              // into the scan log, the occupancy roster and the anomaly
              // report.
```

- [ ] **Step 3: Add the vehicle photo to the owner-card grant**

In the `personView` assignment at lines 126-134, add one line after `vehicle: { ... }`:

```ts
                vehicle_photo_url: v.photo_url,
```

- [ ] **Step 4: Fix the vehicle-tag path's owner photo and add the vehicle photo**

Replace the `personView` assignment at lines 177-184 with:

```ts
          personView = {
            full_name: owner?.full_name ?? 'Unknown owner',
            type: 'vehicle',
            owner_type: owner?.type,
            department_section: owner?.department_section ?? null,
            // The owner's FACE. This was missing: the owner-card path above
            // has always sent it and this one never did, so a sticker tap
            // showed a name with no face — and the sticker is now the primary
            // lane for anyone with more than one vehicle.
            photo_url: owner?.photo_url,
            plate_number: vehicle.plate_number,
            vehicle: { vehicle_type: vehicle.vehicle_type, make: vehicle.make },
            vehicle_photo_url: vehicle.photo_url,
          };
```

- [ ] **Step 5: Confirm the denial rule still holds**

Read the `wrong_gate_type` block at lines 193-197 and the `registered` block at lines 288-291. Neither needs changing: `wrong_gate_type` clears `personView` wholesale, which takes the new field with it, and `registered` only ever attaches to a *person*-entity grant. Confirm this by reading — do not edit.

- [ ] **Step 6: Compile**

Run from `serverside`: `npm run build`

---

### Task 6: Gate terminal shows vehicle and owner

**Files:**
- Modify: `userpage/lib/gateTerminal.ts:57`
- Modify: `userpage/lib/reasonText.ts:17`
- Modify: `userpage/components/gate/GateTerminal.tsx`

**Interfaces:**
- Consumes: `vehicle_photo_url` from Task 5.
- Produces: nothing consumed downstream.

- [ ] **Step 1: Extend the tap shape**

In `userpage/lib/gateTerminal.ts`, in the `person` object of `TapDecision` (around line 57), add:

```ts
    vehicle_photo_url?: string;
```

- [ ] **Step 2: Reword the denial**

In `userpage/lib/reasonText.ts`, change line 17 to:

```ts
  multiple_vehicles: "Multiple vehicles — tap the vehicle's sticker",
```

- [ ] **Step 3: Add a vehicle-photo frame component**

In `userpage/components/gate/GateTerminal.tsx`, add this above the `GateTerminal` component (after `RegisteredItem`):

```tsx
/** The vehicle's own photo. Unlike PersonAvatar there are no initials to fall
 *  back to, so an absent or unfetchable photo shows a neutral glyph. */
function VehicleImage({ path, gateKey }: { path?: string; gateKey: string }) {
  const placeholder = <span className="font-display text-5xl font-700 opacity-60">—</span>;
  if (!path) return placeholder;
  return (
    <AuthedImage
      path={path}
      alt="Registered vehicle"
      className="h-full w-full object-cover"
      headers={{ "X-Gate-Key": gateKey }}
      fallback={placeholder}
    />
  );
}
```

and extend the existing import on line 4 to bring in the default export too:

```tsx
import AuthedImage, { PersonAvatar } from "@/components/AuthedImage";
```

- [ ] **Step 4: Render both frames on a vehicle gate**

Replace the `<div className="mt-8 flex items-center justify-center gap-8">` block (lines 276-289 — the frame containing `PersonAvatar`, up to and including its closing `</div>`) with:

```tsx
              <div className="mt-8 flex items-center justify-center gap-8">
                {/* Vehicle gates lead with the vehicle: it is the thing the
                    guard is looking at. The owner's face sits beside it,
                    smaller, to confirm who is driving. Person gates keep the
                    single-avatar layout — they have no vehicle to show. */}
                {meta.type === "vehicle" && (
                  <div className="grid h-56 w-72 shrink-0 place-items-center overflow-hidden rounded-2xl bg-current/15">
                    <VehicleImage
                      path={outcome.person?.vehicle_photo_url}
                      gateKey={config.key}
                    />
                  </div>
                )}
                <div className="grid h-44 w-44 shrink-0 place-items-center overflow-hidden rounded-2xl bg-current/15">
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
```

Do not touch the `<div className="min-w-0">` details column that follows — it stays exactly as it is.

- [ ] **Step 5: Build**

Run from `userpage`: `npm run build`

Expected: clean. `meta` and `config` are both already in scope at that point in the component — if TypeScript says otherwise, you have pasted the block into the wrong branch.

---

### Task 7: Registration form — six types and two photos

**Files:**
- Create: `userpage/lib/vehicleTypes.ts`
- Modify: `userpage/components/vehicles/VehicleApplicationForm.tsx`

**Interfaces:**
- Consumes: `POST /vehicles/:id/photo` and `POST /persons/:id/photo` (Task 4); `apiUpload` from `lib/auth`.
- Produces: nothing consumed downstream.

- [ ] **Step 1: Create the frontend mirror**

Create `userpage/lib/vehicleTypes.ts`:

```ts
/**
 * Mirror of serverside/src/constants/vehicleTypes.ts. The two projects are
 * separate deployables and cannot share an import — the server file is
 * authoritative, and both must be changed together.
 */
export const VEHICLE_TYPES = [
  "motorcycle",
  "multicab",
  "van",
  "pickup",
  "auv",
  "truck",
] as const;

export type VehicleType = (typeof VEHICLE_TYPES)[number];

/** Per-person allowance, counted over active and unexpired vehicles only. */
export const VEHICLE_LIMITS: Record<VehicleType, number> = {
  motorcycle: 1,
  multicab: 3,
  van: 3,
  pickup: 3,
  auv: 1,
  truck: 1,
};
```

- [ ] **Step 2: Point the form at it**

In `userpage/components/vehicles/VehicleApplicationForm.tsx`, delete line 11:

```tsx
const VEHICLE_TYPE = ["motorcycle", "car", "tricycle", "other"] as const;
```

and add to the imports:

```tsx
import { VEHICLE_TYPES, VEHICLE_LIMITS } from "@/lib/vehicleTypes";
```

Then replace every remaining `VEHICLE_TYPE` reference with `VEHICLE_TYPES` — there are two: the `FormState` type at line 24 (`vehicle_type: (typeof VEHICLE_TYPES)[number];`) and the `.map()` in the select at line 417. The default at line 64 (`vehicle_type: "motorcycle"`) is still a valid value and stays.

- [ ] **Step 3: Show the allowance next to the dropdown**

Directly under the `</select>` of the vehicle-type field (around line 422), add:

```tsx
            <span className="mt-1 block text-[12px] font-400 text-ink-soft">
              Limit: {VEHICLE_LIMITS[form.vehicle_type]} active per person
            </span>
```

- [ ] **Step 4: Add the two photo captures**

Find the `Section` containing the vehicle fields (make, model, colour). Add inside it:

```tsx
          <label className="block text-[13px] font-600 text-ink-soft">
            Vehicle photo
            <PhotoCapture onChange={setVehiclePhoto} />
          </label>
```

Then, in the applicant `Section`, add — rendered only when the selected owner has no face on file, because re-capturing one that already exists is churn the gate does not need:

```tsx
          {owner && !owner.photo_url && (
            <label className="block text-[13px] font-600 text-ink-soft">
              Owner photo — none on file yet
              <PhotoCapture onChange={setOwnerPhoto} />
            </label>
          )}
```

Add the two state hooks beside the existing `signatureFile` state:

```tsx
  const [vehiclePhoto, setVehiclePhoto] = useState<Blob | null>(null);
  const [ownerPhoto, setOwnerPhoto] = useState<Blob | null>(null);
```

Add the import:

```tsx
import PhotoCapture from "@/components/PhotoCapture";
```

`owner` must carry `photo_url` for the conditional above to work. Check the type the owner-search sets; if `photo_url` is absent, add it to that type and confirm the `/persons` search endpoint returns it. If it does not, drop the condition and always show the owner-photo capture rather than shipping one that never appears.

- [ ] **Step 5: Upload both photos after create**

In `submit()`, after the signature-upload block and before `setSuccess(...)`, add:

```tsx
      // Photos upload AFTER the create, because the vehicle id does not exist
      // until the server returns it. A failure here is reported but never
      // rolls anything back: the pass is already valid, and revoking gate
      // access over a missing image is the worse failure. Same posture as the
      // signature block above.
      const photoFailures: string[] = [];
      if (vehiclePhoto) {
        try {
          const fd = new FormData();
          fd.append("photo", vehiclePhoto, "vehicle.jpg");
          await apiUpload(`/vehicles/${created.vehicle._id}/photo`, fd);
        } catch (err) {
          photoFailures.push(`vehicle photo (${(err as Error).message})`);
        }
      }
      if (ownerPhoto) {
        try {
          const fd = new FormData();
          fd.append("photo", ownerPhoto, "owner.jpg");
          await apiUpload(`/persons/${owner._id}/photo`, fd);
        } catch (err) {
          photoFailures.push(`owner photo (${(err as Error).message})`);
        }
      }
      if (photoFailures.length > 0) {
        setError(
          `Registered ${created.vehicle.plate_number}, but ${photoFailures.join(
            " and "
          )} did not upload. Add it from the profile.`
        );
        resetForm();
        onCreated(created.vehicle);
        return;
      }
```

Check what `created.vehicle`'s id property is actually called — the existing code reads `created.application._id`, so `created.vehicle._id` is the likely match, but confirm against the `CreatedApplication` type rather than assuming.

- [ ] **Step 6: Clear the new state in `resetForm`**

In `resetForm()`, beside wherever `signatureFile` is cleared, add:

```tsx
    setVehiclePhoto(null);
    setOwnerPhoto(null);
```

- [ ] **Step 7: Build**

Run from `userpage`: `npm run build`

---

### Task 8: Seeds, harnesses, and a verification script

**Files:**
- Modify: `serverside/src/config/testSeed.ts:176,180`
- Modify: `serverside/src/config/verifyGates.ts` (lines 685, 694, 734, 781, 790)
- Modify: `serverside/src/config/verifyRoles.ts` (lines 1515, 1558, 1581, 1595, 1609, 1641, 1675, 1707, 1795, 1871, 1946, 2301, 2341)
- Create: `serverside/src/config/verifyVehicles.ts`
- Modify: `serverside/package.json`

**Interfaces:**
- Consumes: everything from Tasks 1-7.
- Produces: `npm run verify:vehicles`.

- [ ] **Step 1: Rename type literals in the seed and harnesses**

Across `testSeed.ts`, `verifyGates.ts`, and `verifyRoles.ts`, replace the type literals using the same mapping the migration uses: `'car'` → `'pickup'`, `'motorcycle'` stays, `'tricycle'` → `'motorcycle'`, `'other'` → `'van'`.

`testSeed.ts:176` also has an inline union type annotation — change it to import `VehicleType` from `'../constants/vehicleTypes'` and use that.

Prose in comments that says "Juan's motorcycle" is still accurate (motorcycle survives) and needs no edit.

- [ ] **Step 2: Find and rewrite the one-vehicle assertions**

Run from `serverside`:

```bash
grep -n "already has an active vehicle\|multiple_vehicles\|CONFLICT" src/config/verifyRoles.ts src/config/verifyGates.ts
```

Every assertion expecting a `CONFLICT` on a person's *second* active vehicle is now wrong — a second vehicle of a different type is legal, and a second of the same type is legal up to its limit. Rewrite each to register up to the type's limit and assert the rejection at limit+1.

Assertions on `multiple_vehicles` at the gate are still correct and must not be changed: the denial still fires, only its comment and its user-facing wording changed.

- [ ] **Step 3: Write the verification script**

Create `serverside/src/config/verifyVehicles.ts`. Model it on `verifySignatures.ts` — copy its `installVerifyBypass()` call, `expectEqual`, `summary`, `BASE`, `login`, and `TINY_PNG` verbatim; that file is the template. Then assert:

1. Register three vans for one owner: all three return 201.
2. Register a fourth van for that owner: 409 `CONFLICT`, and the message contains `"3 active vans"`.
3. Register a truck for the same owner: 201 — a different type has its own allowance.
4. Register a second truck: 409 `CONFLICT` (truck's limit is 1).
5. Deactivate one van via `PATCH /vehicles/:id/status`, then register another van: 201 — an inactive vehicle does not consume a slot.
6. `POST /vehicles/:id/photo` with `TINY_PNG`: 201, and the returned `photo_url` equals `/vehicles/<id>/photo`.
7. `GET /vehicles/:id/photo` with an `X-Gate-Key` header instead of a bearer token: 200 with `Content-Type: image/png`. **This is the check that catches the route-ordering mistake** described in Task 4 Step 6.
8. Upload a face photo for the owner, then tap that vehicle's own `rfid_uid` at a vehicle-entry gate: granted, and `person.photo_url` and `person.vehicle_photo_url` are both non-empty strings.
9. `POST /vehicles/:id/photo` with a text buffer instead of an image: 422 `VALIDATION_ERROR`.

- [ ] **Step 4: Register the script**

In `serverside/package.json`, add after `"verify:passback"`:

```json
    "verify:vehicles": "ts-node src/config/verifyVehicles.ts",
```

- [ ] **Step 5: Run it**

In one terminal, from `serverside`: `npm run seed:test`, then `npm run dev`.
In another, from `serverside`: `npm run verify:vehicles`

Expected: `All vehicle checks passed.`

- [ ] **Step 6: Final compile of both projects**

From `serverside`: `npm run build` — expected clean, including the harness files this time.
From `userpage`: `npm run build` — expected clean.

---

## Self-Review Notes

**Spec coverage:** Every section of `2026-08-05-vehicle-limits-and-photos-design.md` maps to a task — constants (1), migration (2), limits at all three call sites (3), photo storage and routes (4), scan response fields including the owner-photo bug (5), terminal display (6), form and frontend mirror (7), harnesses and verification (8).

**Known soft spots, flagged rather than guessed:** Task 7 Step 4 depends on whether the owner-search response carries `photo_url`, and Task 7 Step 5 on the exact id property of `created.vehicle`. Both steps say to check rather than assume, with a stated fallback. Task 2 Step 2 says to confirm the `env` export name against `config/env.ts`.

**Deferred by design:** editing vehicle photos outside the registration form, per-person-type limit variation, and backfilling photos for already-registered vehicles are all out of scope per the spec.
