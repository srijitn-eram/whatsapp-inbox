import { Router, type Request } from "express";
import { config, whatsappConnected } from "./config.js";
import { saveSettings } from "./db.js";
import { discoverNumbers, getPhoneInfo, GraphError, subscribeWebhook } from "./whatsapp.js";

/** In-app "Connect WhatsApp" flow. Mounted behind sign-in. */
export const setup = Router();

function webhookUrl(req: Request) {
  const base = config.publicUrl || `${req.protocol}://${req.get("host")}`;
  return `${base}/webhook`;
}

const message = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong talking to Meta");

setup.get("/", async (req, res) => {
  let phone = null;
  let phoneError = null;
  if (whatsappConnected()) {
    try {
      phone = await getPhoneInfo();
    } catch (e) {
      phoneError = message(e);
    }
  }
  res.json({
    connected: whatsappConnected(),
    phone,
    phoneError,
    webhookUrl: webhookUrl(req),
    verifyToken: config.verifyToken,
    appId: config.appId,
    hasAppSecret: Boolean(config.appSecret),
  });
});

setup.post("/discover", async (req, res) => {
  const { token, appId, appSecret } = req.body ?? {};
  if (!token || !appId || !appSecret) {
    res.status(400).json({ error: "Fill in the access token, App ID and App secret." });
    return;
  }
  try {
    res.json(await discoverNumbers(String(token).trim(), String(appId).trim(), String(appSecret).trim()));
  } catch (e) {
    res.status(e instanceof GraphError && e.status < 500 ? 400 : 502).json({ error: message(e) });
  }
});

setup.post("/connect", async (req, res) => {
  const token = String(req.body?.token ?? "").trim();
  const appId = String(req.body?.appId ?? "").trim();
  const appSecret = String(req.body?.appSecret ?? "").trim();
  const phoneNumberId = String(req.body?.phoneNumberId ?? "").trim();
  const wabaId = String(req.body?.wabaId ?? "").trim();
  if (!token || !appId || !appSecret || !phoneNumberId || !wabaId) {
    res.status(400).json({ error: "Missing details; run the check again." });
    return;
  }

  saveSettings({
    WHATSAPP_TOKEN: token,
    WHATSAPP_APP_ID: appId,
    WHATSAPP_APP_SECRET: appSecret,
    WHATSAPP_PHONE_NUMBER_ID: phoneNumberId,
    WHATSAPP_BUSINESS_ACCOUNT_ID: wabaId,
  });

  const callbackUrl = webhookUrl(req);
  if (!callbackUrl.startsWith("https://")) {
    res.json({
      saved: true,
      webhook: false,
      webhookError: `Meta only sends messages to https addresses, and this app is running at ${callbackUrl}. Deploy it (or use a tunnel like ngrok) and press Connect again.`,
    });
    return;
  }
  try {
    await subscribeWebhook({ appId, appSecret, token, wabaId, callbackUrl, verifyToken: config.verifyToken });
    res.json({ saved: true, webhook: true, callbackUrl });
  } catch (e) {
    res.json({ saved: true, webhook: false, webhookError: message(e) });
  }
});
