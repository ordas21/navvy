import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../data');
const DB_PATH = path.join(DATA_DIR, 'navvy.db');

fs.mkdirSync(DATA_DIR, { recursive: true });

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) {
    _db = new Database(DB_PATH);
    _db.pragma('journal_mode = WAL');
    _db.pragma('foreign_keys = ON');
    _db.pragma('busy_timeout = 5000');
    initSchema(_db);
    migrateJsonData(_db);
  }
  return _db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      key_hash TEXT NOT NULL UNIQUE,
      key_prefix TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
      last_used_at INTEGER,
      is_active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT 'New Conversation',
      url TEXT DEFAULT '',
      created_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
      message_count INTEGER NOT NULL DEFAULT 0,
      preview_text TEXT DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      text TEXT DEFAULT '',
      data TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
    );
    CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id);

    CREATE TABLE IF NOT EXISTS learnings (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      category TEXT NOT NULL,
      rule TEXT NOT NULL,
      context_hostname TEXT,
      context_tool_name TEXT,
      context_mode TEXT,
      confidence REAL NOT NULL DEFAULT 0.6,
      reinforcements INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      last_reinforced_at INTEGER NOT NULL,
      source_session_ids TEXT NOT NULL DEFAULT '[]'
    );
    CREATE INDEX IF NOT EXISTS idx_learnings_category ON learnings(category);
    CREATE INDEX IF NOT EXISTS idx_learnings_hostname ON learnings(context_hostname);

    CREATE TABLE IF NOT EXISTS session_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      mode TEXT NOT NULL,
      hostname TEXT,
      tool_call_count INTEGER NOT NULL DEFAULT 0,
      error_count INTEGER NOT NULL DEFAULT 0,
      start_time INTEGER NOT NULL,
      duration_ms INTEGER
    );

    CREATE TABLE IF NOT EXISTS macros (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      aliases TEXT NOT NULL DEFAULT '[]',
      steps TEXT NOT NULL DEFAULT '[]',
      mode TEXT NOT NULL DEFAULT 'auto',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      use_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'auto',
      status TEXT NOT NULL DEFAULT 'active',
      notification TEXT NOT NULL DEFAULT '{"type":"log"}',
      last_run_at INTEGER,
      next_run_at INTEGER,
      run_count INTEGER NOT NULL DEFAULT 0,
      error_count INTEGER NOT NULL DEFAULT 0,
      history TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS checkpoint_sessions (
      session_id TEXT PRIMARY KEY,
      task_description TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS checkpoints (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES checkpoint_sessions(session_id) ON DELETE CASCADE,
      step_index INTEGER NOT NULL,
      timestamp INTEGER NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      state_snapshot TEXT NOT NULL DEFAULT '{}',
      action_log TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'completed'
    );
    CREATE INDEX IF NOT EXISTS idx_checkpoints_session ON checkpoints(session_id);

    CREATE TABLE IF NOT EXISTS workflows (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      variables TEXT NOT NULL DEFAULT '[]',
      steps TEXT NOT NULL DEFAULT '[]',
      tags TEXT NOT NULL DEFAULT '[]',
      run_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS approval_policies (
      id TEXT PRIMARY KEY,
      pattern TEXT NOT NULL DEFAULT '{}',
      action TEXT NOT NULL,
      trust_level TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS active_processes (
      session_id TEXT PRIMARY KEY,
      pid INTEGER,
      status TEXT NOT NULL DEFAULT 'running',
      started_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
      model TEXT,
      mode TEXT
    );
  `);
}

// --- JSON Data Migration ---

function migrateJsonData(db: Database.Database): void {
  const migrated = db.prepare('SELECT value FROM meta WHERE key = ?').get('json_migrated') as { value: string } | undefined;
  if (migrated) return;

  console.log('[db] Migrating existing JSON data to SQLite...');

  const tx = db.transaction(() => {
    migrateLearnings(db);
    migrateMacros(db);
    migrateScheduledTasks(db);
    migrateCheckpoints(db);
    migrateWorkflows(db);
    migrateApprovalPolicies(db);

    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('json_migrated', new Date().toISOString());
  });

  tx();
  console.log('[db] JSON migration complete');
}

function migrateLearnings(db: Database.Database): void {
  const file = path.join(DATA_DIR, 'learnings.json');
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    const store = JSON.parse(raw) as {
      learnings: Array<{
        id: string; type: string; category: string; rule: string;
        context: { hostname?: string; toolName?: string; mode?: string };
        confidence: number; reinforcements: number;
        createdAt: number; lastReinforcedAt: number;
        sourceSessionIds: string[];
      }>;
      sessionHistory: Array<{
        sessionId: string; mode: string; hostname?: string;
        toolCallCount: number; errorCount: number;
        startTime: number; durationMs?: number;
      }>;
    };

    const insertLearning = db.prepare(`
      INSERT OR IGNORE INTO learnings (id, type, category, rule, context_hostname, context_tool_name, context_mode, confidence, reinforcements, created_at, last_reinforced_at, source_session_ids)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const l of store.learnings) {
      insertLearning.run(
        l.id, l.type, l.category, l.rule,
        l.context.hostname ?? null, l.context.toolName ?? null, l.context.mode ?? null,
        l.confidence, l.reinforcements,
        l.createdAt, l.lastReinforcedAt,
        JSON.stringify(l.sourceSessionIds),
      );
    }

    const insertSession = db.prepare(`
      INSERT OR IGNORE INTO session_history (session_id, mode, hostname, tool_call_count, error_count, start_time, duration_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    for (const s of store.sessionHistory) {
      insertSession.run(s.sessionId, s.mode, s.hostname ?? null, s.toolCallCount, s.errorCount, s.startTime, s.durationMs ?? null);
    }

    console.log(`[db] Migrated ${store.learnings.length} learnings, ${store.sessionHistory.length} sessions`);
  } catch {
    // No file or invalid JSON — skip
  }
}

function migrateMacros(db: Database.Database): void {
  const file = path.join(DATA_DIR, 'macros.json');
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    const store = JSON.parse(raw) as {
      macros: Array<{
        id: string; name: string; aliases: string[]; steps: unknown[];
        mode: string; createdAt: number; updatedAt: number; useCount: number;
      }>;
    };

    const insert = db.prepare(`
      INSERT OR IGNORE INTO macros (id, name, aliases, steps, mode, created_at, updated_at, use_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const m of store.macros) {
      insert.run(m.id, m.name, JSON.stringify(m.aliases), JSON.stringify(m.steps), m.mode, m.createdAt, m.updatedAt, m.useCount);
    }

    console.log(`[db] Migrated ${store.macros.length} macros`);
  } catch {
    // No file or invalid JSON
  }
}

function migrateScheduledTasks(db: Database.Database): void {
  const file = path.join(DATA_DIR, 'scheduled-tasks.json');
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    const store = JSON.parse(raw) as {
      tasks: Array<{
        id: string; name: string; prompt: string; schedule: unknown;
        mode: string; status: string; notification: unknown;
        lastRunAt: number | null; nextRunAt: number | null;
        runCount: number; errorCount: number; history: unknown[];
        createdAt: number; updatedAt: number;
      }>;
    };

    const insert = db.prepare(`
      INSERT OR IGNORE INTO scheduled_tasks (id, name, prompt, schedule, mode, status, notification, last_run_at, next_run_at, run_count, error_count, history, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const t of store.tasks) {
      insert.run(
        t.id, t.name, t.prompt, JSON.stringify(t.schedule), t.mode, t.status,
        JSON.stringify(t.notification), t.lastRunAt, t.nextRunAt,
        t.runCount, t.errorCount, JSON.stringify(t.history),
        t.createdAt, t.updatedAt,
      );
    }

    console.log(`[db] Migrated ${store.tasks.length} scheduled tasks`);
  } catch {
    // No file or invalid JSON
  }
}

function migrateCheckpoints(db: Database.Database): void {
  const dir = path.join(DATA_DIR, 'checkpoints');
  try {
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));

    const insertSession = db.prepare(`
      INSERT OR IGNORE INTO checkpoint_sessions (session_id, task_description, created_at, updated_at)
      VALUES (?, ?, ?, ?)
    `);

    const insertCheckpoint = db.prepare(`
      INSERT OR IGNORE INTO checkpoints (id, session_id, step_index, timestamp, description, state_snapshot, action_log, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let count = 0;
    for (const f of files) {
      try {
        const raw = fs.readFileSync(path.join(dir, f), 'utf-8');
        const session = JSON.parse(raw) as {
          sessionId: string; taskDescription: string;
          checkpoints: Array<{
            id: string; stepIndex: number; timestamp: number;
            description: string; stateSnapshot: unknown;
            actionLog: unknown[]; status: string;
          }>;
          createdAt: number; updatedAt: number;
        };

        insertSession.run(session.sessionId, session.taskDescription, session.createdAt, session.updatedAt);

        for (const cp of session.checkpoints) {
          insertCheckpoint.run(
            cp.id, session.sessionId, cp.stepIndex, cp.timestamp,
            cp.description, JSON.stringify(cp.stateSnapshot),
            JSON.stringify(cp.actionLog), cp.status,
          );
        }
        count++;
      } catch {
        // Skip invalid files
      }
    }

    console.log(`[db] Migrated ${count} checkpoint sessions`);
  } catch {
    // No directory
  }
}

function migrateWorkflows(db: Database.Database): void {
  const dir = path.join(DATA_DIR, 'workflows');
  try {
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));

    const insert = db.prepare(`
      INSERT OR IGNORE INTO workflows (id, name, variables, steps, tags, run_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let count = 0;
    for (const f of files) {
      try {
        const raw = fs.readFileSync(path.join(dir, f), 'utf-8');
        const wf = JSON.parse(raw) as {
          id: string; name: string; variables: unknown[];
          steps: unknown[]; tags: string[]; runCount: number;
          createdAt: number; updatedAt: number;
        };

        insert.run(wf.id, wf.name, JSON.stringify(wf.variables), JSON.stringify(wf.steps), JSON.stringify(wf.tags), wf.runCount, wf.createdAt, wf.updatedAt);
        count++;
      } catch {
        // Skip invalid files
      }
    }

    console.log(`[db] Migrated ${count} workflows`);
  } catch {
    // No directory
  }
}

function migrateApprovalPolicies(db: Database.Database): void {
  const file = path.join(DATA_DIR, 'approval-policies.json');
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    const store = JSON.parse(raw) as {
      policies: Array<{
        id: string; pattern: unknown; action: string;
        trustLevel: string; createdAt: number;
      }>;
    };

    const insert = db.prepare(`
      INSERT OR IGNORE INTO approval_policies (id, pattern, action, trust_level, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);

    for (const p of store.policies) {
      insert.run(p.id, JSON.stringify(p.pattern), p.action, p.trustLevel, p.createdAt);
    }

    console.log(`[db] Migrated ${store.policies.length} approval policies`);
  } catch {
    // No file or invalid JSON
  }
}
