# SWK Hub + SWK OS

One repository for everything **SWK Properties LLC** runs on:

- **SWK Hub** (`src/`, `public/`): the team workspace that replaces Slack, Monday, Airtable, Zapier, Salesforce/Bitrix24 and PropSpace.
- **SWK OS** (`os/`): the UAE real-estate ERP — accounting, VAT, transactions, escrow, leases, HR/WPS, compliance, DLD market data, document studio, AI employees. Imported from [swkpropertiesuae/swkos](https://github.com/swkpropertiesuae/swkos) at the commit in `os/UPSTREAM`; see `os/README.md` for its full feature list.

The two run side by side and are wired together: Hub pushes records into OS through the OS REST API, and OS streams signed events back into Hub channels and automations.

```
 SWK Hub :3000  ── os_create (Bearer API key) ──▶  SWK OS :8080
   chat, CRM, boards        ◀── signed webhooks /os/events ──   ERP, finance, DLD
```

| Replaces | In SWK Hub |
|---|---|
| Slack | Channels (public/private), DMs, threads, reactions, edit/delete, `*bold*` `` `code` `` @mentions, unread badges, live updates over WebSocket, search |
| Airtable | Bases: tables with typed fields (text, long text, number, select, date, person, email, phone, URL, checkbox), inline grid editing, CSV import/export |
| Monday | Boards: any table with a select field gets a drag-and-drop board view |
| Salesforce / Bitrix24 | CRM: Leads (stage pipeline, source, department, budget, owner, follow-up) and Deals (EOI → SPA/Form F → NOC/Ejari → Transfer → Closed) |
| Zapier | Automations: *when* record created / field changes / message contains keyword / webhook called / every N minutes → *do* post to channel, create record, update record, round-robin assign, send webhook. Run log per automation |
| PropSpace | Listings with Trakheesi permit, agent and status; Property Finder-style XML feed of published units for portal syndication; inbound lead webhooks for Bayut, Dubizzle, Property Finder and the website |
| Odoo / Zoho / QuickBooks | **SWK OS** (`os/`): ledger, invoices, VAT, escrow, leases, payroll/WPS, compliance, DLD |

Also in Hub:
- **Home dashboard**: what is due or overdue for you, your open items, a bar chart of every pipeline by stage with AED totals, recent activity.
- **Notifications**: @mentions (`@sara`, `@channel`), DMs, being made owner/agent of a record, comments on your records, follow-up reminders. Live bell and inbox.
- **Files**: attach or paste files in chat (images preview inline), `file` fields on records. Up to 25 MB; only images and PDFs open in the browser, everything else downloads.
- **Record comments & history** in every record, with @mentions.
- **Calendar view** for any table with a date field; **Only mine** filter; deep links to records (`#/t/<table>/<record>`).
- **Pinned messages**, **online presence** in DMs.
- Automation triggers: record added, field changed, **date field is today** (each morning, Dubai time), message keyword, webhook, schedule, **SWK OS event**. Actions: post message, create/update record, round-robin assign (keeps an existing owner), **notify a person**, webhook, **create a record in SWK OS**.

Ready on first boot: channels `#general #leads #offplan #secondary #leasing #swk-os`, the Leads, Deals, Listings and Marketing & Ops tables, a lead webhook, and these automations:
- **Lead router**: a new lead without an owner gets the next one round-robin and an alert in `#leads`.
- **Won lead → deal**: when a lead's stage becomes Won, a Deal is opened and `#general` hears about it.
- **Listing published**: when a listing goes live, `#secondary` is told.
- **Follow-up due today**: the lead owner is notified on the morning of `Next follow-up`.
- **SWK OS activity**: new OS leads, transactions, receipts and withdrawals are posted in `#swk-os`.
- **Qualified lead → SWK OS** (off until OS is connected): a qualified Hub lead is created in OS as a lead.

## Run

Needs Node 22.13+.

**Both together (recommended):**

```bash
npm install
```

```bash
npm run os:install
```

```bash
npm run os:build
```

```bash
HUB_ADMIN_EMAIL=you@swkpropertiesuae.com HUB_ADMIN_PASSWORD='a-long-password' npm run start:all
```

Hub opens on http://localhost:3000 and SWK OS on http://localhost:8080 (`npm run dev:all` runs OS with hot reload on :5173). SWK OS prints its own first-boot accounts; set them in `os/.env` (see `os/.env.example`). The OS → Hub webhook secret is generated once in `data/os-webhook-secret`.

**Hub only:** `HUB_ADMIN_EMAIL=… HUB_ADMIN_PASSWORD=… npm start`. Without a password, a random one is printed on first boot.

**Docker (both):** copy `.env.example` to `.env`, fill `HUB_ADMIN_PASSWORD` and `OS_WEBHOOK_SECRET`, create `os/.env` from `os/.env.example`, then:

```bash
docker compose up -d --build
```

**Tests:**

```bash
npm test
```

```bash
cd os && bash tests/run-all.sh
```

Put both behind HTTPS (Cloudflare, Caddy, nginx), forward WebSocket upgrades on Hub's `/ws`, and back up both data volumes.

## Connect Hub and SWK OS (once)

1. In SWK OS → Administration → **API keys**, create a key "SWK Hub" acting as an admin user. Give Hub `OS_API_KEY=<key>` and `OS_API_URL=<OS address>` (`OS_URL` is the address people open).
2. In SWK OS → Administration → **Webhooks**, add `<Hub address>/os/events`, events such as `leads.*,transactions.*,receipts.*`, and a signing secret. Give Hub the same `OS_WEBHOOK_SECRET`. When Hub runs on the same machine or docker network, OS trusts the exact `HUB_URL` origin even though it is a private address.
3. Restart Hub and turn on **Qualified lead → SWK OS** under Automations. Hub's **OS bridge** page shows each part of the link and the latest events.

## Connect things

**Leads in.** *Webhooks & feeds* shows each webhook URL. POST JSON; keys that match a field name or key are stored (`name`, `phone`, `source`, `budget`…), anything else is appended to the notes field. Point portal lead emails/parsers, the website form, Make/n8n or SWK OS at it.

**Listings out.** The same page shows the XML feed URL for each Listings table. Only records with Status = *Published* are included. Confirm field mapping with each portal before going live.

**SWK OS.** Use the *Create in SWK OS* action with any OS entity (`leads`, `contacts`, `viewings`, `tasks`…) and OS field keys, and the *SWK OS event* trigger for anything OS emits.

## Security notes

- Passwords are scrypt-hashed; sessions are HttpOnly, SameSite=Lax cookies; login is rate-limited per IP.
- Cookie-authenticated POSTs must be JSON or CSV, so other sites cannot forge them.
- Private channels and DMs are visible only to members. Tables are visible to every signed-in user.
- Only admins manage automations, webhooks, team and table deletion; automations can call outside URLs.
- Webhook and feed URLs carry secret tokens. Treat them like passwords; delete and recreate a webhook if one leaks.
- `/os/events` accepts only bodies signed with `OS_WEBHOOK_SECRET` (HMAC-SHA256, `x-swk-signature`). The OS API key acts as the OS user it was created for; keep it in the environment, never in the repo.
- Uploaded files need sign-in, are served with a sandbox CSP, and anything but images/PDF is forced to download.

## Not included yet

Single sign-on between Hub and OS (separate accounts today), voice/video calls, per-table permissions in Hub, phone push notifications, two-way portal APIs (Bayut/PF lead APIs need their partner credentials).

## Layout

```
src/server.js        Hub HTTP API, auth, WebSocket, files, dashboard, OS bridge
src/engine.js        records, messages, notifications, automation engine
src/db.js            SQLite schema and helpers
src/seed.js          first-boot workspace
public/              Hub web app (no build step)
test/                Hub API tests (node --test)
scripts/run-all.js   runs Hub + OS together
os/                  SWK OS (Fastify + React ERP), own package.json, tests and docs
docker-compose.yml   Hub + OS containers
```
