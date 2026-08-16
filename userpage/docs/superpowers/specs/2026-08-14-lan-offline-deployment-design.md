# LAN / Offline Deployment — Design

**Date:** 2026-08-14
**Status:** approved design, pre-implementation
**Supersedes for this venue:** `docs/kiosk-cloudflare-deployment-workflow.md` (Raspberry Pi appliance). That document remains valid for a Pi-based training rig; this one covers the client's actual site — a lab of Windows desktops.

---

## 1. Problem

The system is currently deployed as three cloud services: `userpage` on Vercel, `serverside` on Render, MongoDB on Atlas. Every one of them is unreachable without an internet connection.

The client's site is a computer lab. One desktop runs **Veyon Master** and controls four lab PCs; separate desktops sit at each gate entrance with an RFID reader attached. The client wants the Veyon master desktop to be the "main PC" for the RFID system as well, and requires the whole thing to keep working with no internet.

### 1.1 The misconception this design corrects

The blocking belief was: *"a deployed web app needs the internet to be hosted, so it cannot work offline."*

This is false, and the distinction matters enough to state plainly. A web application needs a **server**, not the internet. HTTP is a protocol over TCP/IP; it is indifferent to whether the packets cross an ocean or a two-metre Ethernet cable. When a gate terminal requests `http://rfid.lab:5173`, the path is: gate PC → school switch → main PC. No router to the outside world, no public DNS, no Vercel, no Render, no Atlas. Physically disconnect the school's internet uplink and that request still completes, because nothing in the path ever left the building.

What "offline" breaks is the *cloud host*, not the *web*. The fix is therefore to move the same processes onto a machine on the LAN. **No application code is rewritten.** `npm run build && npm start` on a lab desktop runs the identical program Render was running.

### 1.2 Scope of "offline"

