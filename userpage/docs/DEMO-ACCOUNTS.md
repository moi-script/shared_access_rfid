# Demonstration accounts and deployment values

> **Kept in this repository because it is private.** The API repo
> (`moi-script/rdif_serverside`) is public — nothing on this page belongs
> there. Its `DEPLOYMENT.md` covers the deployment procedure with placeholders
> and points here for the actual values.

## Database

MongoDB Atlas, cluster `cluster0.z3ss9wr.mongodb.net`, database `ncst_rfid`.

The full connection string, JWT secrets and cookie secret live in
`serverside/.env.production` on the deploying machine — gitignored, and the only
authoritative copy. Render holds the same values in the service's Environment
tab.

## Seeded accounts

Created by `npm run seed:test` (see the API repo's `DEPLOYMENT.md`) on
2026-08-07, and verified against the deployed configuration — all eight
authenticate and return the role below.

| Role | Username | Password |
|---|---|---|
| Superadmin | `testadmin` | `Admin@123` |
| Registrar | `testregistrar` | `Registrar@123` |
| HR | `testhr` | `Hr@12345` |
| OSS | `testoss` | `Oss@12345` |
| Student — Juan Dela Cruz | `2025-0001` | `Student@123` |
| Student — Maria Santos | `2025-0002` | `Student@123` |
| Student — Pedro Reyes | `2025-0003` | `Student@123` |
| Staff — Ana Villanueva | `EMP-1001` | `Staff@123` |

Student and staff logins use the ID number as the username, which is what the
"Student number" field on the login form submits. Office accounts (HR, OSS) have
no `person_id` — they are office logins, not people.

## Other seeded data

So the dashboards are populated rather than empty on first sign-in:

- 4 gates — Main Entrance (person/entry), Side Gate (person/exit),
  Parking Entrance (vehicle/entry), Parking Exit (vehicle/exit)
- 2 vehicles — `NCST-1234` (Juan Dela Cruz), `NCST-5678` (Ana Villanueva)
- 1 registered laptop — serial `5CD1234ABC` (Juan Dela Cruz)
- Placeholder ID photos for `2025-0001` and `EMP-1001`
- 27 attendance rows and 71 scan logs across the last 8 days, including two
  denied taps from unregistered cards for the admin feed
- One active device key per gate

Empty panels in the admin dashboard therefore mean the client is not reaching
the API — not that there is no data.

## Newly registered accounts differ from the seeded ones

Registering a person now creates their login in the same request, with
`must_change_password: true`, and the client enforces it — the first sign-in
lands on `/change-password` and cannot be navigated past.

The eight seeded accounts above are set to `false` by `testSeed.ts` and are
unaffected, so `testadmin` / `Admin@123` still goes straight to the console.
Anyone registered live during a demo will be asked to change their password
before they see anything.

## Gate device keys

Printed once at seed time and stored only as bcrypt hashes. The plaintext for
the current seed is in `serverside/.gate-keys.local.txt` (gitignored) — that is
the only copy, and it is deliberately not reproduced here.

Losing it is recoverable: sign in as superadmin and `POST /api/gates/:id/key`
to mint a replacement, which deactivates the previous key for that gate.

## Before this holds real student data

These are demonstration credentials with published passwords, on a system whose
public URL is known.

1. Delete the eight accounts above.
2. Rotate `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` and `COOKIE_SECRET` —
   rotating either JWT secret invalidates every issued token of that kind.
3. Rotate the Atlas database password and update `MONGODB_URI` in Render.
4. Narrow Atlas Network Access from `0.0.0.0/0` to the API host's egress IPs.
