# Deployment — NCST RFID API

Two deployable applications:

| App | Repo / directory | Target | Runtime |
|---|---|---|---|
| API | this repo | Render (Web Service) | Node 22 / Express |
| Client | [`ncst_rfid_access`](https://github.com/moi-script/ncst_rfid_access) | Vercel | Next.js 16 |

Database: MongoDB Atlas.

> **This repository is public.** No connection string, secret or account
> password belongs in any file here. The real values live in `.env.production`
> (gitignored, on the deploying machine) and in the Render dashboard. The
> demonstration account credentials are documented in the private client repo,
> at `docs/DEMO-ACCOUNTS.md`.

---

## 1. Atlas

Network Access must allow the API host. Render does not publish a fixed egress
range on the free plan, so the practical setting is `0.0.0.0/0` (allow from
anywhere) with a strong database password — the connection is still
authenticated and TLS-encrypted. On a paid Render plan, replace this with the
static outbound IPs Render assigns and remove the open rule.

Verify connectivity with the URI you intend to deploy:

```bash
node -e "require('mongoose').connect(process.env.MONGODB_URI).then(()=>console.log('ok')).catch(e=>console.error(e.message))"
```

The connection string should carry `retryWrites=true&w=majority`. Both are
already the defaults in this stack, but stating them makes the durability
guarantee explicit: `w=majority` means a write is not acknowledged until a
majority of replica-set members hold it, so a primary that dies mid-write
cannot silently roll one back. That matters here because anti-passback
detection *is* the unique index on the occupancy collection — an occupancy row
that was acknowledged and then rolled back is exactly the state in which the
same card gets in twice.

## 2. API on Render

This repo ships `render.yaml` (a Blueprint) and a `Dockerfile`. Use one or the
other, not both.

### Blueprint (recommended)

1. Render dashboard → **New → Blueprint** → select this repo.
2. Render reads `render.yaml` and prompts for the values marked `sync: false`:
   `MONGODB_URI`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `COOKIE_SECRET`,
   `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `ALLOWED_ORIGINS`. Paste them from your
   local `.env.production`.
3. `ALLOWED_ORIGINS` is the only one you cannot fill in yet — it is the Vercel
   URL from step 3. Put a placeholder, deploy, then come back at step 4.
4. Health check is `GET /health`; Render restarts the service if it stops
   returning 200.

### If the build fails with hundreds of missing-type errors

```
error TS2591: Cannot find name 'process'
error TS7016: Could not find a declaration file for module 'express'
```

This is not broken source — it is an empty `node_modules/@types`. Render applies
the service's environment variables to the **build** as well as the runtime, and
`NODE_ENV=production` makes npm skip devDependencies, which is where every
`@types/*` package and TypeScript itself live. The `buildCommand` in
`render.yaml` therefore uses `npm ci --include=dev`, then prunes back to
production-only after `tsc` has run.

Reproduce it locally with `NODE_ENV=production npm ci` and check whether
`node_modules/@types` exists.

Generate fresh secrets with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

### Docker (alternative / VPS)

```bash
docker build -t ncst-rfid-api .
docker run -p 3000:3000 --env-file .env.production ncst-rfid-api
```

The image runs `node dist/server.js` directly rather than `npm start`, so
SIGTERM reaches the graceful-shutdown handler in `src/server.ts` instead of
being swallowed by npm.

### Free-plan caveat

Render's free tier suspends the service after ~15 minutes idle. The next
request takes **30–60 seconds** to wake it, which during a live demo looks
exactly like a broken login. Either warm it up beforehand, keep a tab polling
`/health`, or use a paid instance.

## 3. Client on Vercel

1. Vercel → **New Project** → import the client repo.
2. **Root Directory: `userpage`.** That repo has the app in a subdirectory;
   Vercel builds nothing useful without this.
3. Environment Variables (Production **and** Preview):

   ```
   NEXT_PUBLIC_API_BASE_URL = https://<your-render-service>.onrender.com/api
   ```

   Note the `/api` suffix and no trailing slash. `NEXT_PUBLIC_*` is inlined at
   **build** time, so changing it later requires a redeploy — editing the
   dashboard value alone does nothing to an already-built bundle. A build
   without it now fails loudly (see `resolveApiBase()` in the client's
   `lib/auth.ts`) rather than shipping a bundle that quietly points at
   `localhost`.
4. Deploy, then copy the resulting URL.

## 4. Close the loop: CORS + cookies

Back on Render, set:

```
ALLOWED_ORIGINS = https://<your-project>.vercel.app
```

Comma-separated for more than one, scheme included, **no trailing slash**. An
origin missing from this list receives no CORS headers and the browser blocks
every call from it. Vercel preview deployments each get their own subdomain, so
either list them explicitly or test previews against a separate API instance.

Redeploy the Render service (an env change triggers this automatically).

### Why the cookie settings matter

The client and the API are on **different sites** (`*.vercel.app` vs
`*.onrender.com`). A `SameSite=Strict` refresh cookie — the correct local
setting, and what this codebase used before — is dropped by the browser on
every cross-site request. Login would appear to work and the session would then
die silently at the first token refresh, 15 minutes later.

Production therefore sets:

```
COOKIE_SAMESITE=none
COOKIE_SECURE=true
```

Both are required together: browsers discard `SameSite=None` without `Secure`.
The server refuses to boot on that combination rather than ship a login that
drops its own session — see `src/config/env.ts`.

`TRUST_PROXY=1` exists for the same class of reason: behind Render's proxy,
Express otherwise reads the socket address for every request, sees only the
proxy, and the rate limiters throttle all users as a single bucket. It is a hop
count, never `true` — trusting the whole chain would let a client spoof its own
IP past the login limiter.

## 5. Verify the deployment

```bash
API=https://<your-render-service>.onrender.com

curl -s $API/health
# {"success":true,"data":{"status":"ok"}}

curl -si -X POST $API/api/auth/login \
  -H 'Content-Type: application/json' \
  -H "Origin: https://<your-project>.vercel.app" \
  -d '{"username":"<admin-username>","password":"<admin-password>"}' | head -20
```

Check that response for:

- `access-control-allow-origin` echoing your Vercel origin — if it is missing,
  `ALLOWED_ORIGINS` is wrong.
- `set-cookie: refreshToken=...; HttpOnly; Secure; SameSite=None` — if it says
  `SameSite=Strict`, `COOKIE_SAMESITE` did not take.
- `"role":"superadmin"` in the body.

Then in a browser: sign in at the Vercel URL and confirm the admin dashboard
loads populated. Empty panels mean the API is not being reached.

---

## Seeding

`npm run seed` creates the admin account from `ADMIN_USERNAME` /
`ADMIN_PASSWORD` plus the gates — run once.

`npm run seed:test` creates the demonstration accounts and a set of gates,
vehicles, photos, attendance rows and scan history so the dashboards are not
empty. It is **idempotent**: re-running skips anything that already exists.
`SEED_RESET=1` wipes and regenerates the demo scan/attendance history.

Credentials for those accounts are in the private client repo at
`docs/DEMO-ACCOUNTS.md`.

### Which script to run where

`ts-node` is a devDependency, so the TypeScript entry points — `npm run seed`,
`npm run seed:test` and every `verify:*` script — do **not** work on a host
installed with `--omit=dev`. Use the compiled equivalents:

| Situation | Command |
|---|---|
| Local development | `npm run seed:test` |
| From your machine against the deployed database, reading `.env.production` | `npm run build && npm run seed:test:atlas` |
| On a host that already has the production environment in `process.env` | `npm run build && npm run seed:test:prod` |
| Verify registration, logins and password changes (local, server running) | `npm run verify:registration` |

`seed:test:atlas` passes the env file as a dotenv preload argument rather than a
shell variable prefix, so it behaves the same in PowerShell and bash.

### Gate device keys

Device keys are printed once at seed time and stored only as bcrypt hashes —
they are not recoverable. To replace a lost key, sign in as superadmin and
`POST /api/gates/:id/key`, which mints a new key and deactivates the old one for
that gate.

The seed suppresses key printing entirely when `NODE_ENV=production`, so
re-seeding on the Render host destroys the new keys the moment they are created.
Mint keys through the API instead.

---

## Configuration reference

Everything below is validated at startup by `src/config/env.ts`; a bad value
stops the process rather than degrading silently.

| Variable | Production value | Why |
|---|---|---|
| `NODE_ENV` | `production` | Error responses stop leaking internals; the rate-limit bypass is refused outright. |
| `TRUST_PROXY` | `1` | One proxy hop (Render). At `0`, all clients share one rate-limit bucket. Never `true`. |
| `TZ` | `Asia/Manila` | Attendance dates, the occupancy reset and vehicle-pass expiry bucket in **local** time. A UTC host puts the 23:00 reset at 07:00 Manila, inside the arrival rush. |
| `COOKIE_SAMESITE` | `none` | Client and API are different sites. |
| `COOKIE_SECURE` | `true` | Required by `SameSite=None`; enforced at boot. |
| `ALLOWED_ORIGINS` | the client URL | Exact origin match; no wildcards. |
| `LOGIN_RATE_LIMIT_MAX` | `10` | The development value of 50 exists only so the `verify:*` harnesses can run back to back. |
| `VERIFY_BYPASS_TOKEN` | **unset** | `shouldBypassRateLimit()` refuses it under production anyway. Do not set it. |

## Post-deploy checklist

- [ ] Atlas Network Access allows the Render host
- [ ] Render env vars set, including the real `ALLOWED_ORIGINS`
- [ ] Vercel Root Directory is `userpage`
- [ ] `NEXT_PUBLIC_API_BASE_URL` set in Vercel and redeployed after any change
- [ ] `GET /health` returns 200 from the public URL
- [ ] Browser login succeeds and survives a page reload
- [ ] Admin dashboard shows seeded attendance/scan data
- [ ] `git status` lists neither `.env.production` nor `.gate-keys.local.txt`
- [ ] Demonstration accounts deleted and secrets rotated before the system
      holds real student data
