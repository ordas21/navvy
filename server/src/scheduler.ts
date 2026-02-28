import { v4 as uuidv4 } from 'uuid';
import { getDb } from './db.js';

// --- Types ---

export interface ScheduleConfig {
  type: 'interval' | 'cron' | 'once';
  intervalMs?: number;
  cron?: string;
  runAt?: number;
}

export interface RunResult {
  status: 'success' | 'error';
  summary: string;
  costUsd?: number;
  durationMs: number;
  startedAt: number;
  completedAt: number;
}

export interface ScheduledTask {
  id: string;
  name: string;
  prompt: string;
  schedule: ScheduleConfig;
  mode: string;
  status: 'active' | 'paused' | 'completed';
  notification: { type: 'log' | 'websocket' };
  lastRunAt: number | null;
  nextRunAt: number | null;
  runCount: number;
  errorCount: number;
  history: RunResult[];
  createdAt: number;
  updatedAt: number;
}

// --- DB Helpers ---

interface TaskRow {
  id: string;
  name: string;
  prompt: string;
  schedule: string;
  mode: string;
  status: string;
  notification: string;
  last_run_at: number | null;
  next_run_at: number | null;
  run_count: number;
  error_count: number;
  history: string;
  created_at: number;
  updated_at: number;
}

function rowToTask(row: TaskRow): ScheduledTask {
  return {
    id: row.id,
    name: row.name,
    prompt: row.prompt,
    schedule: JSON.parse(row.schedule),
    mode: row.mode,
    status: row.status as ScheduledTask['status'],
    notification: JSON.parse(row.notification),
    lastRunAt: row.last_run_at,
    nextRunAt: row.next_run_at,
    runCount: row.run_count,
    errorCount: row.error_count,
    history: JSON.parse(row.history),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// --- Schedule Calculation ---

export function calculateNextRun(task: ScheduledTask): number | null {
  const now = Date.now();

  switch (task.schedule.type) {
    case 'interval': {
      const interval = task.schedule.intervalMs!;
      const base = task.lastRunAt ?? task.createdAt;
      let next = base + interval;
      while (next <= now) {
        next += interval;
      }
      return next;
    }

    case 'cron': {
      return parseCronNext(task.schedule.cron!, now);
    }

    case 'once': {
      if (task.runCount > 0) return null;
      return task.schedule.runAt ?? null;
    }

    default:
      return null;
  }
}

function parseCronNext(cron: string, from: number): number {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return from + 60000;

  const [minSpec, hourSpec, , , dowSpec] = parts;
  const now = new Date(from);

  const targetMin = minSpec === '*' ? -1 : parseInt(minSpec, 10);
  const targetHour = hourSpec === '*' ? -1 : parseInt(hourSpec, 10);
  const targetDow = dowSpec === '*' ? -1 : parseInt(dowSpec, 10);

  const candidate = new Date(now);
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);

  for (let i = 0; i < 60 * 24 * 8; i++) {
    const matches =
      (targetMin === -1 || candidate.getMinutes() === targetMin) &&
      (targetHour === -1 || candidate.getHours() === targetHour) &&
      (targetDow === -1 || candidate.getDay() === targetDow);

    if (matches) {
      return candidate.getTime();
    }
    candidate.setMinutes(candidate.getMinutes() + 1);
  }

  return from + 3600000;
}

// --- Natural Language Schedule Parsing ---

export function parseNaturalSchedule(text: string): ScheduleConfig | null {
  const lower = text.toLowerCase().trim();

  const intervalMatch = lower.match(/every\s+(\d+)\s*(minute|min|hour|hr|second|sec)s?/);
  if (intervalMatch) {
    const amount = parseInt(intervalMatch[1], 10);
    const unit = intervalMatch[2];
    let ms: number;
    if (unit.startsWith('sec')) ms = amount * 1000;
    else if (unit.startsWith('min')) ms = amount * 60 * 1000;
    else ms = amount * 60 * 60 * 1000;
    return { type: 'interval', intervalMs: ms };
  }

  if (/every\s+hour/.test(lower)) {
    return { type: 'interval', intervalMs: 3600000 };
  }

  if (/every\s+minute/.test(lower)) {
    return { type: 'interval', intervalMs: 60000 };
  }

  const dailyMatch = lower.match(/every\s+day\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
  if (dailyMatch) {
    let hour = parseInt(dailyMatch[1], 10);
    const min = dailyMatch[2] ? parseInt(dailyMatch[2], 10) : 0;
    if (dailyMatch[3] === 'pm' && hour < 12) hour += 12;
    if (dailyMatch[3] === 'am' && hour === 12) hour = 0;
    return { type: 'cron', cron: `${min} ${hour} * * *` };
  }

  const weekdayMap: Record<string, number> = {
    sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
    sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
  };
  const weeklyMatch = lower.match(/every\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
  if (weeklyMatch) {
    const dow = weekdayMap[weeklyMatch[1]];
    let hour = parseInt(weeklyMatch[2], 10);
    const min = weeklyMatch[3] ? parseInt(weeklyMatch[3], 10) : 0;
    if (weeklyMatch[4] === 'pm' && hour < 12) hour += 12;
    if (weeklyMatch[4] === 'am' && hour === 12) hour = 0;
    return { type: 'cron', cron: `${min} ${hour} * * ${dow}` };
  }

  const inMatch = lower.match(/in\s+(\d+)\s*(minute|min|hour|hr|second|sec)s?/);
  if (inMatch) {
    const amount = parseInt(inMatch[1], 10);
    const unit = inMatch[2];
    let ms: number;
    if (unit.startsWith('sec')) ms = amount * 1000;
    else if (unit.startsWith('min')) ms = amount * 60 * 1000;
    else ms = amount * 60 * 60 * 1000;
    return { type: 'once', runAt: Date.now() + ms };
  }

  return null;
}

// --- Task CRUD ---

export function createTask(name: string, prompt: string, schedule: ScheduleConfig, mode: string = 'auto'): ScheduledTask {
  const db = getDb();
  const now = Date.now();
  const id = uuidv4();

  const task: ScheduledTask = {
    id,
    name,
    prompt,
    schedule,
    mode,
    status: 'active',
    notification: { type: 'log' },
    lastRunAt: null,
    nextRunAt: null,
    runCount: 0,
    errorCount: 0,
    history: [],
    createdAt: now,
    updatedAt: now,
  };
  task.nextRunAt = calculateNextRun(task);

  db.prepare(`
    INSERT INTO scheduled_tasks (id, name, prompt, schedule, mode, status, notification, last_run_at, next_run_at, run_count, error_count, history, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, name, prompt, JSON.stringify(schedule), mode, 'active',
    JSON.stringify(task.notification), null, task.nextRunAt,
    0, 0, '[]', now, now,
  );

  return task;
}

export function listTasks(): ScheduledTask[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC').all() as TaskRow[];
  return rows.map(rowToTask);
}

export function getTask(id: string): ScheduledTask | undefined {
  const db = getDb();
  const row = db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as TaskRow | undefined;
  return row ? rowToTask(row) : undefined;
}

export function pauseTask(id: string): boolean {
  const db = getDb();
  const result = db.prepare('UPDATE scheduled_tasks SET status = ?, updated_at = ? WHERE id = ?').run('paused', Date.now(), id);
  return result.changes > 0;
}

export function resumeTask(id: string): boolean {
  const db = getDb();
  const row = db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as TaskRow | undefined;
  if (!row) return false;

  const task = rowToTask(row);
  task.status = 'active';
  task.nextRunAt = calculateNextRun(task);

  db.prepare('UPDATE scheduled_tasks SET status = ?, next_run_at = ?, updated_at = ? WHERE id = ?')
    .run('active', task.nextRunAt, Date.now(), id);

  return true;
}

export function deleteTask(id: string): boolean {
  const db = getDb();
  const result = db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
  return result.changes > 0;
}

export function getTaskHistory(id: string): RunResult[] {
  const task = getTask(id);
  return task?.history ?? [];
}

export function recordTaskRun(id: string, result: RunResult): void {
  const db = getDb();
  const row = db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as TaskRow | undefined;
  if (!row) return;

  const task = rowToTask(row);
  task.lastRunAt = result.completedAt;
  task.runCount++;
  if (result.status === 'error') task.errorCount++;

  task.history.push(result);
  if (task.history.length > 50) {
    task.history = task.history.slice(-50);
  }

  task.nextRunAt = calculateNextRun(task);

  if (task.schedule.type === 'once') {
    task.status = 'completed';
  }

  db.prepare(`
    UPDATE scheduled_tasks SET last_run_at = ?, run_count = ?, error_count = ?, history = ?, next_run_at = ?, status = ?, updated_at = ?
    WHERE id = ?
  `).run(task.lastRunAt, task.runCount, task.errorCount, JSON.stringify(task.history), task.nextRunAt, task.status, Date.now(), id);
}

// --- Scheduler Loop ---

let schedulerTimer: ReturnType<typeof setInterval> | null = null;

export function startScheduler(runFn: (task: ScheduledTask) => Promise<RunResult>): void {
  if (schedulerTimer) return;

  console.log('[scheduler] Starting scheduler loop (30s interval)');

  schedulerTimer = setInterval(async () => {
    const tasks = listTasks();
    const now = Date.now();

    for (const task of tasks) {
      if (task.status !== 'active') continue;
      if (!task.nextRunAt || task.nextRunAt > now) continue;

      console.log(`[scheduler] Executing task: ${task.name} (${task.id})`);

      try {
        const result = await runFn(task);
        recordTaskRun(task.id, result);
        console.log(`[scheduler] Task "${task.name}" completed: ${result.status} (${result.durationMs}ms)`);
      } catch (err) {
        const errorResult: RunResult = {
          status: 'error',
          summary: (err as Error).message,
          durationMs: 0,
          startedAt: now,
          completedAt: Date.now(),
        };
        recordTaskRun(task.id, errorResult);
        console.error(`[scheduler] Task "${task.name}" failed:`, (err as Error).message);
      }
    }
  }, 30000);
}

export function stopScheduler(): void {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
    console.log('[scheduler] Scheduler stopped');
  }
}
