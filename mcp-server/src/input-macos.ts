import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

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
