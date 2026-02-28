import { v4 as uuidv4 } from 'uuid';
import type { CostInfo, Mode } from './types.js';
import { getDb } from './db.js';

// --- Data Types ---

export interface ToolCallRecord {
  toolName: string;
  toolId: string;
  input: string;
  result: string;
  isError: boolean;
  timestamp: number;
}

export interface SessionData {
  sessionId: string;
  mode: Mode;
  prompt: string;
  startTime: number;
  endTime?: number;
  toolCalls: ToolCallRecord[];
  selfReview?: string;
  assistantText: string;
  cost?: CostInfo;
  siteHostname?: string;
}

export interface Learning {
  id: string;
  type: 'self_review' | 'pattern' | 'selector_fix' | 'site_specific';
  category: string;
  rule: string;
  context: { hostname?: string; toolName?: string; mode?: Mode };
  confidence: number;
  reinforcements: number;
  createdAt: number;
  lastReinforcedAt: number;
  sourceSessionIds: string[];
}

interface SessionSummary {
  sessionId: string;
  mode: Mode;
  hostname?: string;
  toolCallCount: number;
  errorCount: number;
  startTime: number;
  durationMs?: number;
}

// --- SessionTracker ---

export class SessionTracker {
  private data: SessionData;
  private pendingToolCalls = new Map<string, ToolCallRecord>();

  constructor(sessionId: string, mode: Mode, prompt: string) {
    this.data = {
      sessionId,
      mode,
      prompt,
      startTime: Date.now(),
      toolCalls: [],
      assistantText: '',
    };
    this.data.siteHostname = extractHostname(prompt);
  }

  addToolCall(name: string, id: string): void {
    const record: ToolCallRecord = {
      toolName: name,
      toolId: id,
      input: '',
      result: '',
      isError: false,
      timestamp: Date.now(),
    };
    this.pendingToolCalls.set(id, record);
  }

  updateToolInput(id: string, partial: string): void {
    const record = this.pendingToolCalls.get(id);
    if (record) {
      record.input += partial;
    }
  }

  addToolResult(id: string, result: string): void {
    const record = this.pendingToolCalls.get(id);
    if (record) {
      record.result = result;
      record.isError = isErrorResult(result);
      this.data.toolCalls.push(record);
      this.pendingToolCalls.delete(id);

      if (record.toolName === 'mcp__browser__browser_navigate' && !record.isError) {
        const navHostname = extractHostnameFromNavigateResult(record.result);
        if (navHostname) {
          this.data.siteHostname = navHostname;
        }
      }
    }
  }

  addText(text: string): void {
    this.data.assistantText += text;
  }

  setCost(cost: CostInfo): void {
    this.data.cost = cost;
  }

  getHostname(): string | undefined {
    return this.data.siteHostname;
  }

  getMode(): Mode {
    return this.data.mode;
  }

  getData(): SessionData {
    return this.data;
  }

  finalize(): SessionData {
    this.data.endTime = Date.now();
    for (const record of this.pendingToolCalls.values()) {
      record.isError = true;
      record.result = '(no result received)';
      this.data.toolCalls.push(record);
    }
    this.pendingToolCalls.clear();
    this.data.selfReview = parseSelfReview(this.data.assistantText);
    return this.data;
  }
}

// --- Self-Review Parsing ---

function parseSelfReview(text: string): string | undefined {
  const match = text.match(/<self-review>([\s\S]*?)<\/self-review>/);
  return match ? match[1].trim() : undefined;
}

// --- Error Detection ---

const ERROR_PATTERNS = [
  /error/i,
  /failed/i,
  /not found/i,
  /timed? ?out/i,
  /no (?:such|matching) element/i,
  /cannot find/i,
  /unable to/i,
  /exception/i,
];

function isErrorResult(result: string): boolean {
  const firstLine = result.split('\n')[0].substring(0, 300);
  return ERROR_PATTERNS.some((p) => p.test(firstLine));
}

// --- Hostname Extraction ---

