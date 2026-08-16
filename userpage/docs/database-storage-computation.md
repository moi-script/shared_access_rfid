# Database Storage Computation — NCST RFID System

Storage sizing for the MongoDB database backing the NCST RFID access-control
system, derived from the Mongoose models in `serverside/src/modules/`.

**Date computed:** 2026-08-08
**Database:** MongoDB (Mongoose 8.5, WiredTiger storage engine)
**Population basis:** 10,000–20,000 students

---

## 1. Methodology

Document sizes are **exact BSON byte counts** of representative documents built
from each declared schema, not estimates. On top of the raw BSON:

| Factor | Value | Justification |
|---|---|---|
| Record overhead | +16 B/doc | WiredTiger per-record bookkeeping |
| Text compression | ×0.45 | Snappy (WiredTiger default) on short-string / ObjectId-dense BSON |
| Blob compression | ×1.00 | JPEG/PNG are already entropy-coded; Snappy yields no gain |
| Index entry | 34 B × 0.6 | Average key + RecordId + cell overhead, after B-tree prefix compression |

Index counts are taken from the actual `index: true`, `unique: true`, and
`schema.index()` declarations in each model file — not assumed.

### 1.1 A finding that drives the result

**Images are stored inside the database, not in object storage.** Five
collections persist `data: Buffer` directly:

- `PersonPhoto` (`persons/personPhotos.model.ts`)
- `PersonSignature` (`persons/personSignatures.model.ts`)
- `VehiclePhoto` (`vehicles/vehiclePhotos.model.ts`)
- `GadgetPhoto` (`gadgets/gadgetPhotos.model.ts`)
- `ApplicationSignature` (`vehicleApplications/applicationSignatures.model.ts`)

The `photo_url` / `signature_url` fields on `Person`, `Vehicle`, and `Gadget`
are API route paths, not external storage references. Binary data therefore
counts fully against the cluster's disk. It accounts for **54% of the total.**

### 1.2 Workload assumptions

| Parameter | Value | Source |
|---|---|---|
| School days per year | 200 | Academic calendar |
| Baseline taps per person per day | 2 | One entry, one exit |
| Scan log retention | 2 years | `scan.model.ts` — `expireAfterSeconds` TTL |
| Attendance retention | unbounded | No TTL declared; 4-year horizon used |
| Vehicle ownership rate | 15% | Assumption |
| Laptop registration rate | 40% of students | Assumption |
| Photo size (realistic) | 180 KB | Typical phone JPEG after client resize |
| Photo size (maximum) | 1,024 KB | `MAX_PHOTO_BYTES`, `middlewares/uploadImage.ts:5` |
| Signature size (realistic) | 15 KB | Trimmed transparent-background canvas PNG |
| Signature size (maximum) | 256 KB | `MAX_SIGNATURE_BYTES`, `middlewares/uploadImage.ts:8` |

---

## 2. Full database — 20,000 students + 1,000 staff (21,000 persons)

| Collection | Documents | B/doc | Data | Indexes | Total |
|---|---:|---:|---:|---:|---:|
| PersonPhoto | 21,000 | 184,434 | 3.61 GB | 837 KB | **3.61 GB** |
| ScanLog | 19,320,000 | 214 | 1.86 GB | 1.47 GB | **3.33 GB** |
| AttendanceSummary | 16,800,000 | 130 | 1.03 GB | 654 MB | **1.67 GB** |
| GadgetPhoto | 8,000 | 184,434 | 1.37 GB | 319 KB | **1.37 GB** |
| VehiclePhoto | 3,150 | 184,435 | 554 MB | 126 KB | **554 MB** |
| PersonSignature | 21,000 | 15,474 | 309 MB | 837 KB | **310 MB** |
| ApplicationSignature | 6,300 | 15,479 | 92.7 MB | 251 KB | **92.9 MB** |
| Person | 21,000 | 419 | 3.9 MB | 2.0 MB | 6.0 MB |
| User | 21,000 | 363 | 3.4 MB | 1.2 MB | 4.6 MB |
| VehicleApplication | 6,300 | 976 | 2.7 MB | 502 KB | 3.2 MB |
| Occupancy | 24,150 | 162 | 1.8 MB | 962 KB | 2.8 MB |
| Gadget | 8,000 | 270 | 1.0 MB | 638 KB | 1.6 MB |
| Vehicle | 3,150 | 328 | 476 KB | 314 KB | 790 KB |
| BlockedCard | 1,050 | 158 | 80 KB | 42 KB | 122 KB |
| GateKey | 16 | 229 | 1.7 KB | 1.3 KB | 3.0 KB |
| Gate | 8 | 129 | 0.5 KB | 0.3 KB | 0.8 KB |
| **TOTAL** | | | **8.82 GB** | **2.11 GB** | **10.93 GB** |

