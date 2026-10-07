# WhatsApp Team Inbox

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/srijitn-eram/whatsapp-inbox)

A self-hosted messaging platform on the official **WhatsApp Business Cloud API** (Meta). Your team signs in to one shared inbox and chats with customers from your business number.

**What it does**

- Shared inbox: every incoming WhatsApp message lands here live, with unread counts, browser notifications, and search by name, number or tag
- Replies with delivery ticks (sent, delivered, read) and the name of the teammate who sent each message
- Incoming photos, video, audio, documents, locations, button replies and reactions
- Contacts with names, tags, notes and "assign to me"
- Approved message templates with variable filling and a live preview, for starting conversations or reaching people outside the 24-hour window
- Broadcasts: send one template to many contacts at once, filtered by tag, with per-recipient results
- Enforces WhatsApp's 24-hour customer service window so the team can't send messages Meta would reject
- Webhook signature verification, duplicate-delivery protection, works on phones

**Stack:** Node.js 22.13+ / TypeScript / Express backend with SQLite (built into Node, nothing to install), React + Vite frontend.

---

## Set it up (about 15 minutes)

### Step 1: Put it online

The app has to live at a public https address so WhatsApp can deliver messages to it.

**Render (recommended):** press the **Deploy to Render** button at the top of this page (sign in to Render with GitHub and allow it to see this repo). Render reads `render.yaml`, asks you to choose a team password (`INBOX_PASSWORD`), and builds it. It uses the Starter plan (about $7/month plus $0.25/GB for the disk that keeps your messages; free Render instances wipe their disk on restart, so they lose your history).

**Anywhere else with Docker** (Railway, Fly.io, a VPS): build the included `Dockerfile`, mount a persistent volume at `/data`, and set `INBOX_PASSWORD` and `SESSION_SECRET` (`openssl rand -hex 32`). If the host doesn't tell the app its public address, also set `PUBLIC_URL=https://your-domain`.

### Step 2: Connect your WhatsApp number

Open your app's address, sign in with any name and the team password, and the **Connect WhatsApp** page walks you through it:

1. [Create a Meta app](https://developers.facebook.com/apps/creation/) of type **Business** and add the **WhatsApp** product. Meta gives you a free test number straight away; add your real business number under **WhatsApp › API Setup** when you're ready.
2. Copy the **App ID** and **App secret** from **App settings › Basic**.
3. Copy an access token. **WhatsApp › API Setup › Generate access token** works for a quick try but expires in 24 hours. For everyday use, create a permanent one in [Business settings › System users](https://business.facebook.com/settings/system-users): add a system user, assign it your app and WhatsApp account, and generate a token with `whatsapp_business_messaging` and `whatsapp_business_management`.
4. Paste the three values and press **Check**. The app finds your WhatsApp numbers, you pick one, and press **Connect**. It registers the webhook with Meta for you, so there's nothing to configure in the Meta dashboard.

Send a WhatsApp message to your number and it appears in the inbox. You can come back to this page any time from the ⚙ button.

With Meta's free test number you can only message up to 5 phone numbers you've added as recipients on the API Setup page; a real verified number has no such limit.

## Try it without a Meta account

A mock WhatsApp API is included so you can click around first:

```bash
npm run setup && npm run build
cd server
INBOX_PASSWORD=team SESSION_SECRET=dev GRAPH_API_BASE=http://localhost:4010 PUBLIC_URL=https://example.test npm start &
WHATSAPP_APP_SECRET=app-secret WHATSAPP_PHONE_NUMBER_ID=PHONE_ID MOCK_VERIFY_URL=http://localhost:3000/webhook npm run mock &
```

Open http://localhost:3000, sign in with password `team`, and on the Connect page enter App ID `APP_ID`, App secret `app-secret`, token `user-token`. Then make a pretend customer write in:

```bash
curl -X POST localhost:4010/simulate/inbound -H 'content-type: application/json' \
  -d '{"from":"14155550123","name":"Maria","text":"Hi! Where is my order?"}'
```

## Running it yourself

```bash
npm run setup && npm run build
INBOX_PASSWORD=... SESSION_SECRET=... npm start   # API, webhook and inbox on PORT (default 3000)
```

All settings can also go in `server/.env` (see `server/.env.example`); WhatsApp details entered on the Connect page are stored in the database and take priority. The database is a single SQLite file at `DATABASE_PATH`; back it up and keep it on a persistent disk.

For development with hot reload: `npm run dev` (inbox on http://localhost:5173, API on :3000).

## Tests

```bash
npm test
```

Runs the backend end to end against the mock API: the Connect WhatsApp flow, webhook verification and signatures, sign-in, inbound messages, replies and delivery receipts, the 24-hour window, templates, broadcasts, media and contacts.

## Project layout

```
server/src/
  index.ts        Express app, serves the built inbox
  webhook.ts      Meta webhook: verification, signature check, inbound messages, delivery statuses
  api.ts          REST API for the inbox (contacts, conversations, templates, broadcasts, media)
  whatsapp.ts     Cloud API client
  db.ts           SQLite schema and queries
  setup.ts        Connect WhatsApp page: token check, number discovery, automatic webhook registration
  auth.ts         Team sign-in (shared password + display name, signed session tokens)
  events.ts       Server-sent events for live updates
  mock-graph.ts   Fake WhatsApp API for local demos and tests
web/src/
  App.tsx         Sign-in, inbox, chat, contact panel
  Setup.tsx       Connect WhatsApp page
  TemplateDialog.tsx  Template sending and broadcasts
```

## Good to know

- **24-hour rule:** you can send free-form messages only within 24 hours of the customer's last message. Outside that window WhatsApp requires an approved template; the inbox switches the composer to "Send template" automatically.
- **Pricing:** Meta charges per template message (marketing, utility, authentication) by country; replies inside the 24-hour window are free. See [WhatsApp pricing](https://developers.facebook.com/docs/whatsapp/pricing).
- **Marketing broadcasts** need recipients' opt-in under WhatsApp policy.
- **Sign-in** is one shared team password; each person types their name, which is shown on messages they send. Swap `server/src/auth.ts` for per-user accounts or SSO if you need them.
