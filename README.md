# SWK Hub

In-house workspace for **SWK Properties LLC**: one self-hosted app that covers what the team used Slack, Monday, Airtable, Zapier, Salesforce/Bitrix24 and PropSpace for. It sits next to [SWK OS](https://github.com/swkpropertiesuae/swkos) (ERP, accounting, compliance) and talks to it through webhooks.

| Replaces | In SWK Hub |
|---|---|
| Slack | Channels (public/private), DMs, threads, reactions, edit/delete, `*bold*` `` `code` `` @mentions, unread badges, live updates over WebSocket, search |
| Airtable | Bases: tables with typed fields (text, long text, number, select, date, person, email, phone, URL, checkbox), inline grid editing, CSV import/export |
| Monday | Boards: any table with a select field gets a drag-and-drop board view |
| Salesforce / Bitrix24 | CRM: Leads (stage pipeline, source, department, budget, owner, follow-up) and Deals (EOI → SPA/Form F → NOC/Ejari → Transfer → Closed) |
| Zapier | Automations: *when* record created / field changes / message contains keyword / webhook called / every N minutes → *do* post to channel, create record, update record, round-robin assign, send webhook. Run log per automation |
| PropSpace | Listings with Trakheesi permit, agent and status; Property Finder-style XML feed of published units for portal syndication; inbound lead webhooks for Bayut, Dubizzle, Property Finder and the website |

Ready on first boot: channels `#general #leads #offplan #secondary #leasing`, the Leads, Deals, Listings and Marketing & Ops tables, a lead webhook, and three automations:
- **Lead router**: a new lead gets the next owner round-robin and an alert in `#leads`.
- **Won lead → deal**: when a lead's stage becomes Won, a Deal is opened and `#general` hears about it.
- **Listing published**: when a listing goes live, `#secondary` is told.

## Run

Needs Node 22.13+. One dependency (`ws`); the database is built-in SQLite.

```bash
npm install
```

```bash
ADMIN_EMAIL=you@swkpropertiesuae.com ADMIN_PASSWORD='a-long-password' npm start
```

Open http://localhost:8080. Without `ADMIN_PASSWORD`, a random one is printed on first boot. Add the team under **Team & audit**.

```bash
npm test
```

Docker:

```bash
docker build -t swk-hub . && docker run -p 8080:8080 -v swkhub:/data -e ADMIN_EMAIL=you@swkpropertiesuae.com -e ADMIN_PASSWORD='a-long-password' swk-hub
```

Put it behind HTTPS (Cloudflare, Caddy, nginx) and forward WebSocket upgrades on `/ws`. Back up the `/data` volume: it is the whole workspace.

## Connect things

**Leads in.** *Webhooks & feeds* shows each webhook URL. POST JSON; keys that match a field name or key are stored (`name`, `phone`, `source`, `budget`…), anything else is appended to the notes field. Point portal lead emails/parsers, the website form, Make/n8n or SWK OS at it.

**Listings out.** The same page shows the XML feed URL for each Listings table. Only records with Status = *Published* are included. Confirm field mapping with each portal before going live.

**SWK OS.** Add an automation step *webhook* with an SWK OS webhook URL to push leads or won deals across. SWK OS can post back into a Hub webhook to drop alerts into a channel.

## Security notes

- Passwords are scrypt-hashed; sessions are HttpOnly, SameSite=Lax cookies; login is rate-limited per IP.
- Cookie-authenticated POSTs must be JSON or CSV, so other sites cannot forge them.
- Private channels and DMs are visible only to members. Tables are visible to every signed-in user.
- Only admins manage automations, webhooks, team and table deletion; automations can call outside URLs.
- Webhook and feed URLs carry secret tokens. Treat them like passwords; delete and recreate a webhook if one leaks.

## Not included yet

File uploads in chat, voice/video calls, email sending, per-table permissions, mobile push notifications, two-way portal APIs (Bayut/PF lead APIs need their partner credentials).

## Layout

```
src/server.js   HTTP API, auth, WebSocket, static files
src/engine.js   records, messages, automation engine
src/db.js       SQLite schema and helpers
src/seed.js     first-boot workspace
public/         web app (no build step)
test/           API tests (node --test)
```
