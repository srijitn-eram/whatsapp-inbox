/**
 * Local stand-in for graph.facebook.com so you can try the platform without a Meta account.
 * Run: npm run mock   then set GRAPH_API_BASE=http://localhost:4010 in .env
 * It also plays the customer: POST /simulate/inbound {from, name, text} sends a signed webhook to the app.
 */
import "dotenv/config";
import express from "express";
import { createHmac, randomUUID } from "node:crypto";

const PORT = Number(process.env.MOCK_PORT ?? 4010);
const APP_WEBHOOK = process.env.APP_WEBHOOK ?? "http://localhost:3000/webhook";
const APP_SECRET = process.env.WHATSAPP_APP_SECRET ?? "";
const PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID ?? "PHONE_ID";

const app = express();
app.use(express.json());

export const sent: any[] = [];

async function postWebhook(value: Record<string, unknown>) {
  const body = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{ id: "WABA", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { phone_number_id: PHONE_ID }, ...value } }] }],
  });
  const sig = "sha256=" + createHmac("sha256", APP_SECRET).update(body).digest("hex");
  await fetch(APP_WEBHOOK, { method: "POST", headers: { "Content-Type": "application/json", "X-Hub-Signature-256": sig }, body }).catch(() => {});
}

app.post("/simulate/inbound", async (req, res) => {
  const { from = "14155550123", name = "Test Customer", text = "Hi there!", image = false } = req.body ?? {};
  const id = `wamid.${randomUUID()}`;
  const message = image
    ? { from, id, timestamp: `${Math.floor(Date.now() / 1000)}`, type: "image", image: { id: `media-${id}`, mime_type: "image/jpeg", caption: text } }
    : { from, id, timestamp: `${Math.floor(Date.now() / 1000)}`, type: "text", text: { body: text } };
  await postWebhook({ contacts: [{ profile: { name }, wa_id: from }], messages: [message] });
  res.json({ id });
});

app.get("/simulate/sent", (_req, res) => res.json(sent));

// ---- Endpoints used by the in-app setup page ----
const MOCK_APP_ID = process.env.MOCK_APP_ID ?? "APP_ID";
export const subscriptions: any[] = [];

app.get("/:version/debug_token", (req, res) => {
  const [appId, secret] = String(req.query.access_token ?? "").split("|");
  if (appId !== MOCK_APP_ID || secret !== APP_SECRET) {
    res.status(400).json({ error: { message: "Error validating application. Invalid application ID or secret.", code: 101 } });
    return;
  }
  const valid = req.query.input_token === (process.env.MOCK_USER_TOKEN ?? "user-token");
  res.json({
    data: valid
      ? { app_id: MOCK_APP_ID, is_valid: true, expires_at: 0, granular_scopes: [{ scope: "whatsapp_business_messaging", target_ids: ["WABA_ID"] }, { scope: "whatsapp_business_management", target_ids: ["WABA_ID"] }] }
      : { is_valid: false, error: { message: "Invalid OAuth access token." } },
  });
});

app.get("/:version/:wabaId/phone_numbers", (_req, res) => {
  res.json({ data: [{ id: PHONE_ID, display_phone_number: "+1 555-010-0199", verified_name: "Demo Store" }] });
});

app.post("/:version/:appId/subscriptions", async (req, res) => {
  // Like Meta, verify the callback before accepting it
  const q = req.query as Record<string, string>;
  const challenge = String(Math.floor(Math.random() * 1e9));
  const target = process.env.MOCK_VERIFY_URL ?? q.callback_url;
  const echoed = await fetch(`${target}?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(q.verify_token)}&hub.challenge=${challenge}`)
    .then((r) => r.text())
    .catch(() => "");
  if (echoed !== challenge) {
    res.status(400).json({ error: { message: "The URL couldn't be validated. Callback verification failed.", code: 2200 } });
    return;
  }
  subscriptions.push(q);
  res.json({ success: true });
});

app.post("/:version/:wabaId/subscribed_apps", (_req, res) => res.json({ success: true }));

app.get("/simulate/subscriptions", (_req, res) => res.json(subscriptions));

app.post("/:version/:phoneId/messages", (req, res) => {
  if (req.body.status === "read") {
    res.json({ success: true });
    return;
  }
  if (String(req.body.to).startsWith("999")) {
    res.status(400).json({ error: { message: "Recipient phone number not in allowed list", code: 131030 } });
    return;
  }
  const id = `wamid.${randomUUID()}`;
  sent.push({ id, ...req.body });
  res.json({ messaging_product: "whatsapp", contacts: [{ input: req.body.to, wa_id: req.body.to }], messages: [{ id }] });
  // Simulate the delivery receipts Meta sends afterwards
  setTimeout(() => postWebhook({ statuses: [{ id, status: "delivered", timestamp: `${Math.floor(Date.now() / 1000)}`, recipient_id: req.body.to }] }), 300);
  setTimeout(() => postWebhook({ statuses: [{ id, status: "read", timestamp: `${Math.floor(Date.now() / 1000)}`, recipient_id: req.body.to }] }), 900);
});

app.get("/:version/:wabaId/message_templates", (_req, res) => {
  res.json({
    data: [
      {
        id: "1",
        name: "hello_world",
        language: "en_US",
        status: "APPROVED",
        category: "UTILITY",
        components: [
          { type: "HEADER", format: "TEXT", text: "Hello World" },
          { type: "BODY", text: "Welcome and congratulations!! This message demonstrates your ability to send a WhatsApp message notification from the Cloud API." },
        ],
      },
      {
        id: "2",
        name: "order_update",
        language: "en_US",
        status: "APPROVED",
        category: "UTILITY",
        components: [{ type: "BODY", text: "Hi {{1}}, your order {{2}} is on its way and should arrive by {{3}}." }],
      },
      { id: "3", name: "draft_promo", language: "en_US", status: "PENDING", category: "MARKETING", components: [{ type: "BODY", text: "Sale!" }] },
    ],
  });
});

app.get("/files/:id", (_req, res) => {
  res.type("image/svg+xml").send(`<svg xmlns="http://www.w3.org/2000/svg" width="240" height="160"><rect width="240" height="160" fill="#25d366"/><text x="120" y="88" font-size="20" text-anchor="middle" fill="#fff">sample photo</text></svg>`);
});

app.get("/:version/:mediaId", (req, res) => {
  if (req.params.mediaId === PHONE_ID) {
    res.json({ id: PHONE_ID, display_phone_number: "+1 555-010-0199", verified_name: "Demo Store", quality_rating: "GREEN" });
    return;
  }
  res.json({ url: `http://localhost:${PORT}/files/${req.params.mediaId}`, mime_type: "image/svg+xml" });
});



app.listen(PORT, () => console.log(`Mock Graph API on http://localhost:${PORT} -> webhooks to ${APP_WEBHOOK}`));
