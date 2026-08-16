# Registration Photos and Gate Terminals — Design

**Date:** 2026-07-27
**Status:** Approved, ready for planning
**Scope:** Two features that share one consumer. Depends on Subsystem A (role system), which is merged.
**Repos:** `serverside` (API, models, seed, harness), `userpage` (registration UI, gate terminal pages).

## Problem

Two gaps, related by a single screen.

Registration stores a photo only as a pasted URL (`components/PersonForm.tsx`, "Photo URL"
field). `Person.photo_url` exists in the model, but there is no way to upload an image, so
in practice records have no photo. The gadget registry spec named this gap explicitly and
put it out of its own scope: "Gadget photos beyond a `photo_url` string; there is no upload
pipeline."

Separately, there are four physical gates with four distinct purposes — person entry,
person exit, vehicle entry, vehicle exit — and no screen at any of them. A card tap produces
a database row nobody standing at the gate can see.

These meet at the terminal screen: the guard's job is to match the face on the screen to the
person in front of them. A gate terminal without photos is a turnstile light; with photos it
is an identity check. That shared consumer is why both are specified together.

## Decisions

| Question | Decision |
|---|---|
| How a tap reaches the page | The page **is** the terminal. A USB HID reader types the UID into a focused input; the page posts the tap and renders the response. No push channel. |
| Gate purpose | `Gate` gains `direction`. The four gates become the full entry/exit x person/vehicle matrix. |
| Tap payload | UID only. `gate_id` and `direction` are derived server-side from the device key. |
| Terminal identity | Per-gate device key in `X-Gate-Key`. Devices are not users; the role matrix stays at four. |
| Provisioning | A superadmin signs in on the terminal once, picks the gate, and the page stores the minted key in `localStorage`. |
| Photo storage | Separate `PersonPhoto` collection, served by `GET /persons/:id/photo`. Not embedded on `Person`. |
| Photo capture | File picker and webcam, both producing one downscaled JPEG blob. |
| Photo authorization | Fetched as a blob with a credential header. Never a public endpoint, never a signed query-string URL. |
| Gate/entity type match | A person card at a vehicle gate is **denied** with reason `wrong_gate_type`. New rule; see [Interaction with the gadget registry](#interaction-with-the-gadget-registry). |
| JWT taps | `POST /scan/tap` continues to accept a JWT alongside device keys, so `verify:roles` keeps working. |

## Architecture

```
[USB HID reader]  types "A1B2C3D4" + Enter
        |
        v
[Gate page]  POST /scan/tap
             X-Gate-Key: gk_live_...
             { rfid_uid: "A1B2C3D4" }
        |
        v
[Express]    authenticateGate -> req.gate
             gate_id   := req.gate._id          (from the key, unspoofable)
             direction := req.gate.direction    (from the gate record)
             scanService.tap(...)
        |
        v
[Gate page]  renders the decision for 5s, fetches the face via
             GET /persons/:id/photo with the same key, returns to READY
```

The terminal sends only the UID. Gate and direction are properties of the credential, so a
compromised or misconfigured page cannot record an entry at a gate it does not hold the key
for. This is the security payoff of pairing the device-key decision with the
`Gate.direction` decision.

## Data model

### `serverside/src/modules/gates/gates.model.ts` — modified

```ts
export interface IGate extends Document {
  _id: Types.ObjectId;
  name: string;
  type: 'person' | 'vehicle';
  direction: 'entry' | 'exit';   // new, required
  location: string;
}
```

The four gates after reseed:

| Name | type | direction |
|---|---|---|
| Main Entrance | person | entry |
| Side Gate | person | exit |
| Parking Entrance | vehicle | entry |
| Parking Exit | vehicle | exit |

This matches how the demo seed already behaves — `testSeed.ts` writes entry scans at Main
Entrance and exit scans at Side Gate — so existing seeded scan logs remain coherent under
the new field. No scan log is rewritten; `ScanLog.direction` stays as recorded.

Migration: `direction` is required, so existing gate documents need the field backfilled
before the stricter schema is used. The seed sets it by gate name, and gates are seeded
idempotently by name, so a re-run updates rather than duplicates.

### `serverside/src/modules/gates/gateKeys.model.ts` — new

```ts
export interface IGateKey extends Document {
  _id: Types.ObjectId;
  gate_id: Types.ObjectId;    // ref Gate
  key_hash: string;           // bcrypt, cost 12
  key_prefix: string;         // plaintext lookup handle, see format below
  is_active: boolean;
  last_used_at: Date | null;
  created_by: Types.ObjectId; // ref User (the provisioning superadmin)
  createdAt: Date;
}
```

Indexes: `key_prefix` unique, `gate_id` non-unique (history is retained), `is_active` for
filtering.

`key_prefix` exists because bcrypt hashes are not searchable. Without it, authenticating a
key would mean bcrypt-comparing it against every stored key on every tap.

Key format, fixed length so parsing is positional:

```
gk_live_a7f3c918d240e5b1...          (8 + 8 + 32 chars)
\______/\______/\_____________/
 fixed    prefix     secret
 "gk_live_"  8 hex    32 hex chars, CSPRNG
```

`key_prefix` stores the 8-character middle segment alone (`a7f3c918`), not the `gk_live_`
literal and not the secret. Authentication splits the presented key positionally, looks up the
record by that segment, then bcrypt-compares the **whole** presented string against
`key_hash`. The prefix is a lookup handle, never a credential: knowing it proves nothing
because the 32-char secret is what gets hashed.

The prefix is safe to display in an admin UI and to write to server logs.

Keys are never deleted. Revocation sets `is_active: false`, preserving which key a scan was
recorded under.

### `serverside/src/modules/persons/personPhotos.model.ts` — new

```ts
export interface IPersonPhoto extends Document {
  _id: Types.ObjectId;
  person_id: Types.ObjectId;  // ref Person, unique
  data: Buffer;
  mime: 'image/jpeg' | 'image/png' | 'image/webp';
  byte_size: number;
  updatedAt: Date;
}
```

A separate collection, not a field on `Person`. The admin directory and dashboard list people
in bulk; embedding image bytes would put every photo into every list response. `Person`
documents stay small and list endpoints are unaffected.

`person_id` is unique, so uploading a second photo replaces the first rather than
accumulating orphans.

## Endpoints

| Method | Path | Authorization |
|---|---|---|
| POST | `/persons/:id/photo` | registrar, superadmin |
| GET | `/persons/:id/photo` | any authenticated user **or** a valid gate key |
| DELETE | `/persons/:id/photo` | registrar, superadmin |
| POST | `/gates/:id/key` | superadmin |
| GET | `/gates` | any authenticated user (already exists; now returns `direction`) |
| POST | `/scan/tap` | valid gate key **or** JWT (unchanged for JWT callers) |

### `GET /persons/:id/photo` accepts a gate key

The terminal has no user session but is the primary consumer of photos. This endpoint
therefore accepts either credential. This cross-cutting requirement is the concrete reason
the two features share a spec: building them separately would produce a photo endpoint the
terminal cannot call.

Response: raw bytes, `Content-Type` from the stored whitelist value,
`X-Content-Type-Options: nosniff`, `Cache-Control: private, max-age=300`, and an `ETag`
derived from `updatedAt`. The endpoint honors `If-None-Match` with `304`, because a terminal
re-requests the same faces continuously.

`404` when the person has no stored photo. The terminal treats `404` as "no photo on file",
which is a display state, not an error.

### `POST /gates/:id/key` mints, it does not fetch

`key_hash` is bcrypt; no endpoint can return an existing key. Minting generates a new key,
returns the plaintext exactly once in the response body, and sets `is_active: false` on the
gate's previous keys.

Consequence, accepted deliberately: **one live terminal per gate.** Re-provisioning a gate
silently kills whatever terminal held the old key. That old terminal surfaces the condition
on its next tap (401 -> UNPROVISIONED), so the failure is visible rather than silent, but it
is a failure. Supporting several terminals per gate would mean not revoking on mint; it is
out of scope.

The plaintext key is never logged. Server logs record `key_prefix` only.

### `POST /scan/tap` credential resolution

```
if X-Gate-Key present:
    authenticate the key -> req.gate
    gate_id   := req.gate._id
    direction := req.gate.direction
    ignore any gate_id or direction in the body
else:
    existing authenticate + JWT path, body supplies gate_id and direction
```

A body-supplied `gate_id` on a key-authenticated request is ignored, not rejected — the
device is not trusted to name its own gate, and treating it as an error would give a caller a
way to probe for valid gate ids. `verify:gates` asserts the ignoring explicitly.

`scanLimiter` continues to apply. `SCAN_RATE_LIMIT_MAX=60` per minute is well above a human
tap rate and needs no change.

## Gate/entity type enforcement

`scanService.tap` currently resolves an RFID to a person or vehicle and never consults the
gate (`scan.service.ts`). With `Gate.type` now meaningful at the terminal, that becomes:

```
if entity_type !== gate.type:
    access_result := 'denied'
    reason        := 'wrong_gate_type'
```

So a person card cannot open the parking barrier, and a vehicle tag does not register
attendance at a walking gate. Attendance rollup is unaffected: it already runs only for
granted person taps, and a `wrong_gate_type` tap is not granted.

Existing seeded data remains valid — the demo seed already sends person scans to person
gates and vehicle scans to vehicle gates.

### Interaction with the gadget registry

The gadget registry spec (`2026-07-27-gadget-registry-design.md`) rules that "gadget taps
work at any gate." That directly contradicts the rule above once Subsystem B lands.

Resolution, recorded here so the contradiction is not discovered during implementation:
**gadgets are exempt from the gate-type check.** When gadget resolution is added to
`scanService.tap`, the check applies only when `entity_type` is `person` or `vehicle`. A
gadget tap is an ownership question, not an access question, and the gadget spec's "no
`Gate.type` change, no reseed" ruling is unaffected by this spec — that ruling concerned the
`type` field, which is unchanged; `direction` is additive.

## Frontend — gate terminals

Four routes in `userpage`, outside the `/admin` shell, with no nav and no sign-out control:

| Route | Gate | type | direction |
|---|---|---|---|
| `/gate/person-entry` | Main Entrance | person | entry |
| `/gate/person-exit` | Side Gate | person | exit |
| `/gate/vehicle-entry` | Parking Entrance | vehicle | entry |
| `/gate/vehicle-exit` | Parking Exit | vehicle | exit |

One `GateTerminal` component parameterized by the route. The route's pairing is a display and
provisioning hint only; the authoritative gate is whichever one the stored key belongs to.

### Terminal states

```
READY                          GRANTED                        DENIED
+----------------------+       +----------------------+       +----------------------+
|  MAIN ENTRANCE       |       |  ####################|       |  ####################|
|  Person - Entry      |       |  #     GRANTED      #|       |  #      DENIED      #|
|                      |       |  ####################|       |  ####################|
|      [ ((o)) ]       |       |   +--------+         |       |   +--------+         |
|                      |       |   | PHOTO  | Juan    |       |   |   ?    | Unknown |
|   Tap your card      |       |   |        | Dela Cr.|       |   |        | card    |
|                      |       |   +--------+ Student |       |   +--------+         |
|                      |       |   BSIT-4A   07:42:11 |       |   Unregistered UID   |
|  ------------------- |       |                      |       |   A1B2C3D4           |
|  ok  14:02  Maria S. |       |  next tap ready in 5 |       |  next tap ready in 5 |
+----------------------+       +----------------------+       +----------------------+
```

Green fills the screen for granted, red for denied, readable at a distance. A strip of the
last five scans sits at the bottom so a guard who looked away can confirm a tap registered.
The strip is in-memory only and clears on reload.

A granted scan with no photo shows a neutral placeholder and a small "no photo on file"
note. A missing photo must never resemble a denial, and must never be mistaken for a
verified face.

### Keyboard-wedge capture

USB RFID readers enumerate as HID keyboards: they type the UID and press Enter.

- A visually hidden `<input>` holds focus permanently. Any click, blur, or window refocus
  restores focus to it.
- `Enter` submits the buffered value; the buffer clears on submit.
- Taps arriving while a request is in flight are **ignored, not queued.** A queue would let a
  second person tailgate on a result the guard has already read.
- A UID not matching `^[0-9A-Fa-f]{6,32}$` is discarded client-side with no request, so stray
  keystrokes do not create log rows. This mirrors the hex constraint already enforced by
  `tapSchema`.

### Provisioning

```
UNPROVISIONED                  PROVISIONING                   PROVISIONED
"This terminal isn't set up"   superadmin signs in inline     normal READY screen
[ Set up this gate ]           -> confirms the gate           localStorage: gateKey
                               -> POST /gates/:id/key         survives reload and reboot
                               -> stores key, signs out
```

The provisioning sign-in uses the existing login call and discards the resulting session once
the key is stored; the terminal then operates purely as a device. A non-superadmin who signs
in during provisioning gets `403` from the mint endpoint and a clear message.

A `401` on any subsequent tap clears the stored key and returns the terminal to
UNPROVISIONED. A terminal that states why it stopped working beats one that silently stops
granting.

## Frontend — photo capture

`PhotoCapture.tsx`, one component with two tabs and one output (a `Blob`):

```
[ Upload ]  <input type="file" accept="image/jpeg,image/png,image/webp">
[ Camera ]  getUserMedia({ video: { facingMode: "user" } })
     |
     +--> both draw to one <canvas>
              cover-crop to 400x400, JPEG quality 0.82   (~40-80KB)
```

- The Camera tab is hidden when `navigator.mediaDevices` is unavailable, so a machine without
  a webcam degrades to the file picker rather than showing a broken tab.
- The camera stream is stopped on unmount and on tab switch. An unreleased camera indicator
  looks alarming at a registration desk.
- `getUserMedia` requires a secure context. `localhost` qualifies, so local development works;
  any non-localhost deployment needs HTTPS for the Camera tab. The Upload tab is unaffected.

### The `<img>` authentication constraint

`lib/auth.ts` authenticates with `Authorization: Bearer` from `localStorage`. A plain
`<img src>` cannot send headers, so `<img src="/persons/x/photo">` would arrive
unauthenticated.

Rejected: making the endpoint public (student faces served to anyone who guesses an
ObjectId) and signed query-string tokens (credentials leak into logs and browser history).

Adopted: an `AuthedImage` component that `fetch`es the bytes with whichever credential its
context holds, renders `URL.createObjectURL(blob)`, and revokes the object URL on unmount.
The gate terminal supplies `X-Gate-Key`; admin pages supply the Bearer token. One component,
both callers.

### `photo_url` compatibility

A successful upload sets `Person.photo_url = "/persons/<id>/photo"`. Records holding external
`https://` URLs keep working and nothing migrates. One helper decides rendering:

| `photo_url` value | Rendering |
|---|---|
| relative, `/persons/...` | `AuthedImage` against `API_BASE` |
| absolute `http(s)://` | plain `<img>`, no credential |
| empty or absent | initials placeholder |

This preserves CSV bulk import (`ImportPersons.tsx`), which may carry external URLs, and the
seeded people, who have no photos.

`DELETE /persons/:id/photo` removes the stored bytes and clears `photo_url` only when it
points at the internal route; an external URL is left intact.

## Upload validation

- `multer` memory storage with a **1MB hard cap**, against an expected payload of ~80KB. The
  cap rejects a bad client before anything reaches the database.
- **Magic-byte validation** in addition to the declared MIME: JPEG `FF D8 FF`, PNG
  `89 50 4E 47`, WebP `52 49 46 46` with `57 45 42 50` at offset 8. A client-declared
  `Content-Type` is not evidence of content.
- The stored `mime` comes from the detected bytes, not from the request header, and is
  restricted to the three whitelisted values.
- Responses carry `X-Content-Type-Options: nosniff`, so stored bytes can never be sniffed into
  an executable type.

Server-side re-encoding (via `sharp` or equivalent) would be stronger still, but it adds a
native dependency for marginal gain given the size cap and magic-byte check. Out of scope.

## Ordering and partial failure

A photo needs a `person_id`, so registration creates the person first, then posts the photo.
This leaves a real window: person created, photo upload fails.

The form does **not** roll back the person. It reports
`Registered <name> - photo didn't upload` with a **Retry photo** action. A person record
without a photo is usable; deleting a just-created person because of a flaky upload is worse,
and `id_number` is unique, so a rollback-then-retry cycle risks a spurious duplicate error.

Recovery is the **Retry photo** action on that panel, during the same registration. There is
no way to add or change a photo after leaving the form: editing a photo from the person
profile is out of scope, and no screen provides it. A registrar who dismisses the panel with
**Continue without it** leaves that person without a photo permanently, unless an
administrator uploads one out of band.

Consequently `DELETE /persons/:id/photo` has no client in this release. It exists so the
verification harness can restore state after uploading a test photo, and it is retained for
a future editing screen; it is deliberately not reachable from the UI.

## Error handling at the terminal

| Condition | Screen | Recovery |
|---|---|---|
| Unregistered UID | DENIED, red, shows the UID | auto-reset 5s |
| Inactive person or vehicle | DENIED, red, "ID inactive" | auto-reset 5s |
| Wrong gate type | DENIED, red, "wrong gate" | auto-reset 5s |
| Key revoked or unknown (401) | UNPROVISIONED setup screen | superadmin re-provisions |
| API unreachable | OFFLINE, amber, "not recording scans" | auto-retry, clears on success |
| Rate limited (429) | amber, "too many taps, wait" | auto-reset 5s |
| Server error (500) | amber, "system error" | auto-reset 5s |

Amber is a deliberate third color. Green and red mean the system decided; amber means it did
not. A guard must never read a network failure as a grant.

A granted scan whose photo fails to load still shows GRANTED with a placeholder. The access
decision is independent of image delivery.

## Testing

A `ts-node` harness following the established convention, no test framework:

```
npm run verify:gates
```

Assertions:

1. A valid gate key taps successfully; the log row records the key's gate and the gate's
   direction.
2. A body-supplied `gate_id` is ignored; the row records the key's gate.
3. A revoked key returns 401.
4. An unknown key returns 401.
5. Minting a key sets the gate's previous keys to `is_active: false`.
6. `POST /gates/:id/key` returns 403 for a registrar and 200 for a superadmin.
7. A person card at a vehicle gate is denied with reason `wrong_gate_type`.
8. An entry gate writes `time_in`; an exit gate writes `time_out`.
9. Photo upload rejects a non-image payload whose declared MIME is `image/jpeg`.
10. Photo upload rejects a payload over 1MB.
11. `GET /persons/:id/photo` succeeds with a gate key, succeeds with a JWT, and returns 401
    with neither.
12. Uploading a second photo for one person replaces rather than duplicates it; the unique
    `person_id` index holds and exactly one document remains.

Standards carried over from the Subsystem A retro, where each of these caught a real defect:

- Every assertion must be able to fail. An assertion that cannot fail is not a test.
- Assertions over collections need a length floor. `.every()` on an empty array is `true`,
  which produced two defects.
- Any assertion comparing two values must confirm both are present, rather than comparing
  `undefined` to `undefined`, which produced a third.
- The harness restores whatever it changes.
- Two consecutive runs produce byte-identical output.

`LOGIN_RATE_LIMIT_MAX` needs no change; this harness authenticates far less than
`verify:roles`. Tap volume stays well under `SCAN_RATE_LIMIT_MAX=60`.

## Seed

- All four gates gain `direction`, set by name, idempotently.
- `seed:test` mints one device key per gate and prints each plaintext once, so a developer can
  provision a terminal without going through the admin UI. Printing is gated to
  `NODE_ENV !== 'production'`.
- Two seeded people gain photos (a small generated placeholder image, not a real face), so the
  terminal has something to display and the photo endpoint has data on a fresh database.

## Out of scope

- Hardware readers that post scans themselves. The page is the terminal; a future ESP32 path
  would post to the same endpoint with the same key but is not built or specified here.
- Live push (SSE or WebSocket). Nothing needs it once the page owns the tap.
- Several terminals per gate. Minting revokes.
- Server-side image re-encoding, cropping UI, or face detection.
- Photos for vehicles or gadgets. `PersonPhoto` is keyed to `Person`.
- A key-management admin screen. Keys are minted during provisioning; revocation is minting a
  replacement.
- Backfilling photos for existing records beyond what the seed adds.
- Any change to the four-role matrix. Device keys are deliberately not a role.