### Summary across both population scenarios

| Scenario | Persons | Realistic | Worst case¹ |
|---|---:|---:|---:|
| A | 10,500 | **5.47 GB** | 21.54 GB |
| B | 21,000 | **10.93 GB** | 43.08 GB |
| Per person | — | ~546 KB | ~2.1 MB |

¹ Worst case = every photo uploaded at `MAX_PHOTO_BYTES` (1 MB) and every
signature at `MAX_SIGNATURE_BYTES` (256 KB). Nothing in the upload pipeline
downsamples, so this is reachable, not hypothetical.

---

## 3. ScanLog — 15-day projection

### 3.1 Cost of a single scan record

`ScanLog` (`scan/scan.model.ts`) holds `rfid_uid`, two ObjectIds, three enum
strings, a Date, and two nullable references.

```
  214.0 B   exact BSON serialization
 + 16.0 B   WiredTiger record overhead
 --------
  230.0 B   raw
  × 0.45    Snappy compression
 --------
  103.5 B   data
 + 81.6 B   4 indexes: _id, rfid_uid, scan_time (TTL), {entity_type, entity_id}
 --------
  185.1 B   stored per scan record
```

Index overhead is **44% of every row.** At 214-byte documents the four indexes
cost nearly as much as the data they point at. This is inherent to the access
patterns the collection must serve and is not reducible without dropping an
index.

### 3.2 Activity profiles

Every tap writes a row — `scan.service` logs `denied` results as well as
`granted`, so a failed read that the student retries costs two rows. A **1.15×
retry multiplier** is applied throughout. Vehicle cards contribute a further
2 taps/day for the 15% of the population that owns one.

| Profile | Taps/person/day | Description |
|---|---:|---|
| Baseline | 2 | Enters in the morning, leaves in the afternoon |
| Active | 4 | Adds a lunch exit and re-entry |
| Very active | 6 | Adds movement between buildings during breaks |
| Heaviest | 8 | Near-continuous movement across campus |

### 3.3 Cumulative growth — 21,000 persons

| Day | Baseline (2/day) | Active (4/day) | Very active (6/day) | Heaviest (8/day) |
|---:|---:|---:|---:|---:|
| 1 | 9.8 MB | 18.3 MB | 26.9 MB | 35.4 MB |
| 2 | 19.6 MB | 36.7 MB | 53.7 MB | 70.8 MB |
| 3 | 29.4 MB | 55.0 MB | 80.6 MB | 106.2 MB |
| 4 | 39.2 MB | 73.3 MB | 107.4 MB | 141.5 MB |
| 5 | 49.0 MB | 91.7 MB | 134.3 MB | 176.9 MB |
| 7 | 68.6 MB | 128.3 MB | 188.0 MB | 247.7 MB |
| 10 | 98.1 MB | 183.3 MB | 268.6 MB | 353.8 MB |
| 12 | 117.7 MB | 220.0 MB | 322.3 MB | 424.6 MB |
| **15** | **147.1 MB** | **275.0 MB** | **402.9 MB** | **530.8 MB** |

Rows written per day: 55,545 / 103,845 / 152,145 / 200,445
Rows after 15 days: 833,175 / 1,557,675 / 2,282,175 / 3,006,675

### 3.4 Cumulative growth — 10,500 persons

