# LAN / Offline Deployment — Step-by-Step Runbook

How to take the NCST RFID system off the cloud and run it entirely on the school's own LAN, with no internet.

**Design rationale:** `docs/superpowers/specs/2026-08-14-lan-offline-deployment-design.md`. Read that first if you want to know *why*. This document is the *how*.

**Status:** written from the source; not yet executed against the real lab. Verify each command on your own hardware before trusting it.

---

## Before you start

### What you are building

| Machine | IP | What it runs |
| --- | --- | --- |
| Veyon master desktop — **the main PC** | `192.168.1.50` (static) | MongoDB, the API, the web app, the Caddy proxy, Veyon Master |
| 4 lab PCs | DHCP | Veyon Service — **untouched by this procedure** |
| Gate entrance desktops | DHCP | Chrome in kiosk mode + the reader bridge |

### The one thing to understand first

**A web app does not need the internet. It needs a server.**

When a gate terminal opens `https://rfid.lab`, the request travels: gate PC → school switch → main PC. It never reaches a router to the outside world. Unplug the school's internet line and that request still completes, because nothing in its path ever left the building.

Everything below is just making one desktop play the part Render and Vercel were playing.

### Phases

Each phase ends in a checkpoint. **Do not start the next phase until the checkpoint passes** — every one of them is cheap to verify now and expensive to debug later.

| # | Phase | Where |
| --- | --- | --- |
| 1 | Code changes and a rehearsal on your own laptop | your dev machine |
| 2 | Network — static IP and the `rfid.lab` name | main PC + all clients |
| 3 | Certificates and the reverse proxy | main PC + all clients |
| 4 | Database — local MongoDB | main PC |
| 5 | Build and run the two apps | main PC |
| 6 | Windows services — survive a reboot | main PC |
| 7 | Gate terminals | each gate PC |
| 8 | Backups | main PC |
| 9 | Acceptance — pull the internet cable | everywhere |

---

## Phase 1 — Code changes and rehearsal

Do all of this on your development laptop. Goal: prove the production build works in the shape the lab will run it, before you are standing in the lab.

### 1.1 Fix the port collision

`userpage/package.json` line 11:

```json
"start": "next start",
```

`serverside` already uses port 3000, and bare `next start` defaults to 3000 too. Development works (`dev` specifies 5173); **production silently collides.** Change it to:

```json
"start": "next start -p 5173",
```

### 1.2 Confirm the occupancy reset survives a reboot

Open `serverside/src/` and find where `OCCUPANCY_RESET_TIME` is used. You are answering one question:

> Is the nightly reset evaluated **lazily**, by comparing timestamps when a scan arrives — or is it driven by an **in-process timer** that fires at 23:00?

- **Lazily** → a reboot is harmless. Note it and move on.
- **Timer** → a main PC that is rebooting at 23:00 skips the reset entirely, and the first person to tap in next morning is rejected as a duplicate entry. Write this down as a known operational hazard; `npm run rebuild:occupancy` is the recovery.

Do not skip this. It is five minutes now and a confusing morning-rush failure otherwise.

### 1.3 Rehearse both production builds

Two terminals on your laptop:

```bash
cd serverside && npm ci && npm run build && npm start
cd userpage   && npm ci && npm run build && npm start
```

**Checkpoint 1** — both processes are running simultaneously, one on 3000 and one on 5173, neither reporting `EADDRINUSE`. You can log in at `http://localhost:5173`.

---

## Phase 2 — Network

### 2.1 Give the main PC a static IP

By default the router hands out addresses at random (DHCP). The main PC could be `.50` today and `.77` after a reboot, and every gate terminal pointed at `.50` would break.

**Talk to whoever manages the school network before doing this.** Hard-coding an address on someone else's network can collide with a printer or a server, and they may prefer to do it themselves.

Two ways — either is fine:

