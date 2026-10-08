import "dotenv/config";

function env(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

/**
 * WhatsApp connection settings can come from .env or be saved from the in-app
 * setup page (stored in the database). Saved values win over .env.
 */
const saved: Record<string, string> = {};

export function loadSavedSettings(values: Record<string, string>) {
  Object.assign(saved, values);
}

const pick = (key: string) => saved[key] || env(key);

export const config = {
  port: Number(env("PORT", "3000")),
  databasePath: env("DATABASE_PATH", "./data/whatsapp.db"),
  inboxPassword: env("INBOX_PASSWORD"),
  // Generated and saved on first boot when not set in the environment
  get sessionSecret() { return pick("SESSION_SECRET"); },
  // Set from the sign-in page on first run; INBOX_PASSWORD from the environment also works
  get teamPasswordHash() { return saved.TEAM_PASSWORD_HASH ?? ""; },
  // RESET_TEAM_PASSWORD=true lets the next visitor choose a new team password
  resetTeamPassword: /^(1|true|yes)$/i.test(env("RESET_TEAM_PASSWORD").trim()),
  // Render and Railway expose the public address of the service automatically
  publicUrl: (env("PUBLIC_URL") || env("RENDER_EXTERNAL_URL") || (env("RAILWAY_PUBLIC_DOMAIN") && `https://${env("RAILWAY_PUBLIC_DOMAIN")}`)).replace(/\/$/, ""),
  graphBase: `${env("GRAPH_API_BASE", "https://graph.facebook.com").replace(/\/$/, "")}/${env("GRAPH_API_VERSION", "v23.0")}`,
  get token() { return pick("WHATSAPP_TOKEN"); },
  get phoneNumberId() { return pick("WHATSAPP_PHONE_NUMBER_ID"); },
  get businessAccountId() { return pick("WHATSAPP_BUSINESS_ACCOUNT_ID"); },
  get appId() { return pick("WHATSAPP_APP_ID"); },
  get appSecret() { return pick("WHATSAPP_APP_SECRET"); },
  get verifyToken() { return pick("WEBHOOK_VERIFY_TOKEN"); },
};

/**
 * The team password can be chosen in the app until WhatsApp is connected, so
 * whoever deploys it never depends on getting an environment variable right.
 */
export function canChooseTeamPassword(): boolean {
  return config.resetTeamPassword || (!config.teamPasswordHash && !whatsappConnected());
}

export function whatsappConnected(): boolean {
  return Boolean(config.token && config.phoneNumberId);
}
