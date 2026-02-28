import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { v4 as uuidv4 } from 'uuid';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../data');
const TASKS_FILE = path.join(DATA_DIR, 'scheduled-tasks.json');

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

interface TaskStore {
  version: 1;
  tasks: ScheduledTask[];
}

// --- Storage ---

function loadStore(): TaskStore {
  try {
    const raw = fs.readFileSync(TASKS_FILE, 'utf-8');
    return JSON.parse(raw) as TaskStore;
  } catch {
    return { version: 1, tasks: [] };
  }
}

function saveStore(store: TaskStore): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = TASKS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, TASKS_FILE);
}

// --- Schedule Calculation ---

export function calculateNextRun(task: ScheduledTask): number | null {
  const now = Date.now();

  switch (task.schedule.type) {
    case 'interval': {
      const interval = task.schedule.intervalMs!;
      const base = task.lastRunAt ?? task.createdAt;
      let next = base + interval;
      // If next is in the past, advance to next future occurrence
      while (next <= now) {
        next += interval;
      }
      return next;
    }

    case 'cron': {
      // Simple cron parsing for common patterns
      return parseCronNext(task.schedule.cron!, now);
    }

    case 'once': {
      if (task.runCount > 0) return null; // Already ran
      return task.schedule.runAt ?? null;
    }

    default:
      return null;
  }
}

function parseCronNext(cron: string, from: number): number {
  // Very simple cron parser supporting: minute hour dayOfMonth month dayOfWeek
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return from + 60000; // Default: 1 minute from now

  const [minSpec, hourSpec, , , dowSpec] = parts;
  const now = new Date(from);

  // Parse minute
  const targetMin = minSpec === '*' ? -1 : parseInt(minSpec, 10);
  // Parse hour
  const targetHour = hourSpec === '*' ? -1 : parseInt(hourSpec, 10);
  // Parse day of week (0=Sun, 6=Sat)
  const targetDow = dowSpec === '*' ? -1 : parseInt(dowSpec, 10);

  // Simple approach: iterate forward by minute until we find a match
  const candidate = new Date(now);
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1); // Start from next minute

  for (let i = 0; i < 60 * 24 * 8; i++) { // Max 8 days ahead
    const matches =
      (targetMin === -1 || candidate.getMinutes() === targetMin) &&
      (targetHour === -1 || candidate.getHours() === targetHour) &&
      (targetDow === -1 || candidate.getDay() === targetDow);

    if (matches) {
      return candidate.getTime();
    }
    candidate.setMinutes(candidate.getMinutes() + 1);
  }

  return from + 3600000; // Fallback: 1 hour
}

// --- Natural Language Schedule Parsing ---

export function parseNaturalSchedule(text: string): ScheduleConfig | null {
  const lower = text.toLowerCase().trim();

  // "every X minutes/hours"
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

  // "every hour"
  if (/every\s+hour/.test(lower)) {
    return { type: 'interval', intervalMs: 3600000 };
  }

  // "every minute"
  if (/every\s+minute/.test(lower)) {
    return { type: 'interval', intervalMs: 60000 };
  }

  // "every day at Xam/pm"
  const dailyMatch = lower.match(/every\s+day\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
  if (dailyMatch) {
    let hour = parseInt(dailyMatch[1], 10);
    const min = dailyMatch[2] ? parseInt(dailyMatch[2], 10) : 0;
    if (dailyMatch[3] === 'pm' && hour < 12) hour += 12;
    if (dailyMatch[3] === 'am' && hour === 12) hour = 0;
    return { type: 'cron', cron: `${min} ${hour} * * *` };
  }

  // "every Monday/Tuesday/... at Xam/pm"
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

  // "in X minutes/hours"
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
  const store = loadStore();
  const task: ScheduledTask = {
    id: uuidv4(),
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
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  task.nextRunAt = calculateNextRun(task);
  store.tasks.push(task);
  saveStore(store);
  return task;
}

export function listTasks(): ScheduledTask[] {
  return loadStore().tasks;
}

export function getTask(id: string): ScheduledTask | undefined {
  return loadStore().tasks.find((t) => t.id === id);
}

export function pauseTask(id: string): boolean {
  const store = loadStore();
  const task = store.tasks.find((t) => t.id === id);
  if (!task) return false;
  task.status = 'paused';
  task.updatedAt = Date.now();
  saveStore(store);
  return true;
}

export function resumeTask(id: string): boolean {
  const store = loadStore();
  const task = store.tasks.find((t) => t.id === id);
  if (!task) return false;
  task.status = 'active';
  task.nextRunAt = calculateNextRun(task);
  task.updatedAt = Date.now();
  saveStore(store);
  return true;
}

export function deleteTask(id: string): boolean {
  const store = loadStore();
  const index = store.tasks.findIndex((t) => t.id === id);
  if (index === -1) return false;
  store.tasks.splice(index, 1);
  saveStore(store);
  return true;
}

export function getTaskHistory(id: string): RunResult[] {
  const task = getTask(id);
  return task?.history ?? [];
}

export function recordTaskRun(id: string, result: RunResult): void {
  const store = loadStore();
  const task = store.tasks.find((t) => t.id === id);
  if (!task) return;

  task.lastRunAt = result.completedAt;
  task.runCount++;
  if (result.status === 'error') task.errorCount++;

  // Keep last 50 history entries
  task.history.push(result);
  if (task.history.length > 50) {
    task.history = task.history.slice(-50);
  }

  task.nextRunAt = calculateNextRun(task);

  // Mark 'once' tasks as completed
  if (task.schedule.type === 'once') {
    task.status = 'completed';
  }

  task.updatedAt = Date.now();
  saveStore(store);
}

// --- Scheduler Loop ---

let schedulerTimer: ReturnType<typeof setInterval> | null = null;

export function startScheduler(runFn: (task: ScheduledTask) => Promise<RunResult>): void {
  if (schedulerTimer) return;

  console.log('[scheduler] Starting scheduler loop (30s interval)');

  schedulerTimer = setInterval(async () => {
    const store = loadStore();
    const now = Date.now();

    for (const task of store.tasks) {
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