**On the PC:** Settings → Network & Internet → Ethernet → IP assignment → **Edit** → **Manual** → IPv4 **On**:

| Field | Value |
| --- | --- |
| IP address | `192.168.1.50` |
| Subnet mask | `255.255.255.0` |
| Gateway | `192.168.1.1` (the router) |
| Preferred DNS | `192.168.1.1` |

Choose an address **outside the router's DHCP pool**, or the router may hand the same one to another machine.

**On the router (a "DHCP reservation"):** tell the router that the main PC's MAC address always receives `192.168.1.50`. Better when IT controls the router, because the record lives in one place.

Confirm:

```powershell
ipconfig | findstr IPv4
```

### 2.2 Give it a name — on every machine

The address is going to be **compiled into the web app** (Phase 5), so if you bake in a bare IP and the school ever renumbers its network, you would have to rebuild the app on site. A name avoids that: renumbering then means editing a few text files.

On **all** machines — the main PC, both gate terminals, the adviser's laptop — open Notepad **as Administrator** and edit:

```
C:\Windows\System32\drivers\etc\hosts
```

Add one line:

```
192.168.1.50    rfid.lab
```

Save. Then, from a **gate terminal**:

```powershell
ping rfid.lab
```

**Checkpoint 2** — `ping rfid.lab` from a gate terminal replies from `192.168.1.50`. If it does not, nothing in the later phases can work; fix it here.

---

## Phase 3 — Certificates and the reverse proxy

### Why this phase exists

Two reasons, and the first is subtle enough to waste a day:

1. **Users get logged out every 15 minutes.** Under `NODE_ENV=production` the refresh cookie is issued with the `Secure` flag (`serverside/src/config/env.ts:103`), and browsers discard a `Secure` cookie that arrives over plain HTTP. Login *appears* to work — the server returns 200 — then `POST /auth/refresh` starts failing with "No refresh token." Verified live on a laptop: the server emits `refreshToken=...; HttpOnly; Secure; SameSite=Strict` over a plain `http://` connection, which a browser throws away.
2. **Otherwise passwords cross the school network in clear text.** Every login sends an admin password over the wire, every request sends a JWT. A school LAN is shared with students. For a system whose whole subject is access control, sending the credentials that guard it unencrypted is hard to defend.

> **Not a reason: the camera.** `PhotoCapture.tsx` defaults to the **upload** tab, and upload is the workflow this deployment uses. The component's optional live-camera tab does need a secure context (`getUserMedia()` works only over HTTPS or on `localhost`), so on plain HTTP it would be unavailable away from the main PC — but since photos are uploaded rather than captured, that does not affect you. With HTTPS in place it would work anyway if you ever wanted it.

You cannot get a normal certificate for a LAN name with no internet and no registered domain. `mkcert` solves this by creating your own certificate authority.

**If certificate distribution proves impractical on site**, the documented fallback is plain HTTP with `COOKIE_SECURE=false` set explicitly in `.env`. That works and deletes this phase — you are trading away credential encryption, so make it a deliberate choice rather than an accident.

### 3.1 On the main PC

You need internet **once**, to download mkcert. After that it never needs it again.

```powershell
choco install mkcert     # or download the .exe from the mkcert releases page
mkcert -install          # creates your local CA and trusts it on THIS machine
mkcert rfid.lab 192.168.1.50 localhost
```

That produces two files — a certificate and a key. Keep them somewhere stable, e.g. `C:\rfid\certs\`.

### 3.2 Trust the CA on every other machine

Find the CA root certificate:

```powershell
mkcert -CAROOT
```

Copy `rootCA.pem` from that folder to each gate terminal and the adviser's laptop by **USB stick** — no internet required. On each machine: double-click → Install Certificate → **Local Machine** → Place all certificates in the following store → **Trusted Root Certification Authorities**.

> Store `rootCA.pem` and `rootCA-key.pem` with your backups. If a PC is reimaged you will need them again.

### 3.3 Put Caddy in front

**You cannot configure Next.js to serve HTTPS.** Next supports TLS only in development (`next dev --experimental-https`); `next start` serves plain HTTP and expects a proxy in front of it. So rather than trying to give each app a certificate, terminate HTTPS **once** in front of both.

This turns out to be simpler than the alternative, not harder. Everything ends up on **one address with no port numbers** — `https://rfid.lab` — which means the frontend and API are same-origin and CORS stops being something that can break.

