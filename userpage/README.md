# NCST Centralized RFID System — Access / Login

Sign-in front end for the **NCST Centralized RFID System**. One RFID card per person
works at every campus gate; this app is the credential login layer for the people who
manage and use that system.

Built with **Next.js 16 (App Router) · TypeScript · Tailwind CSS v4**.

## Screens

A single, split-screen login experience (navy brand panel + form card) in the NCST
palette — blue / white / gold-yellow / red.

| Route | Purpose |
| --- | --- |
| `/login` | Username and password; the server's role decides the destination |
| `/login/user`, `/login/admin` | Legacy deep links, redirect to `/login` |
| `/` | Redirects to `/login` |

Behaviour:

- One form for every role. The API returns the account's role on success and the
  client routes on it: superadmin and registrar to `/admin`, staff and students to
  `/dashboard`. There is no role picker, so nobody can choose the wrong one and
  the form never reveals which usernames are privileged.
- Responsive (brand panel collapses under `lg`), accessible (labelled inputs), and
  respects `prefers-reduced-motion`.

## Getting started

```bash
npm install
npm run dev        # http://localhost:3000  ->  redirects to /login
```

Other scripts: `npm run build`, `npm run start`, `npm run lint`.

## Project structure

```
app/
  layout.tsx              Fonts (Bricolage Grotesque + IBM Plex Sans/Mono) + metadata
  globals.css             Tailwind v4 theme tokens (NCST palette) + animations
  page.tsx                Redirects to /login
  login/page.tsx          Single login page
  login/user/page.tsx     Legacy deep link, redirects to /login
  login/admin/page.tsx    Legacy deep link, redirects to /login
  admin/page.tsx          Auth guard; hands off to AdminShell
  dashboard/page.tsx      Staff & student profile view
components/
  LoginExperience.tsx     Client component — form, validation, login request
  BrandPanel.tsx          Navy brand panel with animated RFID scan
  NcstMark.tsx            RFID / contactless logo glyph
  StudentsDirectory.tsx   Searchable person directory
  PersonProfile.tsx       One person's detail view
  PersonForm.tsx          Single-person registration form
  ImportPersons.tsx       CSV bulk import
  ProfileView.tsx         Own-profile panel for staff & students
  admin/
    AdminShell.tsx        Console shell — header, role-filtered nav, data fetch
    types.ts              Dashboard response types + shared formatters
    OverviewView.tsx      Stats, gate status, recent scans
    ParkingView.tsx       Vehicle gate activity
    RegisterView.tsx      Register a person, or bulk import
    AccountsView.tsx      Activate/deactivate, single and in bulk (superadmin)
lib/
  auth.ts                 Token storage, API helpers, Role type, redirectForRole
  permissions.ts          Role → capabilities and navigation (mirrors the server)
  csv.ts                  CSV parsing for bulk import
```

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

## Roles

Four login roles, enforced by the API and mirrored in `lib/permissions.ts` for
navigation only — the server is the security boundary.

| Role | Lands on | Can do |
| --- | --- | --- |
| `superadmin` | `/admin` | Everything, including activate/deactivate and bulk lockout |
| `registrar` | `/admin` | Register people and create their logins; browse the directory |
| `staff` | `/dashboard` | Own profile |
| `student` | `/dashboard` | Own profile |

Deactivating an account blocks the web login **and** refuses that person's RFID
card at every campus gate.
