import { Router, type Request } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { config, whatsappConnected } from "./config.js";
import { applyStatus, getContact, insertMessage, upsertContact } from "./db.js";
import { broadcast } from "./events.js";

export const webhook = Router();

// Meta calls this once when you save the webhook URL in the dashboard.
webhook.get("/", (req, res) => {
  if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === config.verifyToken && config.verifyToken) {
    res.status(200).send(String(req.query["hub.challenge"] ?? ""));
  } else {
    res.sendStatus(403);
  }
});

function validSignature(req: Request & { rawBody?: Buffer }): boolean {
  if (!config.appSecret) return true; // signature check disabled when no app secret is configured
  const header = req.get("x-hub-signature-256") ?? "";
  const expected = "sha256=" + createHmac("sha256", config.appSecret).update(req.rawBody ?? Buffer.alloc(0)).digest("hex");
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Turns any inbound message type into a readable line for the inbox. */
function describe(msg: any): { body: string; mediaId: string | null } {
  switch (msg.type) {
    case "text":
      return { body: msg.text?.body ?? "", mediaId: null };
    case "image":
    case "video":
    case "document":
    case "audio":
    case "sticker": {
      const m = msg[msg.type] ?? {};
      return { body: m.caption ?? m.filename ?? "", mediaId: m.id ?? null };
    }
    case "location": {
      const l = msg.location ?? {};
      return { body: [l.name, l.address, `${l.latitude}, ${l.longitude}`].filter(Boolean).join(" · "), mediaId: null };
    }
    case "button":
      return { body: msg.button?.text ?? "", mediaId: null };
    case "interactive": {
      const i = msg.interactive ?? {};
      return { body: i.button_reply?.title ?? i.list_reply?.title ?? "", mediaId: null };
    }
    case "reaction":
      return { body: msg.reaction?.emoji ?? "", mediaId: null };
    case "contacts":
      return { body: (msg.contacts ?? []).map((c: any) => c.name?.formatted_name).join(", "), mediaId: null };
    default:
      return { body: `[${msg.type} message]`, mediaId: null };
  }
}

webhook.post("/", (req: Request & { rawBody?: Buffer }, res) => {
  if (!whatsappConnected() || !validSignature(req)) {
    res.sendStatus(401);
    return;
  }
  // Acknowledge fast; Meta retries deliveries that are not answered with 200.
  res.sendStatus(200);

  const body = req.body;
  if (body?.object !== "whatsapp_business_account") return;

  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== "messages") continue;
      const value = change.value ?? {};
      if (config.phoneNumberId && value.metadata?.phone_number_id && value.metadata.phone_number_id !== config.phoneNumberId) continue;

      const profiles = new Map<string, string>();
      for (const c of value.contacts ?? []) profiles.set(c.wa_id, c.profile?.name);

      for (const msg of value.messages ?? []) {
        upsertContact(msg.from, { profile_name: profiles.get(msg.from) });
        const { body: text, mediaId } = describe(msg);
        const saved = insertMessage({
          wa_message_id: msg.id,
          wa_id: msg.from,
          direction: "in",
          type: msg.type,
          body: text,
          media_id: mediaId,
          payload: msg,
          status: "received",
          error: null,
          sent_by: null,
          timestamp: Number(msg.timestamp) * 1000,
        });
        if (saved) broadcast("message", { message: saved, contact: getContact(msg.from) });
      }

      for (const st of value.statuses ?? []) {
        const err = st.errors?.[0];
        const updated = applyStatus(st.id, st.status, err ? `${err.title ?? "Error"}${err.error_data?.details ? `: ${err.error_data.details}` : ""} (${err.code})` : null);
        if (updated) broadcast("status", updated);
      }
    }
  }
});