Install Caddy (a single binary, no dependencies) and create `C:\rfid\Caddyfile`:

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

Adjust the two filenames to whatever `mkcert` actually produced in 3.1.

Run it in the foreground for now — Phase 6 makes it a service:

```powershell
caddy run --config C:\rfid\Caddyfile
```

> Because of this, the only port the LAN ever touches is **443**. Ports 3000 and 5173 stay on `127.0.0.1`, reachable only from the main PC itself.

**Checkpoint 3** — from a gate terminal, `https://rfid.lab` shows a padlock and **no certificate warning**. (Nothing is being served behind it yet; a 502 from Caddy is the expected and correct result at this point — you are testing the certificate, not the app.) A warning means the CA is not trusted on that machine; redo 3.2.

---

## Phase 4 — Database

Atlas is unreachable offline, so MongoDB runs on the main PC.

1. Download the **MongoDB Community Server** MSI. It registers itself as a Windows service, so it starts at boot with no further work.
2. Confirm it is listening:

   ```powershell
   Get-Service MongoDB
   ```

3. The connection string becomes:

   ```
   MONGODB_URI=mongodb://127.0.0.1:27017/ncst_rfid
   ```

**Checkpoint 4** — `Get-Service MongoDB` reports **Running**.

---

## Phase 5 — Build and run

### 5.1 Copy the code to the main PC

Put both projects under `C:\rfid\` — `C:\rfid\serverside` and `C:\rfid\userpage`.

Do **not** copy `node_modules` from your laptop. Run `npm ci` on the main PC itself; `bcrypt` has native bindings compiled for a specific machine.

### 5.2 Write `C:\rfid\serverside\.env`

Start from `.env.example` and change these. Each line is here for a reason — the reasons are in §6.5 of the design doc.

```ini
NODE_ENV=production
PORT=3000
API_PREFIX=/api

# Exactly one proxy in front (Caddy, Phase 3.3). Left at 0, every request
# looks like it comes from 127.0.0.1 and the rate limiters throttle all
# users as a single bucket.
TRUST_PROXY=1

# Attendance dates, occupancy reset and pass expiry are all local-time.
TZ=Asia/Manila

MONGODB_URI=mongodb://127.0.0.1:27017/ncst_rfid

# One origin for everything, thanks to the proxy — so this is same-origin
# and CORS is barely exercised. Keep it exact anyway: scheme, host and port
# are all compared against what the browser shows in the address bar.
ALLOWED_ORIGINS=https://rfid.lab

# Correct because Phase 3 gave us real HTTPS. Over plain http this must be
# false instead, or the refresh cookie is silently dropped.
COOKIE_SECURE=true
# Both apps are served from rfid.lab, so they are same-site. (The old
# Vercel + Render split needed 'none'; this deployment does not.)
COOKIE_SAMESITE=strict

# Production value. The 50 in .env.example exists for the verify:* harnesses.
LOGIN_RATE_LIMIT_MAX=10
```

Generate fresh secrets **on the main PC** — do not reuse the Render ones:

```powershell
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