export function extractHostname(text: string): string | undefined {
  const urlMatch = text.match(/https?:\/\/([^\/\s"'<>]+)/);
  if (urlMatch) return urlMatch[1].replace(/^www\./, '');
  return undefined;
}

function extractHostnameFromNavigateResult(result: string): string | undefined {
  return extractHostname(result);
}

// --- Analysis Rules ---

type AnalysisRule = (session: SessionData) => Learning | null;

const analysisRules: AnalysisRule[] = [
  // Rule 1: Repeated tool failures
  (session) => {
    const calls = session.toolCalls;
    for (let i = 1; i < calls.length; i++) {
      if (
        calls[i].isError &&
        calls[i - 1].isError &&
        calls[i].toolName === calls[i - 1].toolName
      ) {
        return makeLearning({
          type: 'pattern',
          category: 'error_recovery',
          rule: `When ${shortToolName(calls[i].toolName)} fails, try a different approach or selector instead of retrying the same action.`,
          context: { toolName: calls[i].toolName, hostname: session.siteHostname, mode: session.mode },
          sessionId: session.sessionId,
        });
      }
    }
    return null;
  },

  // Rule 2: Selector fix detection
  (session) => {
    const calls = session.toolCalls;
    for (let i = 1; i < calls.length; i++) {
      if (
        calls[i - 1].isError &&
        !calls[i].isError &&
        calls[i].toolName === calls[i - 1].toolName &&
        isClickOrFillTool(calls[i].toolName)
      ) {
        const oldSelector = extractSelector(calls[i - 1].input);
        const newSelector = extractSelector(calls[i].input);
        if (oldSelector && newSelector && oldSelector !== newSelector) {
          const hostname = session.siteHostname;
          const prefix = hostname ? `On ${hostname}, ` : '';
          return makeLearning({
            type: 'selector_fix',
            category: 'selector',
            rule: `${prefix}prefer "${newSelector}" over "${oldSelector}" for ${shortToolName(calls[i].toolName)}.`,
            context: { hostname, toolName: calls[i].toolName, mode: session.mode },
            sessionId: session.sessionId,
          });
        }
      }
    }
    return null;
  },

  // Rule 3: Inefficient sessions
  (session) => {
    if (session.toolCalls.length > 15) {
      return makeLearning({
        type: 'pattern',
        category: 'efficiency',
        rule: `Session used ${session.toolCalls.length} tool calls. Look for opportunities to batch operations (e.g., browser_fill_form instead of individual click/type).`,
        context: { hostname: session.siteHostname, mode: session.mode },
        sessionId: session.sessionId,
        confidence: 0.4,
      });
    }
    return null;
  },

  // Rule 4: Screenshot-before-inspect
  (session) => {
    const first = session.toolCalls[0];
    if (first && first.toolName === 'mcp__browser__browser_screenshot') {
      return makeLearning({
        type: 'pattern',
        category: 'workflow',
        rule: 'Always start with browser_inspect_page, not browser_screenshot. Inspect gives structured data with selectors.',
        context: { mode: session.mode },
        sessionId: session.sessionId,
      });
    }
    return null;
  },

  // Rule 5: Individual field filling
  (session) => {
    let alternatingCount = 0;
    const calls = session.toolCalls;
    for (let i = 1; i < calls.length; i++) {
      const prev = shortToolName(calls[i - 1].toolName);
      const curr = shortToolName(calls[i].toolName);
      if (
        (prev === 'browser_click' && curr === 'browser_type') ||
        (prev === 'browser_type' && curr === 'browser_click')
      ) {
        alternatingCount++;
      } else {
        alternatingCount = 0;
      }
      if (alternatingCount >= 4) {
        return makeLearning({
          type: 'pattern',
          category: 'efficiency',
          rule: 'Use browser_fill_form to batch-fill form fields instead of alternating click/type for each field.',
          context: { hostname: session.siteHostname, mode: session.mode },
          sessionId: session.sessionId,
        });
      }
    }
    return null;
  },

  // Rule 6: Mode mismatch
  (session) => {
    if (session.mode !== 'screenshot') return null;
    const inspectCount = session.toolCalls.filter(
      (c) => c.toolName === 'mcp__browser__browser_inspect_page',
    ).length;
    if (inspectCount >= 3) {
      return makeLearning({
        type: 'pattern',
        category: 'workflow',
        rule: 'Heavy use of browser_inspect_page in screenshot mode — consider using auto mode for better results.',
        context: { mode: session.mode, hostname: session.siteHostname },
        sessionId: session.sessionId,
        confidence: 0.4,
      });
    }
    return null;
  },
];

// --- Helpers ---

function shortToolName(name: string): string {
  return name.replace(/^mcp__browser__/, '');
}

function isClickOrFillTool(name: string): boolean {
  const short = shortToolName(name);
  return ['browser_click', 'browser_fill_form', 'browser_type', 'browser_select'].includes(short);
}

function extractSelector(input: string): string | undefined {
  try {
    const parsed = JSON.parse(input);
    return parsed.selector || parsed.css || undefined;
  } catch {
    const match = input.match(/"selector"\s*:\s*"([^"]+)"/);
    return match ? match[1] : undefined;
  }
}

function makeLearning(opts: {
  type: Learning['type'];
  category: string;
  rule: string;
  context: Learning['context'];
  sessionId: string;
  confidence?: number;
}): Learning {
  return {
    id: uuidv4(),
    type: opts.type,
    category: opts.category,
    rule: opts.rule,
    context: opts.context,
    confidence: opts.confidence ?? 0.6,
    reinforcements: 0,
    createdAt: Date.now(),
    lastReinforcedAt: Date.now(),
    sourceSessionIds: [opts.sessionId],
  };
}

function categorizeFromText(text: string): string {
  const lower = text.toLowerCase();
  if (/selector|css|element|dom|xpath/.test(lower)) return 'selector';
  if (/slow|efficient|batch|too many|calls/.test(lower)) return 'efficiency';
  if (/error|fail|retry|recover|timeout/.test(lower)) return 'error_recovery';
  return 'workflow';
}

// --- Deduplication (Jaccard word similarity) ---

function jaccardSimilarity(a: string, b: string): number {
  const setA = new Set(a.toLowerCase().split(/\s+/));
  const setB = new Set(b.toLowerCase().split(/\s+/));
  let intersection = 0;
  for (const word of setA) {
    if (setB.has(word)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function findDuplicate(
  newLearning: Learning,
  existing: Learning[],
): Learning | undefined {
  return existing.find(
    (e) =>
      e.category === newLearning.category &&
      e.context.hostname === newLearning.context.hostname &&
      jaccardSimilarity(e.rule, newLearning.rule) > 0.7,
  );
}

// --- DB Helpers ---

interface LearningRow {
  id: string;
  type: string;
  category: string;
  rule: string;
  context_hostname: string | null;
  context_tool_name: string | null;
  context_mode: string | null;
  confidence: number;
  reinforcements: number;
  created_at: number;
  last_reinforced_at: number;
  source_session_ids: string;
}

function rowToLearning(row: LearningRow): Learning {
  return {
    id: row.id,
    type: row.type as Learning['type'],
    category: row.category,
    rule: row.rule,
    context: {
      hostname: row.context_hostname ?? undefined,
      toolName: row.context_tool_name ?? undefined,
      mode: (row.context_mode as Mode) ?? undefined,
    },
    confidence: row.confidence,
    reinforcements: row.reinforcements,
    createdAt: row.created_at,
    lastReinforcedAt: row.last_reinforced_at,
    sourceSessionIds: JSON.parse(row.source_session_ids),
  };
}

function loadAllLearnings(): Learning[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM learnings').all() as LearningRow[];
  return rows.map(rowToLearning);
}

function saveLearning(l: Learning): void {
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO learnings (id, type, category, rule, context_hostname, context_tool_name, context_mode, confidence, reinforcements, created_at, last_reinforced_at, source_session_ids)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    l.id, l.type, l.category, l.rule,
    l.context.hostname ?? null, l.context.toolName ?? null, l.context.mode ?? null,
    l.confidence, l.reinforcements,
    l.createdAt, l.lastReinforcedAt,
    JSON.stringify(l.sourceSessionIds),
  );
}

function deleteLearning(id: string): void {
  const db = getDb();
  db.prepare('DELETE FROM learnings WHERE id = ?').run(id);
}

// --- Decay & Cleanup ---

function decayAndCleanup(): void {
  const now = Date.now();
  const ONE_WEEK = 7 * 24 * 60 * 60 * 1000;
  const db = getDb();

  const learnings = loadAllLearnings();

  for (const learning of learnings) {
    const weeksSinceReinforced = (now - learning.lastReinforcedAt) / ONE_WEEK;
    if (weeksSinceReinforced < 1) continue;

    const decayRate = learning.reinforcements >= 3 ? 0.02 : 0.05;
    learning.confidence -= decayRate * weeksSinceReinforced;

    if (learning.confidence < 0.15) {
      deleteLearning(learning.id);
    } else {
      db.prepare('UPDATE learnings SET confidence = ? WHERE id = ?').run(learning.confidence, learning.id);
    }
  }

  // Cap at 100 learnings
  const count = (db.prepare('SELECT COUNT(*) as c FROM learnings').get() as { c: number }).c;
  if (count > 100) {
    db.prepare(`
      DELETE FROM learnings WHERE id NOT IN (
        SELECT id FROM learnings ORDER BY confidence DESC LIMIT 100
      )
    `).run();
  }

  // Cap session history at 50
  const sessionCount = (db.prepare('SELECT COUNT(*) as c FROM session_history').get() as { c: number }).c;
  if (sessionCount > 50) {
    db.prepare(`
      DELETE FROM session_history WHERE id NOT IN (
        SELECT id FROM session_history ORDER BY start_time DESC LIMIT 50
      )
    `).run();
  }
}

// --- Self-Review -> Learnings ---

function selfReviewToLearnings(review: string, session: SessionData): Learning[] {
  const bullets = review
    .split('\n')
    .map((line) => line.replace(/^[-*]\s*/, '').trim())
    .filter((line) => line.length > 10);

  return bullets.map((bullet) => ({
    id: uuidv4(),
    type: 'self_review' as const,
    category: categorizeFromText(bullet),
    rule: bullet,
    context: { hostname: session.siteHostname, mode: session.mode },
    confidence: 0.7,
    reinforcements: 0,
    createdAt: Date.now(),
    lastReinforcedAt: Date.now(),
    sourceSessionIds: [session.sessionId],
  }));
}

// --- Main Entry: Finalize Session ---

export function finalizeSession(tracker: SessionTracker): void {
  const session = tracker.finalize();
  const db = getDb();

  decayAndCleanup();

  // Collect new learnings from analysis rules
  const newLearnings: Learning[] = [];

  for (const rule of analysisRules) {
    const learning = rule(session);
    if (learning) newLearnings.push(learning);
  }

  // Collect learnings from self-review
  if (session.selfReview) {
    newLearnings.push(...selfReviewToLearnings(session.selfReview, session));
  }

  // Load existing for deduplication
  const existing = loadAllLearnings();

  // Deduplicate and merge
  for (const newL of newLearnings) {
    const dup = findDuplicate(newL, existing);
    if (dup) {
      dup.confidence = Math.min(1, dup.confidence + 0.1);
      dup.reinforcements++;
      dup.lastReinforcedAt = Date.now();
      if (!dup.sourceSessionIds.includes(session.sessionId)) {
        dup.sourceSessionIds.push(session.sessionId);
      }
      saveLearning(dup);
      console.log(`[learnings] Reinforced: "${dup.rule.substring(0, 60)}..." (confidence: ${dup.confidence.toFixed(2)})`);
    } else {
      saveLearning(newL);
      existing.push(newL);
      console.log(`[learnings] New: "${newL.rule.substring(0, 60)}..." (${newL.type}, confidence: ${newL.confidence.toFixed(2)})`);
    }
  }

  // Add session summary
  const errorCount = session.toolCalls.filter((c) => c.isError).length;
  db.prepare(`
    INSERT INTO session_history (session_id, mode, hostname, tool_call_count, error_count, start_time, duration_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    session.sessionId, session.mode, session.siteHostname ?? null,
    session.toolCalls.length, errorCount,
    session.startTime, session.endTime ? session.endTime - session.startTime : null,
  );

  const totalLearnings = (db.prepare('SELECT COUNT(*) as c FROM learnings').get() as { c: number }).c;
  const totalSessions = (db.prepare('SELECT COUNT(*) as c FROM session_history').get() as { c: number }).c;
  console.log(`[learnings] Session finalized. Total learnings: ${totalLearnings}, sessions: ${totalSessions}`);
}

// --- Relevance Scoring & Prompt Injection ---

export function getLearningsForPrompt(mode: Mode, hostname?: string): string {
  const learnings = loadAllLearnings();
  if (learnings.length === 0) return '';

  const now = Date.now();
  const THREE_DAYS = 3 * 24 * 60 * 60 * 1000;

  const scored = learnings.map((l) => {
    let score = l.confidence;

    if (hostname && l.context.hostname) {
      if (l.context.hostname === hostname) {
        score += 0.4;
      } else if (l.type === 'site_specific' || l.type === 'selector_fix') {
        score -= 0.3;
      }
    }

    if (l.context.mode === mode) score += 0.1;
    score += Math.min(0.2, l.reinforcements * 0.05);
    if (now - l.lastReinforcedAt < THREE_DAYS) score += 0.1;

    return { learning: l, score };
  });

  const relevant = scored
    .filter((s) => s.score >= 0.1)
    .sort((a, b) => b.score - a.score);

  if (relevant.length === 0) return '';

  const MAX_CHARS = 2000;
  let result = '\n\n## Learnings from Previous Sessions\n';
  let charCount = result.length;

  for (const { learning } of relevant) {
    const line = `- ${learning.rule}\n`;
    if (charCount + line.length > MAX_CHARS) break;
    result += line;
    charCount += line.length;
  }

  return result;
}

// --- Self-Review Prompt ---

export const SELF_REVIEW_PROMPT = `

## Self-Review
After completing the user's task, output a <self-review> block with brief observations:
- What approach worked well
- What didn't work or was inefficient
- Any site-specific quirks (selectors, timing, unusual behavior)
Keep it to 3-5 bullet points. Example:
<self-review>
- browser_fill_form worked well for the registration form
- Had to use browser_wait before clicking submit due to slow page load
- The site uses shadow DOM for the date picker, needed browser_evaluate to interact with it
</self-review>`;
