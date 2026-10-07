import { config } from "./config.js";

/** Thin client for the WhatsApp Business Cloud API (Graph API). */

export class GraphError extends Error {
  constructor(message: string, public status: number, public code?: number) {
    super(message);
  }
}

async function graph<T>(path: string, init: RequestInit & { token?: string } = {}): Promise<T> {
  const { token, ...rest } = init;
  const res = await fetch(`${config.graphBase}/${path}`, {
    ...rest,
    headers: { Authorization: `Bearer ${token ?? config.token}`, "Content-Type": "application/json", ...rest.headers },
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = data?.error;
    const detail = err?.error_data?.details ? ` (${err.error_data.details})` : "";
    throw new GraphError(`${err?.message ?? res.statusText}${detail}`, res.status, err?.code);
  }
  return data as T;
}

interface SendResponse {
  messages: { id: string }[];
}

function send(body: Record<string, unknown>) {
  return graph<SendResponse>(`${config.phoneNumberId}/messages`, {
    method: "POST",
    body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", ...body }),
  }).then((r) => r.messages[0].id);
}

export function sendText(to: string, body: string) {
  return send({ to, type: "text", text: { preview_url: true, body } });
}

export interface TemplateComponentParam {
  type: "header" | "body" | "button";
  sub_type?: string;
  index?: number;
  parameters: { type: "text"; text: string }[];
}

export function sendTemplate(to: string, name: string, language: string, components: TemplateComponentParam[] = []) {
  return send({ to, type: "template", template: { name, language: { code: language }, components } });
}

export function markRead(messageId: string) {
  return graph(`${config.phoneNumberId}/messages`, {
    method: "POST",
    body: JSON.stringify({ messaging_product: "whatsapp", status: "read", message_id: messageId }),
  });
}

export interface Template {
  id: string;
  name: string;
  language: string;
  status: string;
  category: string;
  components: { type: string; format?: string; text?: string; buttons?: unknown[] }[];
}

export async function listTemplates(): Promise<Template[]> {
  if (!config.businessAccountId) return [];
  const out: Template[] = [];
  let path: string | null = `${config.businessAccountId}/message_templates?fields=id,name,language,status,category,components&limit=100`;
  while (path) {
    const page: { data: Template[]; paging?: { next?: string } } = await graph(path);
    out.push(...page.data);
    // paging.next is an absolute URL; strip the base so graph() can reuse it
    path = page.paging?.next ? page.paging.next.replace(/^https?:\/\/[^/]+\/v[\d.]+\//, "") : null;
  }
  return out;
}

/** Downloads incoming media (two-step: resolve URL, then fetch with the token). */
export async function downloadMedia(mediaId: string): Promise<{ contentType: string; data: ArrayBuffer }> {
  const meta = await graph<{ url: string; mime_type: string }>(mediaId);
  const res = await fetch(meta.url, { headers: { Authorization: `Bearer ${config.token}` } });
  if (!res.ok) throw new GraphError(`Media download failed: ${res.statusText}`, res.status);
  return { contentType: meta.mime_type, data: await res.arrayBuffer() };
}

// ---- Setup helpers: used by the in-app "Connect WhatsApp" page ----

export interface PhoneOption {
  id: string;
  display_phone_number: string;
  verified_name: string;
  waba_id: string;
}

/**
 * Checks a token with Meta and finds every WhatsApp number it can use,
 * so the user doesn't have to copy IDs from the dashboard.
 */
export async function discoverNumbers(token: string, appId: string, appSecret: string) {
  const appToken = `${appId}|${appSecret}`;
  const debug = await graph<{ data: any }>(
    `debug_token?input_token=${encodeURIComponent(token)}&access_token=${encodeURIComponent(appToken)}`,
    { token: appToken }
  );
  const d = debug.data ?? {};
  if (!d.is_valid) throw new GraphError(d.error?.message ?? "This access token isn't valid.", 400);
  if (String(d.app_id) !== String(appId)) throw new GraphError("This access token belongs to a different Meta app than the App ID you entered.", 400);
  const wabaIds: string[] = [
    ...new Set<string>(
      (d.granular_scopes ?? [])
        .filter((s: any) => s.scope === "whatsapp_business_management" || s.scope === "whatsapp_business_messaging")
        .flatMap((s: any) => s.target_ids ?? [])
    ),
  ];
  if (!wabaIds.length)
    throw new GraphError("This token doesn't have WhatsApp permissions. Generate it with whatsapp_business_messaging and whatsapp_business_management.", 400);
  const numbers: PhoneOption[] = [];
  for (const waba of wabaIds) {
    try {
      const r = await graph<{ data: Omit<PhoneOption, "waba_id">[] }>(`${waba}/phone_numbers?fields=id,display_phone_number,verified_name`, { token });
      numbers.push(...r.data.map((n) => ({ ...n, waba_id: waba })));
    } catch {
      /* token may cover a WABA it can't list numbers for; skip it */
    }
  }
  return { numbers, expiresAt: d.expires_at ? Number(d.expires_at) * 1000 : null };
}

/** Points Meta's webhook for this app at our /webhook URL and subscribes the WhatsApp account to it. */
export async function subscribeWebhook(opts: { appId: string; appSecret: string; token: string; wabaId: string; callbackUrl: string; verifyToken: string }) {
  const appToken = `${opts.appId}|${opts.appSecret}`;
  const params = new URLSearchParams({
    object: "whatsapp_business_account",
    callback_url: opts.callbackUrl,
    verify_token: opts.verifyToken,
    fields: "messages",
    include_values: "true",
    access_token: appToken,
  });
  await graph(`${opts.appId}/subscriptions?${params}`, { method: "POST", token: appToken });
  await graph(`${opts.wabaId}/subscribed_apps`, { method: "POST", token: opts.token });
}

export async function getPhoneInfo() {
  return graph<{ display_phone_number: string; verified_name: string; quality_rating?: string }>(
    `${config.phoneNumberId}?fields=display_phone_number,verified_name,quality_rating`
  );
}