Confirmed with the client: **the LAN is up; the internet is down.** This is the only coherent reading, because Veyon Master is itself a LAN protocol (TCP 11100 to each client's Veyon Service). A genuinely isolated PC has no Veyon clients to manage and no gate terminals to hear from, so "no network at all" would make the client's own stated goal impossible. Every machine on site is powered 24/7.

---

## 2. Goals and non-goals

**Goals**

- The full RFID system — registration, gate scans, attendance, reporting — functions with the internet uplink physically disconnected.
- No new hardware. The lab's existing desktops are the infrastructure.
- No rewrite of application logic. Configuration and deployment change; `src/` does not.
- Veyon continues to operate exactly as it does today.

**Non-goals**

- **Veyon integration.** Veyon and the RFID system are *co-located*, not connected. They share a desk and a monitor, nothing else. A future "tap a card → Veyon unlocks that student's PC" feature via `veyon-cli` is a separate project and is explicitly out of scope here.
- **Cloud/LAN bidirectional sync.** See §8.2 for why this is rejected rather than deferred.
- **Remote access.** No Cloudflare Tunnel in this design. It can be added later without changing anything below, since `cloudflared` is outbound-only.

---

## 3. Rejected alternatives

### 3.1 Package the frontend as a desktop app (Electron / Tauri)

This was the client's proposal. It solves the wrong problem. Packaging changes *how the UI is delivered*, not *where the data lives* — an Electron app pointed at `onrender.com` is exactly as dead offline as Chrome pointed at `vercel.app`. An Electron app that *bundles* the API and MongoDB reaches the same end state as this design, after weeks of packaging work (native `bcrypt` bindings per-architecture, embedding and supervising `mongod`, an auto-update channel that itself needs the internet). The only thing it buys over the design below is an application icon.

**Rejected.** Higher cost, identical outcome.

### 3.2 Cloud primary, LAN fallback, sync on reconnect

Superficially attractive and genuinely dangerous here. The anti-passback guarantee *is* the unique index on the occupancy collection (`serverside/DEPLOYMENT.md`). Two writable masters diverging and merging later means the same card can legitimately be recorded entering twice, and no merge algorithm can determine which record is correct — the constraint that made the guarantee real only holds within one database. The system would appear to work and would silently lose exactly the property the thesis claims.

**Rejected.** If the client wants cloud reporting, push a periodic read-only snapshot to Atlas. One writer, always.

---

## 4. Role assignment

Two distinct roles were being conflated: *"the Veyon master desktop"* (controls lab PCs) and *"the RFID server"* (stores scans). They can share a machine; the question was whether they should. The objection was uptime — the RFID server must run whenever a gate is open, while a teacher's PC is off in the evening.

**That objection is resolved by site conditions: all machines are powered 24/7.** The client's stated preference is therefore adopted.

| Machine | Role | Runs |
| --- | --- | --- |
| Veyon master desktop | **main PC / RFID server** | `mongod`, `serverside`, `userpage`, Veyon Master |
| 4 lab PCs | Veyon clients | Veyon Service (unchanged) |
| Gate entrance desktops | gate terminals | browser in kiosk mode + reader bridge |
| Adviser laptop (optional) | viewer | browser |

If the 24/7 assumption ever fails, the migration is to move the three services to a gate terminal desktop and repoint one hostname. Nothing else changes — role assignment is an operations decision here, not an architectural one.

### 4.1 Topology

```
                    school switch  (internet uplink optional)
   ┌──────────────┬──────────────┬──────────────┬──────────────┐
   │              │              │              │              │
Veyon master   4 lab PCs     gate entry 1   gate entry 2   adviser
  desktop      (Veyon         desktop        desktop        laptop
 192.168.1.50  clients)       + reader       + reader
   │                              │              │              │
   │  Caddy        :443   ◄───────┴──────────────┴──────────────┘
   │    ├─ /     → userpage   :5173  (localhost only)
   │    └─ /api  → serverside :3000  (localhost only)
   │  mongod              :27017     (localhost only)
   │  Veyon Master ──── TCP 11100 ────► lab PCs
```

Only port 443 is reachable from the LAN. `mongod` and both Node apps bind loopback and are unreachable from any other machine.

Veyon's path and the RFID system's path never cross.

---

## 5. Decision log

| ID | Decision | Choice | Reasoning |
| --- | --- | --- | --- |
| L-1 | Database location | **Local `mongod` on the main PC** | Atlas is unreachable offline. Confirms D-1 of the kiosk doc. |
| L-2 | Which desktop hosts the server | **Veyon master desktop** | Client preference; the uptime objection is void at 24/7 power. |
| L-3 | Frontend production port | **5173**, backend keeps 3000 | Resolves D-2. See §6.1 — this is a real collision, not a preference. |
| L-4 | Server addressing | **Static IP + hosts-file name `rfid.lab`** | See §6.3. A name, not a bare IP, because the API origin is baked into the frontend at build time. |
| L-5 | Transport | **HTTPS via a local `mkcert` CA** | Keeps the auth cookie working under `NODE_ENV=production`, and keeps admin passwords off a shared network in clear text. See §6.4. |
| L-6 | Process supervision | **NSSM** wrapping both Node apps as Windows services | Survives reboot and logout with nobody logged in. |
| L-7 | Cookie policy | `COOKIE_SAMESITE=strict`, `COOKIE_SECURE=true` | Same-site under one hostname; `true` is correct *because* L-5 chose HTTPS. See §6.2. |
| L-8 | Backup | **Nightly `mongodump` to a second physical disk, weekly copy off-site** | A local database has no provider-managed replicas. See §7. |
| L-9 | Remote access | **None in this phase** | Can be added later without touching anything above. |
| L-10 | TLS termination | **Caddy reverse proxy on 443; single origin, no port numbers** | `next start` cannot serve HTTPS at all — Next.js supports TLS only in dev (`--experimental-https`) and expects a proxy in production. Terminating once in front of both apps is simpler than bolting a custom HTTPS server onto Next, and it collapses the deployment to one origin. See §6.5. |

---

## 6. Required changes

Four concrete issues stand between the current code and a working LAN deployment. All four were verified against the source; none are hypothetical.

### 6.1 Port collision — `userpage/package.json:11`

```json
"dev":   "next dev -p 5173",   // dev uses 5173
"start": "next start",         // production silently defaults to 3000
```

`serverside` also binds 3000. Development is fine; the *production* build collides and one of the two apps fails to start. This is exactly decision D-2 in `docs/kiosk-cloudflare-deployment-workflow.md`, still unresolved.

**Change:** `"start": "next start -p 5173"`.

### 6.2 The auth cookie is dropped over plain HTTP — `serverside/src/config/env.ts:103`

```ts
const cookieSecure = parsed.data.COOKIE_SECURE ?? isProd;
```

Under `NODE_ENV=production` the refresh cookie is issued with `Secure`. Browsers discard a `Secure` cookie arriving over plain `http://`. The symptom is subtle and would be miserable to debug live: **login appears to succeed, then `POST /auth/refresh` fails with "No refresh token" fifteen minutes later**, logging every user out mid-shift.

Two consistent configurations exist, and mixing them is what breaks:

| Transport | `COOKIE_SECURE` | Consequence |
| --- | --- | --- |
| `https://` via mkcert (**chosen**, L-5) | `true` | Correct. Credentials encrypted in transit. |
| `http://` plain | `false` (must be explicit) | Works, but passwords and JWTs cross the network in clear text (§6.4). |

`COOKIE_SAMESITE` stays `strict`: SameSite is evaluated per *site*, and both apps are served from `rfid.lab` — differing ports do not make them cross-site. The Vercel/Render split needed `none`; the LAN deployment does not.

### 6.3 The API origin is compiled into the frontend — `userpage/lib/auth.ts:20-30`

`NEXT_PUBLIC_*` variables are inlined into the JavaScript bundle at **build** time, not read at runtime. The file already documents this and throws on a production build with the variable unset — good, and it means the failure surfaces at build rather than in front of the client.

The operational consequence: **whatever address is set at build time is permanent until the frontend is rebuilt.** If a bare IP were baked in and the school later renumbered its network, recovery would require a rebuild on site.

**Therefore L-4 uses a name, not an address.** Build with:

```
NEXT_PUBLIC_API_BASE_URL=https://rfid.lab/api
```

No port: under L-10 the API is reached through the proxy on the default HTTPS port.

`rfid.lab` resolves through a one-line `hosts` file entry on each of the ~7 machines. A network renumber then means editing seven text files, not rebuilding and redeploying the application. The name also gives `mkcert` a stable subject to issue against.

### 6.4 Why HTTPS on a LAN at all

A LAN with no internet still needs HTTPS here, for two reasons — neither of which is the camera.

**1. Without it, `NODE_ENV=production` logs everyone out every 15 minutes.** This is §6.2 restated as a requirement rather than a bug: the refresh cookie carries `Secure`, browsers discard `Secure` cookies over plain HTTP, and the session dies at the first token refresh. The alternative is setting `COOKIE_SECURE=false` and accepting plain HTTP.

**2. Credentials would otherwise cross the school network in clear text.** Admin passwords go over the wire on every login, and JWTs on every request. A school LAN is a shared network with students on it; anyone able to see that traffic can read both. For a system whose subject *is* access control, transmitting the credentials that guard it unencrypted is a weakness a defence panel could reasonably raise.

**Photo capture is out of scope.** `PhotoCapture.tsx` defaults to `useState<Tab>("upload")` — file upload is the primary path and is what this deployment uses. The component also offers a live-camera tab, and `getUserMedia()` requires a secure context (HTTPS, or `localhost`), so on plain HTTP that tab would be unavailable on every machine except the server itself. Because the workflow is upload-only, this neither drives nor blocks the decision. If live capture is ever adopted, HTTPS is already in place and it will simply work.

A public certificate is impossible for a LAN name with no internet and no registered domain. Two offline-viable options were considered:

- **`mkcert`** — generates a local certificate authority; its root certificate is installed once into each of the seven machines' trust stores. `https://rfid.lab` then presents a genuinely valid certificate, offline, with no warnings. **Chosen (L-5).** It makes `COOKIE_SECURE=true` correct rather than a workaround, and documents cleanly as a methodology decision.
- **Plain HTTP with `COOKIE_SECURE=false`** — deletes this phase and the proxy with it. Genuinely simpler to build and explain, at the cost of clear-text credentials on a shared network. **Rejected** for reason 2 above, but it remains the correct fallback if certificate distribution proves impractical on site.

### 6.5 TLS termination — why a reverse proxy (L-10)

§6.4 requires HTTPS. The obvious implementation — configure each app to serve TLS — **is not available for the frontend.** Next.js supports HTTPS only in development (`next dev --experimental-https`); `next start` serves plain HTTP and Next's documented production posture is to sit behind a proxy. Reaching HTTPS otherwise would mean replacing `next start` with a hand-written custom server, which is more code to maintain than the proxy it replaces.

So TLS is terminated once, in front of both apps, by **Caddy** — a single static binary, no dependencies, one short config file, and it accepts the `mkcert` certificate directly:

```
rfid.lab {
    tls C:\rfid\certs\rfid.lab.pem C:\rfid\certs\rfid.lab-key.pem
    handle_path /api/* {
        reverse_proxy 127.0.0.1:3000
    }
    handle {
        reverse_proxy 127.0.0.1:5173
    }
}
```

This is not merely a workaround; it makes three earlier problems disappear:

- **One origin.** Everything is `https://rfid.lab`. The frontend and API are same-origin, so CORS stops being a failure mode rather than being carefully configured around it.
- **No port numbers anywhere.** Users type `https://rfid.lab`. The D-2 port collision (§6.1) still must be fixed, but ports become an internal detail invisible to every operator.
- **The cookie policy becomes trivially correct.** `SameSite=strict` under a single origin needs no reasoning about what counts as same-site.

Two consequences to carry forward: `TRUST_PROXY` becomes `1`, not `0` (§6.6) — there is now exactly one proxy, and leaving it at `0` makes every request appear to originate from `127.0.0.1`, collapsing all users into one rate-limit bucket. And both Node apps should bind loopback only, so the LAN's sole entry point is 443.

Caddy is supervised as a third Windows service alongside the two Node apps (L-6).

### 6.6 The LAN environment profile

`serverside/.env` on the main PC, diverging from `.env.example` as follows:

| Variable | Value | Why it changes |
| --- | --- | --- |
| `MONGODB_URI` | `mongodb://127.0.0.1:27017/ncst_rfid` | L-1. Atlas is gone. |
| `TRUST_PROXY` | `1` | Exactly one proxy (Caddy, L-10) sits in front. Left at `0`, every request appears to come from `127.0.0.1` and the rate limiters throttle all users as a single bucket. |
| `TZ` | `Asia/Manila` | Cloud hosts defaulted to UTC; a Windows desktop is already local, but setting it explicitly makes the attendance-date, occupancy-reset and pass-expiry boundaries independent of the machine's regional settings. |
| `ALLOWED_ORIGINS` | `https://rfid.lab` | Under L-10 the frontend and API share one origin, so this is same-origin and CORS is barely exercised. Keep it set and exact anyway — scheme, host and port are all compared. |
| `COOKIE_SECURE` | `true` | §6.2, consistent with L-5. |
| `COOKIE_SAMESITE` | `strict` | Same-site under one hostname. |
| `LOGIN_RATE_LIMIT_MAX` | `10` | Production value; the `.env.example` default of `50` exists for the `verify:*` harnesses. |
| `VERIFY_BYPASS_TOKEN` | **unset** | Inert under `NODE_ENV=production`, but must never be present on a production host regardless. |
| `NODE_ENV` | `production` | |

`userpage` needs `NEXT_PUBLIC_API_BASE_URL` at build time only (§6.3).

---

## 7. Operational concerns

**Supervision (L-6).** `npm start` in a terminal window dies when the window closes, when the user logs out, and does not return after a reboot. Both Node apps are wrapped as Windows services via NSSM; MongoDB registers its own service at install. Success criterion: power-cycle the main PC, log in to nothing, and the system is serving.

**Backup (L-8).** Atlas provided replication and snapshots; a local `mongod` provides neither. A single failed disk is total loss of the attendance record. Nightly `mongodump` to a second physical disk in the same machine via Task Scheduler, plus a weekly manual copy to external media kept elsewhere. A backup that has never been restored is not a backup — one restore is rehearsed during acceptance (§9).

**`OCCUPANCY_RESET_TIME` across a reboot.** The nightly cutoff after which a card still marked inside is treated as outside. The concern is whether a reboot spanning the cutoff causes it to be missed. This must be confirmed against the implementation during Phase 1 of the runbook: if the reset is evaluated lazily at scan time by comparing timestamps, a reboot is harmless; if it is driven by an in-process timer, a process that is down at 23:00 skips the reset entirely and the first morning tap is rejected as a duplicate entry. **`npm run rebuild:occupancy` exists as the recovery path**, but the failure mode should be understood rather than discovered.

**Clock.** Attendance bucketing, the occupancy reset and pass expiry are all local-time. With no internet there is no NTP, and desktop clocks drift. Either allow NTP through the firewall when the uplink is present, or point the machines at the school's domain controller if there is one.

---

## 8. Testing and acceptance

The single acceptance criterion the client cares about: **unplug the internet uplink and everything still works.** That test is run explicitly, not inferred.

1. Both production builds start on the main PC without a port conflict (§6.1).
2. From a gate terminal, log in and stay logged in past the 15-minute access-token expiry — proves the refresh cookie survives (§6.2).
3. Photo **upload** works from a gate terminal, not just the main PC — the registration path this deployment actually uses (§6.4).
4. A scan posted from a gate terminal appears in the main PC's dashboard.
5. Anti-passback still rejects a double entry, with the local database — the existing `npm run verify:passback` harness, pointed at the LAN instance.
6. **Physically unplug the WAN cable and repeat 2–5.**
7. Power-cycle the main PC; without logging in, confirm from a gate terminal that the system is serving.
8. Restore last night's `mongodump` into a scratch database and confirm the record count matches.

---

## 9. Risks

| Risk | Mitigation |
| --- | --- |
| Main PC disk failure loses all attendance data | L-8 backup; rehearsed restore |
| School IT renumbers the network | L-4 hostname indirection — edit 7 hosts files, no rebuild |
| mkcert root certificate expires or a PC is reimaged | Document the reinstall; keep the CA files with the backups |
| Clock drift with no NTP | §7 |
| Whoever inherits this does not know the services exist | The runbook is the deliverable; services named `NcstRfid*` for discoverability |

---

## 10. Follow-on work

- Companion runbook: `docs/lan-offline-deployment-runbook.md` — the step-by-step procedure.
- Implementation plan for the changes in §6.
- Optional later: Cloudflare Tunnel for the adviser; read-only Atlas snapshot; Veyon integration via `veyon-cli`.
