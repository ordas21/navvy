import { createHash, randomBytes } from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';
import type { Request, Response, NextFunction } from 'express';
import { getDb } from './db.js';

// --- Types ---

export interface ApiKey {
  id: string;
  name: string;
  keyPrefix: string;
  createdAt: number;
  lastUsedAt: number | null;
  isActive: boolean;
}

interface ApiKeyRow {
  id: string;
  name: string;
  key_hash: string;
  key_prefix: string;
  created_at: number;
  last_used_at: number | null;
  is_active: number;
}

// --- Helpers ---

function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

// --- API Key Management ---

export function generateApiKey(name: string = 'default'): { key: string; record: ApiKey } {
  const db = getDb();
  const id = uuidv4();
  const rawKey = `nvk_${randomBytes(32).toString('hex')}`;
  const keyHash = hashKey(rawKey);
  const keyPrefix = rawKey.substring(0, 8);
  const now = Date.now();

  db.prepare(`
    INSERT INTO api_keys (id, name, key_hash, key_prefix, created_at, is_active)
    VALUES (?, ?, ?, ?, ?, 1)
  `).run(id, name, keyHash, keyPrefix, now);

  return {
    key: rawKey,
    record: { id, name, keyPrefix, createdAt: now, lastUsedAt: null, isActive: true },
  };
}

export function validateApiKey(key: string): ApiKey | null {
  const db = getDb();
  const keyHash = hashKey(key);
  const row = db.prepare('SELECT * FROM api_keys WHERE key_hash = ? AND is_active = 1').get(keyHash) as ApiKeyRow | undefined;
  if (!row) return null;

  // Update last used
  db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(Date.now(), row.id);

  return {
    id: row.id,
    name: row.name,
    keyPrefix: row.key_prefix,
    createdAt: row.created_at,
    lastUsedAt: Date.now(),
    isActive: true,
  };
}

export function listApiKeys(): ApiKey[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM api_keys WHERE is_active = 1 ORDER BY created_at DESC').all() as ApiKeyRow[];
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    keyPrefix: row.key_prefix,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    isActive: row.is_active === 1,
  }));
}

export function revokeApiKey(id: string): boolean {
  const db = getDb();
  const result = db.prepare('UPDATE api_keys SET is_active = 0 WHERE id = ?').run(id);
  return result.changes > 0;
}

export function hasAnyApiKeys(): boolean {
  const db = getDb();
  const row = db.prepare('SELECT COUNT(*) as c FROM api_keys WHERE is_active = 1').get() as { c: number };
  return row.c > 0;
}

// --- Middleware ---

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  // If no API keys exist, skip auth (first-run setup mode)
  if (!hasAnyApiKeys()) {
    next();
    return;
  }

  const key = req.headers['x-api-key'] as string | undefined;
  if (!key) {
    res.status(401).json({ error: 'API key required. Set X-API-Key header.' });
    return;
  }

  const apiKey = validateApiKey(key);
  if (!apiKey) {
    res.status(403).json({ error: 'Invalid API key' });
    return;
  }

  next();
}

// --- WebSocket Auth ---

export function validateWsApiKey(url: string): boolean {
  // If no API keys exist, allow all connections (setup mode)
  if (!hasAnyApiKeys()) return true;

  try {
    const parsed = new URL(url, 'http://localhost');
    const key = parsed.searchParams.get('apiKey');
    if (!key) return false;
    return validateApiKey(key) !== null;
  } catch {
    return false;
  }
}
