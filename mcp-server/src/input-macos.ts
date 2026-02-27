import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { generatePath, computeDelays } from './motion.js';

const execFileAsync = promisify(execFile);

const CLICLICK = 'cliclick';

async function run(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(CLICLICK, args);
  return stdout.trim();
}

export async function click(x: number, y: number): Promise<void> {
  await run(`c:${Math.round(x)},${Math.round(y)}`);
}

export async function doubleClick(x: number, y: number): Promise<void> {
  await run(`dc:${Math.round(x)},${Math.round(y)}`);
}

export async function rightClick(x: number, y: number): Promise<void> {
  await run(`rc:${Math.round(x)},${Math.round(y)}`);
}

export async function moveTo(x: number, y: number): Promise<void> {
  await run(`m:${Math.round(x)},${Math.round(y)}`);
}

export async function type(text: string): Promise<void> {
  await run(`t:${text}`);
}

export async function keyPress(key: string): Promise<void> {
  await run(`kp:${key}`);
}

export async function keyDown(key: string): Promise<void> {
  await run(`kd:${key}`);
}

export async function keyUp(key: string): Promise<void> {
  await run(`ku:${key}`);
}

export async function drag(fromX: number, fromY: number, toX: number, toY: number): Promise<void> {
  await run(
    `dd:${Math.round(fromX)},${Math.round(fromY)}`,
    'w:50',
    `dm:${Math.round(toX)},${Math.round(toY)}`,
    'w:50',
    `du:${Math.round(toX)},${Math.round(toY)}`
  );
}

/**
 * Smooth multi-step drag using bezier-eased path.
 * Chains all cliclick commands in a single invocation.
 */
export async function dragSmooth(
  fromX: number, fromY: number, toX: number, toY: number,
  steps: number = 20, durationMs: number = 500,
): Promise<void> {
  const path = generatePath(
    { x: fromX, y: fromY },
    { x: toX, y: toY },
    { steps, durationMs, easing: 'easeInOutCubic' },
  );
  const delays = computeDelays(path);

  const args: string[] = [`dd:${Math.round(path[0].x)},${Math.round(path[0].y)}`];
  for (let i = 1; i < path.length; i++) {
    const delay = Math.max(1, delays[i - 1]);
    args.push(`w:${delay}`, `dm:${Math.round(path[i].x)},${Math.round(path[i].y)}`);
  }
  const last = path[path.length - 1];
  args.push(`w:10`, `du:${Math.round(last.x)},${Math.round(last.y)}`);

  await run(...args);
}

/**
 * Smooth cursor movement (no button held) using bezier-eased path.
 * Uses easeOutCubic for natural deceleration-to-target feel.
 */
export async function moveSmooth(
  toX: number, toY: number, fromX: number, fromY: number,
  steps: number = 15, durationMs: number = 300,
): Promise<void> {
  const path = generatePath(
    { x: fromX, y: fromY },
    { x: toX, y: toY },
    { steps, durationMs, easing: 'easeOutCubic' },
  );
  const delays = computeDelays(path);

  const args: string[] = [];
  for (let i = 0; i < path.length; i++) {
    if (i > 0) {
      args.push(`w:${Math.max(1, delays[i - 1])}`);
    }
    args.push(`m:${Math.round(path[i].x)},${Math.round(path[i].y)}`);
  }

  await run(...args);
}

/**
 * Scroll using cliclick. Positive dy = scroll down, negative = scroll up.
 */
export async function scroll(x: number, y: number, dy: number): Promise<void> {
  // Move to position first, then use key presses for scrolling
  // cliclick doesn't have native scroll, so we'll use the CDP approach as fallback
  await moveTo(x, y);
  const direction = dy > 0 ? 'arrow-down' : 'arrow-up';
  const steps = Math.abs(Math.round(dy / 3));
  for (let i = 0; i < steps; i++) {
    await keyPress(direction);
  }
}
