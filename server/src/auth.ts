import type { NextFunction, Request, Response } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";

/**
 * Team sign-in: everyone shares INBOX_PASSWORD and picks a display name,
 * which is recorded on every message they send.
 */
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

function sign(payload: string) {
  return createHmac("sha256", config.sessionSecret).update(payload).digest("base64url");
}

export function login(name: string, password: string): string | null {
  // Trim both sides: a stray space or newline pasted into the host's env settings is the usual culprit
  const expected = config.inboxPassword.trim();
  const a = Buffer.from(password.trim());
  const b = Buffer.from(expected);
  if (!expected || a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const payload = Buffer.from(JSON.stringify({ name, exp: Date.now() + TTL_MS })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export function verify(token: string | undefined): { name: string } | null {
  if (!token) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  const data = JSON.parse(Buffer.from(payload, "base64url").toString());
  return data.exp > Date.now() ? { name: data.name } : null;
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  // EventSource can't send headers, so the live stream passes the token as ?token=
  const header = req.get("authorization")?.replace(/^Bearer /, "");
  const user = verify(header ?? (req.query.token as string | undefined));
  if (!user) {
    res.status(401).json({ error: "Not signed in" });
    return;
  }
  res.locals.user = user;
  next();
}
