# Dependency Inventory

Every third-party package used by the NCST RFID system, what it does, and why it is there.

Covers both applications:

| App | Directory | Repository |
| --- | --- | --- |
| Backend API | `serverside` | [`rdif_serverside`](https://github.com/moi-script/rdif_serverside) |
| Frontend | `userpage` | [`ncst_rfid_access`](https://github.com/moi-script/ncst_rfid_access) |

Both require **Node.js ≥ 22** (`engines.node` in each `package.json`).

**Two columns, deliberately.** *Declared* is the range in `package.json`; *installed* is what `package-lock.json` actually resolved. They differ because `^` accepts newer minor and patch releases — `express` is declared `^4.19.2` but installed at `4.22.2`. The installed column is the one that describes what actually runs, and it is the one to cite in a thesis. Reproduce it exactly with `npm ci` (which obeys the lockfile); `npm install` may resolve newer versions and drift.

Generated 2026-08-14 from the committed lockfiles.

---

## Backend — `serverside`

### Runtime dependencies

| Package | Declared | Installed | Purpose |
| --- | --- | --- | --- |
| `express` | `^4.19.2` | 4.22.2 | HTTP server and routing. The whole API surface is built on it. |
| `mongoose` | `^8.5.0` | 8.24.1 | MongoDB object modelling — schemas, validation, and the **unique index that implements anti-passback**. |
| `jsonwebtoken` | `^9.0.2` | 9.0.3 | Signs and verifies the 15-minute access token and the 7-day refresh token. |
| `bcrypt` | `^5.1.1` | 5.1.1 | Password hashing. **Has native C++ bindings** — see the deployment note below. |
| `zod` | `^3.23.8` | 3.25.76 | Request-body validation at the API boundary, and validation of the environment itself (`src/config/env.ts`). |
| `helmet` | `^7.1.0` | 7.2.0 | Sets defensive HTTP response headers. |
| `cors` | `^2.8.5` | 2.8.6 | Cross-origin policy, driven by `ALLOWED_ORIGINS`. |
| `express-rate-limit` | `^7.4.0` | 7.5.1 | Throttles login and scan endpoints. Its correctness depends on `TRUST_PROXY` being set to match the actual number of proxies in front. |
| `cookie-parser` | `^1.4.6` | 1.4.7 | Reads the httpOnly refresh-token cookie. |
| `multer` | `^2.2.0` | 2.2.0 | `multipart/form-data` handling for photo uploads. |
| `morgan` | `^1.10.0` | 1.11.0 | HTTP request logging. |
| `dotenv` | `^16.4.5` | 16.6.1 | Loads `.env` into `process.env`. |

### Development dependencies

| Package | Declared | Installed | Purpose |
| --- | --- | --- | --- |
| `typescript` | `^5.5.0` | 5.9.3 | Compiles `src/` → `dist/`. |
| `ts-node` | `^10.9.2` | 10.9.2 | Runs `.ts` directly — used by every `seed:*`, `migrate:*` and `verify:*` script. |
| `ts-node-dev` | `^2.0.0` | 2.0.0 | Hot-reloading dev server (`npm run dev`). |
| `eslint` | `^8.57.0` | 8.57.1 | Linting. **Note: v8, while the frontend is on v9.** |
| `@typescript-eslint/parser` | `^7.16.0` | 7.18.0 | Lets ESLint read TypeScript. |
| `@typescript-eslint/eslint-plugin` | `^7.16.0` | 7.18.0 | TypeScript-specific lint rules. |
| `@types/node` | `^20.14.0` | 20.19.43 | Node type definitions. **Note: v20 types against a Node 22 runtime.** |
| `@types/express` | `^4.17.21` | 4.17.25 | Type definitions. |
| `@types/bcrypt` | `^5.0.2` | 5.0.2 | Type definitions. |
| `@types/jsonwebtoken` | `^9.0.6` | 9.0.10 | Type definitions. |
| `@types/cookie-parser` | `^1.4.7` | 1.4.10 | Type definitions. |
| `@types/cors` | `^2.8.17` | 2.8.19 | Type definitions. |
| `@types/morgan` | `^1.9.9` | 1.9.10 | Type definitions. |
| `@types/multer` | `^2.2.0` | 2.2.0 | Type definitions. |

---

## Frontend — `userpage`

The frontend is deliberately minimal — four runtime packages. There is no state-management library, no data-fetching library, no component framework, and no HTTP client: API calls go through the browser's built-in `fetch`, wrapped in `lib/auth.ts`.

### Runtime dependencies

| Package | Declared | Installed | Purpose |
| --- | --- | --- | --- |
| `next` | `16.2.10` | 16.2.10 | The application framework. **Pinned exactly, no `^`** — see the version warning below. |
| `react` | `19.2.4` | 19.2.4 | UI library. Pinned exactly. |
| `react-dom` | `19.2.4` | 19.2.4 | React's browser renderer. Pinned exactly. |
| `react-icons` | `^5.7.0` | 5.7.0 | Icon set. |

### Development dependencies

| Package | Declared | Installed | Purpose |
| --- | --- | --- | --- |
| `typescript` | `^5` | 5.9.3 | Type checking. |
| `tailwindcss` | `^4` | 4.3.2 | CSS framework. **v4** — configuration differs substantially from the v3 most documentation describes. |
| `@tailwindcss/postcss` | `^4` | 4.3.2 | Tailwind v4's PostCSS integration. |
| `eslint` | `^9` | 9.39.4 | Linting (flat config, `eslint.config.mjs`). |
| `eslint-config-next` | `16.2.10` | 16.2.10 | Next's lint rules. Pinned to match `next`. |
| `@types/node` | `^20` | 20.19.43 | Type definitions. |
| `@types/react` | `^19` | 19.2.17 | Type definitions. |
| `@types/react-dom` | `^19` | 19.2.3 | Type definitions. |

---

## Notes that affect deployment

### `bcrypt` has native bindings

`bcrypt` compiles C++ against the specific platform and CPU architecture it is installed on. Consequences:

- **Never copy `node_modules` between machines.** Copying from a Windows laptop to the lab PC, or to an ARM device, produces a module that fails to load at runtime rather than at install time.
- Always run `npm ci` **on the target machine**.
- On a build host where `NODE_ENV=production`, npm skips `devDependencies` — which is where TypeScript and every `@types/*` package live, so `tsc` then fails with hundreds of spurious type errors. `serverside/render.yaml` works around this with `npm ci --include=dev`, then prunes. This is documented in `serverside/DEPLOYMENT.md`.

### Next.js 16 is not the Next.js most documentation describes

`userpage/AGENTS.md` states this plainly:

> This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code.

The offline docs shipped inside `node_modules/next/dist/docs/` are the authority for this project, not tutorials found online. The exact pins on `next`, `react`, `react-dom` and `eslint-config-next` are intentional — do not relax them to `^` without deliberately re-testing.

### `next start` cannot serve HTTPS

Next supports TLS only in development (`next dev --experimental-https`). In production it expects a reverse proxy in front. This is why the offline deployment terminates TLS in Caddy rather than in the app — see `docs/lan-offline-deployment-runbook.md`, Phase 3.

### Port collision in the production build

`userpage`'s `dev` script specifies port 5173, but `start` does not and therefore defaults to **3000** — which `serverside` already uses. Development works; the production build collides. Tracked as decision D-2 in `docs/kiosk-cloudflare-deployment-workflow.md`.

### Two ESLint major versions

The backend is on ESLint 8 (legacy `.eslintrc`-style config, invoked as `eslint src --ext .ts`) and the frontend on ESLint 9 (flat config, `eslint.config.mjs`). They are separate installs in separate projects, so they do not conflict — but the two `lint` scripts are not interchangeable and a shared config cannot be introduced without migrating the backend first.

### `@types/node` v20 against a Node 22 runtime

Both projects declare `engines.node >= 22` but install `@types/node` v20. Node 22 APIs added after the v20 typings will not type-check. Harmless today; worth knowing if a newer built-in is ever reached for.

---

## Reproducing an exact install

```bash
cd serverside && npm ci
cd userpage   && npm ci
```

`npm ci` installs precisely what the lockfile records and fails if `package.json` and the lockfile disagree. Use it everywhere except when deliberately adding or upgrading a package. `npm install` may quietly resolve newer versions and make the installed column above wrong.

Regenerate this document's version data with:

```bash
node -e "const l=require('./package-lock.json'),p=require('./package.json');for(const s of ['dependencies','devDependencies'])for(const k of Object.keys(p[s]))console.log(k,p[s][k],l.packages['node_modules/'+k]?.version)"
```
