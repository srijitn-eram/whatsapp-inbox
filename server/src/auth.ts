import type { NextFunction, Request, Response } from "express";
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";

/**
 * Team sign-in: everyone shares one team password and picks a display name,
 * which is recorded on every message they send. The password is the one chosen
 * in the app (stored hashed) or INBOX_PASSWORD from the environment; either works.
 */
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

function sign(payload: string) {
  return createHmac("sha256", config.sessionSecret).update(payload).digest("base64url");
}

function same(a: Buffer, b: Buffer) {
  return a.length === b.length && timingSafeEqual(a, b);
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  return `${salt.toString("hex")}:${scryptSync(password.trim(), salt, 32).toString("hex")}`;
}

export function passwordMatches(password: string): boolean {
  // Trim both sides: a stray space or newline pasted into the host's env settings is the usual culprit
  const given = password.trim();
  if (!given) return false;
  const envPassword = config.inboxPassword.trim();
  if (envPassword && same(Buffer.from(given), Buffer.from(envPassword))) return true;
  const [salt, hash] = config.teamPasswordHash.split(":");
  if (!salt || !hash) return false;
  return same(scryptSync(given, Buffer.from(salt, "hex"), 32), Buffer.from(hash, "hex"));
}

export function issueToken(name: string): string {
  const payload = Buffer.from(JSON.stringify({ name, exp: Date.now() + TTL_MS })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export function verify(token: string | undefined): { name: string } | null {
  if (!token) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  if (!same(Buffer.from(sign(payload)), Buffer.from(sig))) return null;
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
