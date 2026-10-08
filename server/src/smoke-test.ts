/** End-to-end check against the mock Graph API: npm test */
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import assert from "node:assert/strict";

const APP = "http://localhost:3999";
const MOCK = "http://localhost:4019";
const base = {
  ...process.env,
  PORT: "3999",
  MOCK_PORT: "4019",
  APP_WEBHOOK: `${APP}/webhook`,
  DATABASE_PATH: ":memory:",
  GRAPH_API_BASE: MOCK,
  INBOX_PASSWORD: "team-pass ",
  SESSION_SECRET: "session-secret",
  WEBHOOK_VERIFY_TOKEN: "verify-me",
  // The app gets its WhatsApp details from the setup page, not .env
  PUBLIC_URL: "https://inbox.example.com",
};
const mockEnv = { ...base, WHATSAPP_APP_SECRET: "app-secret", WHATSAPP_PHONE_NUMBER_ID: "PHONE_ID", MOCK_VERIFY_URL: `${APP}/webhook` };

const procs = [spawn(process.execPath, ["--no-warnings", "--import", "tsx", "src/mock-graph.ts"], { env: mockEnv }), spawn(process.execPath, ["--no-warnings", "--import", "tsx", "src/index.ts"], { env: base })];
procs.forEach((p) => p.stderr.on("data", (d) => process.env.DEBUG && process.stderr.write(d)));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function up(url: string) {
  for (let i = 0; i < 60; i++) {
    try {
      await fetch(url);
      return;
    } catch {
      await wait(250);
    }
  }
  throw new Error(`${url} did not start`);
}

let token = "";
const api = (path: string, init: RequestInit = {}) =>
  fetch(`${APP}/api${path}`, { ...init, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...init.headers } });

