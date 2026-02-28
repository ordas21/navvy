import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { v4 as uuidv4 } from 'uuid';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../data');
const MACROS_FILE = path.join(DATA_DIR, 'macros.json');

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

interface MacroStore {
  version: 1;
  macros: Macro[];
}

// --- Storage ---

function loadStore(): MacroStore {
  try {
    const raw = fs.readFileSync(MACROS_FILE, 'utf-8');
    return JSON.parse(raw) as MacroStore;
  } catch {
    return { version: 1, macros: [] };
  }
}

function saveStore(store: MacroStore): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = MACROS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, MACROS_FILE);
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

  // Word overlap score
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
  const store = loadStore();
  let bestMatch: Macro | null = null;
  let bestScore = 0;

  const MATCH_THRESHOLD = 0.7;

  for (const macro of store.macros) {
    // Check name
    const nameScore = fuzzyScore(input, macro.name);
    if (nameScore > bestScore) {
      bestScore = nameScore;
      bestMatch = macro;
    }

    // Check aliases
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
  const store = loadStore();
  const macro: Macro = {
    id: uuidv4(),
    name,
    aliases,
    steps,
    mode,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    useCount: 0,
  };
  store.macros.push(macro);
  saveStore(store);
  return macro;
}

export function listMacros(): Macro[] {
  return loadStore().macros;
}

export function getMacro(id: string): Macro | undefined {
  return loadStore().macros.find((m) => m.id === id);
}

export function updateMacro(id: string, updates: Partial<Pick<Macro, 'name' | 'aliases' | 'steps' | 'mode'>>): Macro | null {
  const store = loadStore();
  const macro = store.macros.find((m) => m.id === id);
  if (!macro) return null;

  if (updates.name !== undefined) macro.name = updates.name;
  if (updates.aliases !== undefined) macro.aliases = updates.aliases;
  if (updates.steps !== undefined) macro.steps = updates.steps;
  if (updates.mode !== undefined) macro.mode = updates.mode;
  macro.updatedAt = Date.now();

  saveStore(store);
  return macro;
}

export function deleteMacro(id: string): boolean {
  const store = loadStore();
  const index = store.macros.findIndex((m) => m.id === id);
  if (index === -1) return false;
  store.macros.splice(index, 1);
  saveStore(store);
  return true;
}

export function incrementMacroUseCount(id: string): void {
  const store = loadStore();
  const macro = store.macros.find((m) => m.id === id);
  if (macro) {
    macro.useCount++;
    macro.updatedAt = Date.now();
    saveStore(store);
  }
}