for each of `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `COOKIE_SECRET`.

Leave `VERIFY_BYPASS_TOKEN` unset.

### 5.3 Build

```powershell
cd C:\rfid\serverside
npm ci
npm run build
npm run seed:prod          # creates the admin and the gates — run ONCE
```

The frontend needs its API address **at build time** — `NEXT_PUBLIC_*` values are compiled into the JavaScript bundle, not read when it runs (`userpage/lib/auth.ts:20-30`). Setting it afterwards does nothing.

```powershell
cd C:\rfid\userpage
npm ci
$env:NEXT_PUBLIC_API_BASE_URL = "https://rfid.lab/api"
npm run build
```

> If you ever change that address, you must **rebuild** the frontend. This is exactly why Phase 2.2 used a name instead of an IP.

### 5.4 Try it by hand first

Three terminals, before making anything a service:

```powershell
cd C:\rfid\serverside; npm start                  # 127.0.0.1:3000
cd C:\rfid\userpage;   npm start                  # 127.0.0.1:5173
caddy run --config C:\rfid\Caddyfile              # 0.0.0.0:443
```

**Checkpoint 5** — from a **gate terminal** (not the main PC), open `https://rfid.lab` and log in as admin. Note there is no port number — the proxy handles that.

---

## Phase 6 — Windows services

Right now the system dies when you close those terminal windows, and does not come back after a reboot. That is not deployable.

A **Windows service** is a program Windows starts at boot, before anyone logs in, and restarts if it crashes. Windows' built-in `sc create` only accepts real service executables, and a bare `node.exe` is not one — so use **NSSM**, a small free tool that wraps any program into a proper service.

```powershell
choco install nssm

nssm install NcstRfidApi "C:\Program Files\nodejs\node.exe" "C:\rfid\serverside\dist\server.js"
nssm set NcstRfidApi AppDirectory C:\rfid\serverside
nssm set NcstRfidApi AppStdout C:\rfid\logs\api.log
nssm set NcstRfidApi AppStderr C:\rfid\logs\api-error.log
nssm set NcstRfidApi Start SERVICE_AUTO_START

nssm install NcstRfidWeb "C:\Program Files\nodejs\npm.cmd" "start"
nssm set NcstRfidWeb AppDirectory C:\rfid\userpage
nssm set NcstRfidWeb AppStdout C:\rfid\logs\web.log
nssm set NcstRfidWeb AppStderr C:\rfid\logs\web-error.log
nssm set NcstRfidWeb Start SERVICE_AUTO_START

nssm install NcstRfidProxy "C:\rfid\caddy.exe" "run --config C:\rfid\Caddyfile"
nssm set NcstRfidProxy AppDirectory C:\rfid
nssm set NcstRfidProxy AppStdout C:\rfid\logs\proxy.log
nssm set NcstRfidProxy AppStderr C:\rfid\logs\proxy-error.log
nssm set NcstRfidProxy Start SERVICE_AUTO_START

nssm start NcstRfidApi
nssm start NcstRfidWeb
nssm start NcstRfidProxy
```

Create `C:\rfid\logs\` first. All three named `NcstRfid*` so whoever inherits this can find them together in `services.msc`.

Firewall — **only 443 is opened**, and only for the local network. Ports 3000 and 5173 stay bound to `127.0.0.1`, so nothing outside the main PC can reach the Node apps directly:

```powershell
New-NetFirewallRule -DisplayName "NCST RFID" -Direction Inbound -LocalPort 443 -Protocol TCP -Action Allow -Profile Private
```

**Checkpoint 6** — **reboot the main PC. Do not log in.** From a gate terminal, `https://rfid.lab` loads. This is the checkpoint that proves the deployment is real.

---

## Phase 7 — Gate terminals

On each gate entrance desktop:

1. Confirm the `hosts` entry from Phase 2.2 and the CA from Phase 3.2 are both in place.
2. Create a Chrome shortcut in kiosk mode:

   ```
   "C:\Program Files\Google\Chrome\Application\chrome.exe" --kiosk https://rfid.lab/...
   ```

   (Use whichever route the gate terminal should open.)
3. Put the shortcut in `shell:startup` so the terminal comes back on its own after a power cut.
4. Point the reader bridge at `https://rfid.lab/api/...`.