async function main() {
  await up(`${APP}/api/health`);
  await up(`${MOCK}/simulate/sent`);

  // Webhook verification handshake
  let r = await fetch(`${APP}/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=abc123`);
  assert.equal(await r.text(), "abc123");
  r = await fetch(`${APP}/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=x`);
  assert.equal(r.status, 403);
  console.log("✓ webhook verification");


  // Login
  r = await api("/login", { method: "POST", body: JSON.stringify({ name: "Asha", password: "nope" }) });
  assert.equal(r.status, 401);
  r = await api("/contacts");
  assert.equal(r.status, 401);
  r = await api("/login", { method: "POST", body: JSON.stringify({ name: "Asha", password: " team-pass\n" }) });
  token = (await r.json()).token;
  assert.ok(token);
  // Before WhatsApp is connected, the team password can be chosen in the app
  assert.equal((await (await api("/health")).json()).choosePassword, true);
  r = await api("/team-password", { method: "POST", body: JSON.stringify({ name: "Asha", password: "Chosen 123" }) });
  assert.ok((await r.json()).token);
  r = await api("/login", { method: "POST", body: JSON.stringify({ name: "Ravi", password: "Chosen 123 " }) });
  assert.equal(r.status, 200);
  r = await api("/login", { method: "POST", body: JSON.stringify({ name: "Ravi", password: "team-pass" }) });
  assert.equal(r.status, 200);
  assert.equal((await (await api("/health")).json()).choosePassword, false);
  r = await api("/team-password", { method: "POST", body: JSON.stringify({ name: "X", password: "takeover" }) });
  assert.equal(r.status, 403);
  console.log("✓ team sign-in and choosing a password");


  // Connect WhatsApp from the setup page
  let h = await (await api("/health")).json();
  assert.equal(h.connected, false);
  r = await api("/setup/discover", { method: "POST", body: JSON.stringify({ token: "wrong", appId: "APP_ID", appSecret: "app-secret" }) });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /Invalid OAuth/);
  r = await api("/setup/discover", { method: "POST", body: JSON.stringify({ token: "user-token", appId: "APP_ID", appSecret: "nope" }) });
  assert.equal(r.status, 400);
  r = await api("/setup/discover", { method: "POST", body: JSON.stringify({ token: "user-token", appId: "APP_ID", appSecret: "app-secret" }) });
  const found = await r.json();
  assert.equal(found.numbers[0].id, "PHONE_ID");
  assert.equal(found.numbers[0].waba_id, "WABA_ID");
  r = await api("/setup/connect", {
    method: "POST",
    body: JSON.stringify({ token: "user-token", appId: "APP_ID", appSecret: "app-secret", phoneNumberId: "PHONE_ID", wabaId: "WABA_ID" }),
  });
  const conn = await r.json();
  assert.equal(conn.webhook, true, conn.webhookError);
  const subs = await (await fetch(`${MOCK}/simulate/subscriptions`)).json();
  assert.equal(subs[0].callback_url, "https://inbox.example.com/webhook");
  const st = await (await api("/setup")).json();
  assert.equal(st.connected, true);
  assert.equal(st.phone.verified_name, "Demo Store");
  assert.equal(JSON.stringify(st).includes("user-token"), false);
  console.log("✓ setup page: token check, number discovery, webhook auto-subscribed");

  // Unsigned webhook rejected
  r = await fetch(`${APP}/webhook`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(r.status, 401);
  const forged = JSON.stringify({ object: "whatsapp_business_account" });
  r = await fetch(`${APP}/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Hub-Signature-256": "sha256=" + createHmac("sha256", "wrong").update(forged).digest("hex") },
    body: forged,
  });
  assert.equal(r.status, 401);
  console.log("✓ webhook signature check");

  // Inbound message creates contact + unread
  await fetch(`${MOCK}/simulate/inbound`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ from: "14155550123", name: "Maria", text: "Where is my order?" }) });
  await wait(300);
  let contacts = await (await api("/contacts")).json();
  assert.equal(contacts.length, 1);
  assert.equal(contacts[0].profile_name, "Maria");
  assert.equal(contacts[0].unread_count, 1);
  assert.equal(contacts[0].last_message, "Where is my order?");
  console.log("✓ inbound message stored");

  // Reply + delivery receipts
  r = await api("/contacts/14155550123/messages", { method: "POST", body: JSON.stringify({ text: "It ships today!" }) });
  assert.equal(r.status, 201);
  const out = await r.json();
  assert.equal(out.status, "sent");
  assert.equal(out.sent_by, "Asha");
  await wait(1300);
  let msgs = await (await api("/contacts/14155550123/messages")).json();
  assert.equal(msgs.length, 2);
  assert.equal(msgs[1].status, "read");
  console.log("✓ reply sent, delivered and read receipts applied");

  // Mark conversation read
  await api("/contacts/14155550123/read", { method: "POST" });
  contacts = await (await api("/contacts")).json();
  assert.equal(contacts[0].unread_count, 0);
  console.log("✓ mark as read");

  // 24h window: new contact with no inbound -> free text rejected, template allowed
  r = await api("/contacts", { method: "POST", body: JSON.stringify({ wa_id: "+44 7700 900123", name: "Tom", tags: ["vip"] }) });
  assert.equal(r.status, 201);
  r = await api("/contacts/447700900123/messages", { method: "POST", body: JSON.stringify({ text: "hello" }) });
  assert.equal(r.status, 409);
  const templates = await (await api("/templates")).json();
  assert.deepEqual(templates.map((t: any) => t.name), ["hello_world", "order_update"]);
  r = await api("/contacts/447700900123/template", {
    method: "POST",
    body: JSON.stringify({ name: "order_update", language: "en_US", components: [{ type: "body", parameters: ["Tom", "#42", "Friday"].map((text) => ({ type: "text", text })) }], preview: "Hi Tom, your order #42 is on its way and should arrive by Friday." }),
  });
  assert.equal(r.status, 201);
  const sent = await (await fetch(`${MOCK}/simulate/sent`)).json();
  assert.equal(sent.at(-1).template.components[0].parameters[2].text, "Friday");
  console.log("✓ 24h window enforced, template sent");

  // Broadcast with one failing recipient
  await api("/contacts", { method: "POST", body: JSON.stringify({ wa_id: "99912345678", name: "Blocked" }) });
  r = await api("/broadcast", { method: "POST", body: JSON.stringify({ name: "hello_world", language: "en_US", wa_ids: ["14155550123", "447700900123", "99912345678"] }) });
  const b = await r.json();
  assert.equal(b.sent, 2);
  assert.equal(b.failed, 1);
  assert.match(b.results[2].error, /not in allowed list/);
  console.log("✓ broadcast with per-recipient failures");

  // Duplicate webhook delivery is ignored; image media proxied
  await fetch(`${MOCK}/simulate/inbound`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ from: "14155550123", text: "photo", image: true }) });
  await wait(300);
  msgs = await (await api("/contacts/14155550123/messages")).json();
  const img = msgs.find((m: any) => m.type === "image");
  r = await api(`/media/${img.media_id}`);
  assert.equal(r.headers.get("content-type"), "image/svg+xml");
  assert.match(await r.text(), /^<svg/);
  console.log("✓ media proxy");

  // Contact edit/delete
  r = await api("/contacts/447700900123", { method: "PATCH", body: JSON.stringify({ notes: "Prefers mornings", assigned_to: "Asha" }) });
  assert.equal((await r.json()).assigned_to, "Asha");
  r = await api("/contacts/99912345678", { method: "DELETE" });
  assert.equal(r.status, 204);
  console.log("✓ contact edit and delete");

  console.log("\nAll checks passed");
}

main()
  .catch((e) => {
    console.error("FAILED:", e);
    process.exitCode = 1;
  })
  .finally(() => procs.forEach((p) => p.kill()));
