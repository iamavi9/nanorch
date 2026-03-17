import { scryptSync, randomBytes, timingSafeEqual } from "crypto";
import type { Request, Response, NextFunction } from "express";

declare module "express-session" {
  interface SessionData {
    userId: string;
    userRole: string;
  }
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  try {
    const [salt, hash] = stored.split(":");
    const hashBuffer = Buffer.from(hash, "hex");
    const derivedHash = scryptSync(password, salt, 64);
    return timingSafeEqual(hashBuffer, derivedHash);
  } catch {
    return false;
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.session?.userId) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.session?.userId) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  if (req.session.userRole !== "admin") {
    return res.status(403).json({ error: "Forbidden — admin only" });
  }
  next();
}