**Checkpoint 7** — tap a card at the gate; the scan appears on the main PC's dashboard.

---

## Phase 8 — Backups

Atlas gave you replicated storage and snapshots. A local `mongod` gives you neither: **one failed disk is the entire attendance record.**

Nightly dump to a *different physical disk* (not another partition on the same one):

```powershell
mongodump --uri="mongodb://127.0.0.1:27017/ncst_rfid" --out="D:\rfid-backups\%date%"
```

Register it in Task Scheduler to run daily, whether or not a user is logged on. Copy to external media weekly and keep it in a different room.

Also back up the mkcert CA files (`mkcert -CAROOT`) and `serverside\.env`.

**Checkpoint 8** — restore last night's dump into a scratch database and confirm the record count matches. *A backup you have never restored is not a backup.*

---

## Phase 9 — Acceptance

This is the test the client actually cares about. Run it in front of them.

1. **Physically unplug the internet uplink from the switch.**
2. Log in from a gate terminal. Leave the session idle **more than 15 minutes**, then click something — you must still be logged in. (This proves the refresh cookie survived; it is the exact thing Phase 3 exists to protect.)
3. Register a person **with a photo upload**, from a gate terminal — not the main PC. (Upload is the workflow in use; the live-camera tab is not part of this deployment.)
4. Tap a card at each gate; confirm both scans land.
5. Tap the same card twice at entry; confirm anti-passback rejects the second.
6. Run `npm run verify:passback` against the local database.
7. Power-cycle the main PC. Without logging in, confirm from a gate terminal that the system serves again.
8. **Reconnect the internet.** Confirm nothing changes — the system must not depend on it in either direction.
9. Confirm **Veyon Master still controls all four lab PCs.** Nothing in this procedure touched Veyon, and this step proves it.

---

## About Veyon

**Veyon is untouched by all of the above.** Nothing here installs over it, replaces it, reconfigures it, or competes with it.

| | Veyon | RFID system |
| --- | --- | --- |
| Talks to | the 4 lab PCs | the gate terminals |
| Port | TCP 11100 | 3000 / 5173 |
| Purpose | screen control, lock, demo | attendance, entry/exit logs |
| Needs internet | no | no (after this procedure) |

They share exactly one thing: **the same desktop and the same monitor.** The teacher has Veyon Master in one window and the RFID dashboard in a browser tab. That is the whole relationship — co-location, not integration.

Wiring them together — tap a card, Veyon unlocks that student's PC — is possible via `veyon-cli`, and would be a genuine contribution. It is a separate project and deliberately out of scope here.

---

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| `EADDRINUSE` on startup | Phase 1.1 not applied — both apps fighting over port 3000 |
| Logged out ~15 min after login | `COOKIE_SECURE` / transport mismatch — §6.2 of the design doc |
| Photo upload rejected or fails on gate PCs | Check the API is reachable and `ALLOWED_ORIGINS` matches — not a secure-context issue, uploads work over plain HTTP |
| Certificate warning on one machine only | CA not installed there — redo Phase 3.2 |
| CORS error in the browser console | `ALLOWED_ORIGINS` does not match the address bar exactly — scheme, host **and** port |
| Frontend still calling the old Render URL | `NEXT_PUBLIC_API_BASE_URL` was changed without rebuilding — redo Phase 5.3 |
| Everything dies when the terminal window closes | Phase 6 not done |
| Works on the main PC, unreachable from gate PCs | Firewall rules, or the `hosts` entry missing on that machine |
| All users rate-limited together | `TRUST_PROXY` not set to `1` — every request looks like it comes from the proxy |
| `502 Bad Gateway` from Caddy | One of the two Node services is down — check `C:\rfid\logs\` |
| First morning tap rejected as duplicate | Occupancy reset missed overnight — see Phase 1.2; recover with `npm run rebuild:occupancy` |
