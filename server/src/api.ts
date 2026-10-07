import { Router } from "express";
import { config, missingConfig, whatsappConnected } from "./config.js";
import { setup } from "./setup.js";
import { login, requireAuth } from "./auth.js";
import {
  deleteContact,
  getContact,
  insertMessage,
  listContacts,
  listMessages,
  markConversationRead,
  normalizeWaId,
  updateContact,
  updateOutgoing,
  upsertContact,
  db,
} from "./db.js";
import { addClient, broadcast } from "./events.js";
import { downloadMedia, GraphError, listTemplates, markRead, sendTemplate, sendText, type TemplateComponentParam } from "./whatsapp.js";

export const api = Router();

const SESSION_WINDOW_MS = 24 * 60 * 60 * 1000;

api.get("/health", (_req, res) => {
  res.json({ ok: true, missingConfig: missingConfig(), connected: whatsappConnected(), templatesEnabled: Boolean(config.businessAccountId) });
});

api.post("/login", (req, res) => {
  const { name, password } = req.body ?? {};
  if (!name?.trim()) {
    res.status(400).json({ error: "Enter your name" });
    return;
  }
  const token = login(String(name).trim(), String(password ?? ""));
  if (!token) {
    res.status(401).json({ error: "Wrong password" });
    return;
  }
  res.json({ token, name: String(name).trim() });
});

api.use(requireAuth);

api.get("/events", (_req, res) => addClient(res));

api.get("/me", (_req, res) => res.json(res.locals.user));

api.use("/setup", setup);

// ---- Contacts ----

api.get("/contacts", (req, res) => {
  res.json(listContacts(String(req.query.q ?? "")));
});

api.post("/contacts", (req, res) => {
  const waId = normalizeWaId(String(req.body?.wa_id ?? ""));
  if (waId.length < 8) {
    res.status(400).json({ error: "Enter the full number with country code, e.g. 14155550123" });
    return;
  }
  upsertContact(waId, { name: req.body?.name || undefined });
  const contact = updateContact(waId, { notes: req.body?.notes, tags: req.body?.tags });
  broadcast("contact", contact);
  res.status(201).json(contact);
});

api.patch("/contacts/:waId", (req, res) => {
  const { name, notes, tags, assigned_to } = req.body ?? {};
  const contact = updateContact(req.params.waId, { name, notes, tags, assigned_to });
  if (!contact) {
    res.sendStatus(404);
    return;
  }
  broadcast("contact", contact);
  res.json(contact);
});

api.delete("/contacts/:waId", (req, res) => {
  if (!deleteContact(req.params.waId)) {
    res.sendStatus(404);
    return;
  }
  broadcast("contact-deleted", { wa_id: req.params.waId });
  res.sendStatus(204);
});

// ---- Conversations ----

api.get("/contacts/:waId/messages", (req, res) => {
  const before = req.query.before ? Number(req.query.before) : undefined;
  res.json(listMessages(req.params.waId, before));
});

api.post("/contacts/:waId/read", async (req, res) => {
  const waId = req.params.waId;
  markConversationRead(waId);
  broadcast("contact", getContact(waId));
  res.sendStatus(204);
  // Send blue ticks for the latest inbound message (marks everything before it read too)
  const last = db
    .prepare(`SELECT wa_message_id FROM messages WHERE wa_id = ? AND direction = 'in' ORDER BY timestamp DESC LIMIT 1`)
    .get(waId) as { wa_message_id: string } | undefined;
  if (last?.wa_message_id) markRead(last.wa_message_id).catch((e) => console.warn("mark read failed:", e.message));
});

async function deliver(
  waId: string,
  sentBy: string,
  type: string,
  body: string,
  payload: unknown,
  sendFn: () => Promise<string>
) {
  const msg = insertMessage({
    wa_message_id: null,
    wa_id: waId,
    direction: "out",
    type,
    body,
    media_id: null,
    payload,
    status: "pending",
    error: null,
    sent_by: sentBy,
    timestamp: Date.now(),
  })!;
  broadcast("message", { message: msg, contact: getContact(waId) });
  try {
    const waMessageId = await sendFn();
    const updated = updateOutgoing(msg.id, { wa_message_id: waMessageId, status: "sent" });
    broadcast("status", updated);
    return updated;
  } catch (e) {
    const error = e instanceof GraphError ? e.message : "Could not reach WhatsApp";
    const updated = updateOutgoing(msg.id, { status: "failed", error });
    broadcast("status", updated);
    return updated;
  }
}

api.post("/contacts/:waId/messages", async (req, res) => {
  const waId = req.params.waId;
  const text = String(req.body?.text ?? "").trim();
  const contact = getContact(waId);
  if (!contact) {
    res.sendStatus(404);
    return;
  }
  if (!text) {
    res.status(400).json({ error: "Message is empty" });
    return;
  }
  if (!contact.last_inbound_at || Date.now() - contact.last_inbound_at > SESSION_WINDOW_MS) {
    res.status(409).json({
      error: "This customer hasn't messaged in the last 24 hours, so WhatsApp only allows an approved template. Use “Send template”.",
    });
    return;
  }
  const msg = await deliver(waId, res.locals.user.name, "text", text, { text }, () => sendText(waId, text));
  res.status(msg.status === "failed" ? 502 : 201).json(msg);
});

interface TemplateRequest {
  name: string;
  language: string;
  components?: TemplateComponentParam[];
  preview?: string;
}

function sendTemplateTo(waId: string, sentBy: string, t: TemplateRequest) {
  return deliver(waId, sentBy, "template", t.preview || `[Template: ${t.name}]`, t, () =>
    sendTemplate(waId, t.name, t.language, t.components ?? [])
  );
}

api.post("/contacts/:waId/template", async (req, res) => {
  const waId = req.params.waId;
  const t = req.body as TemplateRequest;
  if (!getContact(waId)) {
    res.sendStatus(404);
    return;
  }
  if (!t?.name || !t?.language) {
    res.status(400).json({ error: "Pick a template" });
    return;
  }
  const msg = await sendTemplateTo(waId, res.locals.user.name, t);
  res.status(msg.status === "failed" ? 502 : 201).json(msg);
});

// ---- Broadcasts: one template to many contacts ----

api.post("/broadcast", async (req, res) => {
  const { wa_ids, ...t } = req.body as TemplateRequest & { wa_ids: string[] };
  if (!Array.isArray(wa_ids) || wa_ids.length === 0 || !t.name || !t.language) {
    res.status(400).json({ error: "Pick a template and at least one contact" });
    return;
  }
  const results = [];
  for (const waId of wa_ids) {
    if (!getContact(waId)) continue;
    const msg = await sendTemplateTo(waId, res.locals.user.name, t);
    results.push({ wa_id: waId, status: msg.status, error: msg.error });
  }
  res.json({ sent: results.filter((r) => r.status !== "failed").length, failed: results.filter((r) => r.status === "failed").length, results });
});

// ---- Templates & media ----

api.get("/templates", async (_req, res) => {
  try {
    const templates = await listTemplates();
    res.json(templates.filter((t) => t.status === "APPROVED"));
  } catch (e) {
    res.status(502).json({ error: e instanceof Error ? e.message : "Could not load templates" });
  }
});

api.get("/media/:mediaId", async (req, res) => {
  try {
    const { contentType, data } = await downloadMedia(req.params.mediaId);
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "private, max-age=86400");
    res.send(Buffer.from(data));
  } catch (e) {
    res.status(502).json({ error: e instanceof Error ? e.message : "Could not load media" });
  }
});