| Day | Baseline (2/day) | Active (4/day) | Very active (6/day) | Heaviest (8/day) |
|---:|---:|---:|---:|---:|
| 1 | 4.9 MB | 9.2 MB | 13.4 MB | 17.7 MB |
| 2 | 9.8 MB | 18.3 MB | 26.9 MB | 35.4 MB |
| 3 | 14.7 MB | 27.5 MB | 40.3 MB | 53.1 MB |
| 4 | 19.6 MB | 36.7 MB | 53.7 MB | 70.8 MB |
| 5 | 24.5 MB | 45.8 MB | 67.1 MB | 88.5 MB |
| 7 | 34.3 MB | 64.2 MB | 94.0 MB | 123.8 MB |
| 10 | 49.0 MB | 91.7 MB | 134.3 MB | 176.9 MB |
| 12 | 58.8 MB | 110.0 MB | 161.1 MB | 212.3 MB |
| **15** | **73.5 MB** | **137.5 MB** | **201.4 MB** | **265.4 MB** |

Rows after 15 days: 416,580 / 778,830 / 1,141,095 / 1,503,330

### 3.5 The portable unit

The enrollment-independent figure, useful because it survives any headcount:

```
8 taps/day × 1.15 retry × 185.1 B = 1.70 KB per student per day
```

Multiply by student count and by days. At the baseline 2 taps/day it is
**0.43 KB per student per day**.

### 3.6 Interpretation

For the "most active students" case, the defensible answer is a **range**:
15 days of scan logging at 20,000 students falls between **275 MB and 531 MB**,
converging on roughly **400 MB** for a realistically busy campus.

The tap rate is the single variable that cannot be pinned down without a pilot
deployment, and it swings the result 3.6× across the table. Every other input —
the 185.1 B per row, the 44% index share, the 2-year TTL ceiling — is derived
from the schema and is firm.

Extrapolating the heaviest profile to the full TTL window (15 days is ~2% of
2 years) puts steady-state ScanLog near **4 GB**, at which point it overtakes
`PersonPhoto` as the largest collection in the database.

---

## 4. MongoDB Atlas tier matching

