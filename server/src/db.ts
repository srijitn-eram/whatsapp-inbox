import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { config, loadSavedSettings } from "./config.js";

if (config.databasePath !== ":memory:") mkdirSync(dirname(config.databasePath), { recursive: true });

export const db = new DatabaseSync(config.databasePath);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS contacts (
    wa_id            TEXT PRIMARY KEY,
    name             TEXT,
    profile_name     TEXT,
    notes            TEXT NOT NULL DEFAULT '',
    tags             TEXT NOT NULL DEFAULT '[]',
    assigned_to      TEXT,
    unread_count     INTEGER NOT NULL DEFAULT 0,
    last_message_at  INTEGER,
    last_inbound_at  INTEGER,
    created_at       INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    wa_message_id  TEXT UNIQUE,
    wa_id          TEXT NOT NULL REFERENCES contacts(wa_id) ON DELETE CASCADE,
    direction      TEXT NOT NULL CHECK (direction IN ('in', 'out')),
    type           TEXT NOT NULL,
    body           TEXT NOT NULL DEFAULT '',
    media_id       TEXT,
    payload        TEXT,
    status         TEXT NOT NULL,
    error          TEXT,
    sent_by        TEXT,
    timestamp      INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_messages_contact ON messages (wa_id, timestamp);

  CREATE TABLE IF NOT EXISTS settings (
    key    TEXT PRIMARY KEY,
    value  TEXT NOT NULL
  );
`);

export function saveSettings(values: Record<string, string>) {
  const stmt = db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
  for (const [k, v] of Object.entries(values)) stmt.run(k, v);
  loadSavedSettings(values);
}

loadSavedSettings(
  Object.fromEntries((db.prepare(`SELECT key, value FROM settings`).all() as { key: string; value: string }[]).map((r) => [r.key, r.value]))
);
// Every install gets its own webhook verify token unless one is set in .env
if (!config.verifyToken) saveSettings({ WEBHOOK_VERIFY_TOKEN: randomBytes(16).toString("hex") });
if (!config.sessionSecret) saveSettings({ SESSION_SECRET: randomBytes(32).toString("hex") });

export interface Contact {
  wa_id: string;
  name: string | null;
  profile_name: string | null;
  notes: string;
  tags: string[];
  assigned_to: string | null;
  unread_count: number;
  last_message_at: number | null;
  last_inbound_at: number | null;
  created_at: number;
  last_message?: string | null;
}

export interface Message {
  id: number;
  wa_message_id: string | null;
  wa_id: string;
  direction: "in" | "out";
  type: string;
  body: string;
  media_id: string | null;
  status: string;
  error: string | null;
  sent_by: string | null;
  timestamp: number;
}

function rowToContact(row: any): Contact {
  return { ...row, tags: JSON.parse(row.tags ?? "[]") };
}

export function normalizeWaId(input: string): string {
  return input.replace(/[^\d]/g, "");
}

export function upsertContact(waId: string, fields: { profile_name?: string; name?: string } = {}): Contact {
  const now = Date.now();
  db.prepare(
    `INSERT INTO contacts (wa_id, name, profile_name, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(wa_id) DO UPDATE SET
       profile_name = COALESCE(excluded.profile_name, contacts.profile_name),
       name = COALESCE(contacts.name, excluded.name)`
  ).run(waId, fields.name ?? null, fields.profile_name ?? null, now);
  return getContact(waId)!;
}

export function getContact(waId: string): Contact | undefined {
  const row = db.prepare(`SELECT * FROM contacts WHERE wa_id = ?`).get(waId);
  return row ? rowToContact(row) : undefined;
}

export function listContacts(search = ""): Contact[] {
  const q = `%${search}%`;
  const rows = db
    .prepare(
      `SELECT c.*, (SELECT body FROM messages m WHERE m.wa_id = c.wa_id ORDER BY timestamp DESC, id DESC LIMIT 1) AS last_message
       FROM contacts c
       WHERE c.wa_id LIKE ? OR IFNULL(c.name, '') LIKE ? OR IFNULL(c.profile_name, '') LIKE ?
       ORDER BY IFNULL(c.last_message_at, c.created_at) DESC`
    )
    .all(q, q, q);
  return rows.map(rowToContact);
}

export function updateContact(waId: string, patch: { name?: string; notes?: string; tags?: string[]; assigned_to?: string | null }) {
  const c = getContact(waId);
  if (!c) return undefined;
  db.prepare(`UPDATE contacts SET name = ?, notes = ?, tags = ?, assigned_to = ? WHERE wa_id = ?`).run(
    patch.name ?? c.name,
    patch.notes ?? c.notes,
    JSON.stringify(patch.tags ?? c.tags),
    patch.assigned_to === undefined ? c.assigned_to : patch.assigned_to,
    waId
  );
  return getContact(waId);
}

export function deleteContact(waId: string) {
  return db.prepare(`DELETE FROM contacts WHERE wa_id = ?`).run(waId).changes > 0;
}

export function markConversationRead(waId: string) {
  db.prepare(`UPDATE contacts SET unread_count = 0 WHERE wa_id = ?`).run(waId);
}

export function insertMessage(m: Omit<Message, "id"> & { payload?: unknown }): Message | undefined {
  const res = db
    .prepare(
      `INSERT OR IGNORE INTO messages (wa_message_id, wa_id, direction, type, body, media_id, payload, status, error, sent_by, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      m.wa_message_id,
      m.wa_id,
      m.direction,
      m.type,
      m.body,
      m.media_id,
      m.payload === undefined ? null : JSON.stringify(m.payload),
      m.status,
      m.error,
      m.sent_by,
      m.timestamp
    );
  if (res.changes === 0) return undefined; // duplicate webhook delivery
  if (m.direction === "in") {
    db.prepare(
      `UPDATE contacts SET unread_count = unread_count + 1, last_message_at = MAX(IFNULL(last_message_at, 0), ?), last_inbound_at = MAX(IFNULL(last_inbound_at, 0), ?) WHERE wa_id = ?`
    ).run(m.timestamp, m.timestamp, m.wa_id);
  } else {
    db.prepare(`UPDATE contacts SET last_message_at = MAX(IFNULL(last_message_at, 0), ?) WHERE wa_id = ?`).run(m.timestamp, m.wa_id);
  }
  return getMessage(Number(res.lastInsertRowid));
}

export function getMessage(id: number): Message | undefined {
  return db.prepare(`SELECT id, wa_message_id, wa_id, direction, type, body, media_id, status, error, sent_by, timestamp FROM messages WHERE id = ?`).get(id) as any;
}

export function listMessages(waId: string, before?: number, limit = 100): Message[] {
  const rows = db
    .prepare(
      `SELECT id, wa_message_id, wa_id, direction, type, body, media_id, status, error, sent_by, timestamp FROM messages
       WHERE wa_id = ? AND timestamp < ? ORDER BY timestamp DESC, id DESC LIMIT ?`
    )
    .all(waId, before ?? Number.MAX_SAFE_INTEGER, limit) as any[];
  return rows.reverse();
}

const STATUS_RANK: Record<string, number> = { pending: 0, sent: 1, delivered: 2, read: 3, failed: 4 };

/** Applies a delivery status from a webhook; never downgrades (e.g. a late "delivered" after "read"). */
export function applyStatus(waMessageId: string, status: string, error: string | null): Message | undefined {
  const row = db.prepare(`SELECT id, status FROM messages WHERE wa_message_id = ?`).get(waMessageId) as { id: number; status: string } | undefined;
  if (!row) return undefined;
  if ((STATUS_RANK[status] ?? 0) <= (STATUS_RANK[row.status] ?? 0)) return undefined;
  db.prepare(`UPDATE messages SET status = ?, error = ? WHERE id = ?`).run(status, error, row.id);
  return getMessage(row.id);
}

export function updateOutgoing(id: number, fields: { wa_message_id?: string; status: string; error?: string | null }) {
  db.prepare(`UPDATE messages SET wa_message_id = COALESCE(?, wa_message_id), status = ?, error = ? WHERE id = ?`).run(
    fields.wa_message_id ?? null,
    fields.status,
    fields.error ?? null,
    id
  );
  return getMessage(id)!;
}
