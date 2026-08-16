# shared_access_rfid

RFID shared-access system, combined into a single repository.

## Layout

| Folder | What it is |
| --- | --- |
| `serverside/` | Node/TypeScript API and gate service (Docker, Render). See `serverside/README.md`. |
| `userpage/` | Next.js member portal / admin UI (Vercel). See `userpage/README.md`. |

Each folder keeps its own `package.json` and is installed and run independently:

```bash
cd serverside && npm install
cd userpage   && npm install
```

## Environment

No real environment files are committed. Copy the templates and fill them in
locally:

- `serverside/.env.example` → `serverside/.env`
- `userpage/.env.production.example` → `userpage/.env.local`

## History

This repository was created by flattening two earlier repositories
(`rdif_serverside` and `ncst_rfid_access`) into one tree. Their full commit
history remains in those original repositories.