Pricing below is AWS `us-east-1` list price as of August 2026. Rates vary by
cloud provider and region; verify against the
[Atlas pricing calculator](https://www.mongodb.com/pricing/calculator) before
quoting figures in a defense.

### 4.1 Tier reference

| Tier | Storage | RAM | vCPU | Hourly | Monthly |
|---|---|---:|---:|---:|---:|
| M0 (Free) | 512 MB | shared | shared | $0 | **$0** |
| Flex | 5 GB | shared | shared | $0.011–$0.041 | **$8 – $30** |
| M10 | 10–128 GB | 2 GB | 2 | $0.08 | **~$57** |
| M20 | 20–256 GB | 4 GB | 2 | $0.20 | **~$144** |
| M30 | 40–512 GB | 8 GB | 2 | $0.54 | **~$389** |
| M40 | 80 GB–1 TB | 16 GB | 4 | $1.04 | **~$749** |
| M50 | 160 GB–4 TB | 32 GB | 8 | $2.00 | **~$1,440** |

Flex pricing is usage-scaled by operations per second: $8/mo at 0–100 ops/s,
rising through $15 / $21 / $26 to $30/mo at 400–500 ops/s.

Storage beyond a tier's included default is billed separately at roughly
**$0.10/GB/month** on AWS general-purpose SSD. Backup, data egress, and Atlas
Search are additional line items not included in the rates above.

### 4.2 Matching this system to a tier

| Deployment scenario | Required storage | Minimum tier | Monthly cost |
|---|---:|---|---:|
| ScanLog only, 15 days, 21k persons, heaviest | 531 MB | Flex | $8 – $30 |
| ScanLog only, 15 days, 10.5k persons, heaviest | 265 MB | M0 (Free) — *just fits* | $0 |
| Full DB, 10,500 persons, realistic | 5.47 GB | **M10** | ~$57 |
| Full DB, 21,000 persons, realistic | 10.93 GB | **M10** (at capacity) | ~$57 + ~$0.10/GB overage |
| Full DB, 21,000 persons, comfortable headroom | 10.93 GB | **M20** | ~$144 |
| Full DB, 21,000 persons, worst case | 43.08 GB | **M30** | ~$389 |
| Full DB, 21,000 persons, blobs externalized | 5.02 GB | **M10** or Flex (borderline) | $30 – $57 |

### 4.3 Tier notes

**M0 (Free, 512 MB) is not viable for production.** The full database exceeds
it by 21×. It holds only a 15-day ScanLog slice at the smaller population, and
even then the heaviest profile reaches 265 MB — half the tier — in 15 days.
It remains appropriate for development and thesis demonstration with seeded
data.

**Flex (5 GB, $8–$30) does not fit the full database** at either population.
It becomes viable only if the five binary collections move to object storage,
which drops the 21,000-person footprint to 5.02 GB — and that is still at the
ceiling with no room for `AttendanceSummary` growth.

**M10 (~$57/mo) is the realistic production floor.** Its 10 GB default storage
is marginally under the 10.93 GB requirement at 21,000 persons, so storage must
be expanded — the tier supports up to 128 GB. Note the 2 GB RAM: with 19.3M
ScanLog documents and 1.47 GB of ScanLog indexes alone, the working set will
not fit in RAM and query performance will depend on disk I/O.

**M20 (~$144/mo) is the defensible recommendation for 20,000 students.** 20 GB
default storage covers the 10.93 GB realistic footprint with headroom for
several years of unbounded `AttendanceSummary` growth, and 4 GB RAM keeps a
larger share of the hot index working set resident.

**M30 (~$389/mo) is only required if image uploads are left uncompressed** and
the worst case of 43 GB materializes. This cost is avoidable in software.

---

## 5. Growth behavior and recommendations

### 5.1 One collection is bounded, one is not

`ScanLog` carries a TTL — `scan_time` is indexed with
`expireAfterSeconds: 60 * 60 * 24 * 365 * 2` (`scan/scan.model.ts:23`). It
plateaus and stops growing.

`AttendanceSummary` has **no TTL and no cap.** At 21,000 persons it adds
**427 MB/year indefinitely**; by year 10 attendance data alone is 4.3 GB. This
is the collection that eventually forces a tier upgrade.

### 5.2 Actionable findings

1. **Resize photos client-side before upload.** The gap between the realistic




   180 KB and the permitted 1 MB is the difference between an 11 GB database
   and a 43 GB one — between an M20 at ~$144/mo and an M30 at ~$389/mo. This is
   the single highest-leverage change available.

2. **Move the five binary collections to object storage.** Doing so reduces the
   21,000-person footprint from 10.93 GB to 5.02 GB, a 54% reduction, and
   removes image data from the cluster's RAM working set entirely.

3. **Add a TTL or monthly rollup to `AttendanceSummary`.** Daily per-person
   rows are the correct write model but the wrong long-term storage model.
   Aggregating rows older than one academic year into monthly summaries
   compresses the aggregated portion by ~95%, cutting the collection as a whole
   from 1.67 GB to 491 MB — a 71% reduction over a 4-year horizon.

4. **Review the four ScanLog indexes against actual query patterns.** Each one
   costs 20.4 B per row — 394 MB per index at steady state. If any is unused,
   dropping it is free storage.

---

## 6. Post-optimization projection

This section projects the database if all four recommendations in Section 5.2
are applied. It uses the same per-document figures established in Section 1 —
only the document counts and collection membership change.

### 6.1 Note on overlap between recommendations 1 and 2

Recommendations #1 and #2 are **not additive against the database.** Once the
binary collections move to object storage (#2), the database no longer holds
image bytes at all, so resizing photos (#1) has no further effect on database
size. Its benefit relocates to the object-storage bill, plus upload latency and
client bandwidth.

The two must therefore be scored on different ledgers. Counting both against
the database would double-count roughly 2.6 GB of savings.

### 6.2 Resulting database — 21,000 persons

| Collection | Before | After | Change |
|---|---:|---:|---|
| PersonPhoto | 3.61 GB | — | relocated to object storage |
| GadgetPhoto | 1.37 GB | — | relocated to object storage |
| VehiclePhoto | 554 MB | — | relocated to object storage |
| PersonSignature | 310 MB | — | relocated to object storage |
| ApplicationSignature | 92.9 MB | — | relocated to object storage |
| AttendanceSummary | 1.67 GB | **491 MB** | −71% (rollup, #3) |
| ScanLog | 3.33 GB | **3.33 GB** | unchanged (TTL already caps it) |
| All other collections | 19.1 MB | 19.1 MB | unchanged |
| **DATABASE TOTAL** | **10.93 GB** | **3.83 GB** | **−65%** |

Applying #4 as well, assuming one of the four ScanLog indexes proves unused:
**3.46 GB** (−68%).

### 6.3 Resulting database — 10,500 persons

| Component | Before | After |
|---|---:|---:|
| ScanLog | 1.67 GB | 1.67 GB |
| AttendanceSummary | 853 MB | **245 MB** |
| All other collections | 13.5 MB | 13.5 MB |
| Binary collections | 2.95 GB | — |
| **DATABASE TOTAL** | **5.47 GB** | **1.92 GB** (−65%) |

With #4 applied: **1.73 GB**.

### 6.4 Object storage, and the cost of recommendation 1

Image data relocated out of the cluster, at 21,000 persons:

| Upload policy | Object storage | S3 Standard @ $0.023/GB/mo |
|---|---:|---:|
| Enforced resize to ~100 KB (#1 applied) | 3.27 GB | **$0.08/mo** |
| Current realistic behavior, 180 KB | 5.91 GB | $0.14/mo |
| No resize, uploads at `MAX_PHOTO_BYTES` | 38.06 GB | $0.88/mo |

Object storage is roughly two orders of magnitude cheaper per gigabyte than
Atlas cluster storage. Even the unresized worst case costs under a dollar a
month — which is precisely why recommendation #2 dominates #1 once both are on
the table.

### 6.5 Revised tier and cost

| | Before optimization | After optimization |
|---|---|---|
| Database size | 10.93 GB | **3.83 GB** |
| Worst case | 43.08 GB | **3.83 GB** |
| Minimum viable tier | M20 | **M10** |
| Monthly cost | ~$144 | **~$57 + ~$0.08 object storage** |

**Direct saving: ~$87/month, ~$1,044/year.** Measured against the unoptimized
worst case, ~$332/month.

Flex ($8–$30/mo, 5 GB) now fits on storage. It is not recommended: shared RAM
against 19.3 million ScanLog documents leaves the index working set unable to
stay resident, and query latency at the gate is the one thing this system
cannot trade away. **M10 is the defensible production floor after optimization.**

### 6.6 Two structural consequences

**Database size decouples from user behavior.** Before, the footprint depended
on what people uploaded — a campus submitting 1 MB photos produced a 43 GB
database and an M30 bill. After #2, the database is 3.83 GB regardless of upload
size. The realistic and worst-case columns converge. This is a more durable
argument for the change than the 65% figure, because it eliminates a variable
rather than shrinking one.

**ScanLog becomes 87% of the database,** up from 30%. Every subsequent capacity
question reduces to a ScanLog question, which makes the two-year TTL declared at
`scan/scan.model.ts:23` the single most load-bearing storage decision in the
system. Any proposal to extend that retention window should be costed against
Section 3's per-row figure of 185.1 B before it is accepted.

---

## Sources

- [MongoDB Pricing](https://www.mongodb.com/pricing)
- [Cluster Configuration Costs — Atlas Documentation](https://www.mongodb.com/docs/atlas/billing/cluster-configuration-costs/)
- [MongoDB Pricing Explained: A 2026 Guide to MongoDB Costs — CloudZero](https://www.cloudzero.com/blog/mongodb-pricing/)
- [MongoDB Atlas Pricing 2026 — Comparedge](https://comparedge.com/tools/mongodb-atlas/pricing)
