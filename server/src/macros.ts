import { v4 as uuidv4 } from 'uuid';
import { getDb } from './db.js';

// --- Types ---

export interface MacroStep {
  type: 'prompt';
  text: string;
}

export interface Macro {
  id: string;
  name: string;
  aliases: string[];
  steps: MacroStep[];
  mode: string;
  createdAt: number;
  updatedAt: number;
  useCount: number;
}

// --- DB Helpers ---

interface MacroRow {
  id: string;
  name: string;
  aliases: string;
  steps: string;
  mode: string;
  created_at: number;
  updated_at: number;
  use_count: number;
}

function rowToMacro(row: MacroRow): Macro {
  return {
    id: row.id,
    name: row.name,
    aliases: JSON.parse(row.aliases),
    steps: JSON.parse(row.steps),
    mode: row.mode,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    useCount: row.use_count,
  };
}

// --- Fuzzy Matching ---

function normalize(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, ' ');
}

function fuzzyScore(input: string, target: string): number {
  const a = normalize(input);
  const b = normalize(target);
  if (a === b) return 1.0;
  if (b.includes(a) || a.includes(b)) return 0.8;

  const wordsA = new Set(a.split(' '));
  const wordsB = new Set(b.split(' '));
  let overlap = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) overlap++;
  }
  const total = Math.max(wordsA.size, wordsB.size);
  return total === 0 ? 0 : overlap / total;
}

// --- Public API ---

export function findMacro(input: string): Macro | null {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM macros').all() as MacroRow[];
  let bestMatch: Macro | null = null;
  let bestScore = 0;

  const MATCH_THRESHOLD = 0.7;

  for (const row of rows) {
    const macro = rowToMacro(row);

    const nameScore = fuzzyScore(input, macro.name);
    if (nameScore > bestScore) {
      bestScore = nameScore;
      bestMatch = macro;
    }

    for (const alias of macro.aliases) {
      const aliasScore = fuzzyScore(input, alias);
      if (aliasScore > bestScore) {
        bestScore = aliasScore;
        bestMatch = macro;
      }
    }
  }

  return bestScore >= MATCH_THRESHOLD ? bestMatch : null;
}

export function createMacro(name: string, steps: MacroStep[], aliases: string[] = [], mode: string = 'auto'): Macro {
  const db = getDb();
  const now = Date.now();
  const id = uuidv4();

  db.prepare(`
    INSERT INTO macros (id, name, aliases, steps, mode, created_at, updated_at, use_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0)
  `).run(id, name, JSON.stringify(aliases), JSON.stringify(steps), mode, now, now);

  return { id, name, aliases, steps, mode, createdAt: now, updatedAt: now, useCount: 0 };
}

export function listMacros(): Macro[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM macros ORDER BY updated_at DESC').all() as MacroRow[];
  return rows.map(rowToMacro);
}

export function getMacro(id: string): Macro | undefined {
  const db = getDb();
  const row = db.prepare('SELECT * FROM macros WHERE id = ?').get(id) as MacroRow | undefined;
  return row ? rowToMacro(row) : undefined;
}

export function updateMacro(id: string, updates: Partial<Pick<Macro, 'name' | 'aliases' | 'steps' | 'mode'>>): Macro | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM macros WHERE id = ?').get(id) as MacroRow | undefined;
  if (!row) return null;

  const macro = rowToMacro(row);
  if (updates.name !== undefined) macro.name = updates.name;
  if (updates.aliases !== undefined) macro.aliases = updates.aliases;
  if (updates.steps !== undefined) macro.steps = updates.steps;
  if (updates.mode !== undefined) macro.mode = updates.mode;
  macro.updatedAt = Date.now();

  db.prepare(`
    UPDATE macros SET name = ?, aliases = ?, steps = ?, mode = ?, updated_at = ? WHERE id = ?
  `).run(macro.name, JSON.stringify(macro.aliases), JSON.stringify(macro.steps), macro.mode, macro.updatedAt, id);

  return macro;
}

export function deleteMacro(id: string): boolean {
  const db = getDb();
  const result = db.prepare('DELETE FROM macros WHERE id = ?').run(id);
  return result.changes > 0;
}

export function incrementMacroUseCount(id: string): void {
  const db = getDb();
  db.prepare('UPDATE macros SET use_count = use_count + 1, updated_at = ? WHERE id = ?').run(Date.now(), id);
}
