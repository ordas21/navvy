import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { generatePath, computeDelays } from './motion.js';

const execFileAsync = promisify(execFile);

const PS_FLAGS = ['-NoProfile', '-NonInteractive', '-Command'];

async function ps(script: string): Promise<string> {
  const { stdout } = await execFileAsync('powershell.exe', [...PS_FLAGS, script]);
  return stdout.trim();
}

// P/Invoke declarations for mouse input
const MOUSE_SETUP = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinInput {
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, IntPtr dwExtraInfo);
    public const uint MOUSEEVENTF_LEFTDOWN   = 0x0002;
    public const uint MOUSEEVENTF_LEFTUP     = 0x0004;
    public const uint MOUSEEVENTF_RIGHTDOWN  = 0x0008;
    public const uint MOUSEEVENTF_RIGHTUP    = 0x0010;
}
"@
`;

async function mouseClick(x: number, y: number, right = false): Promise<void> {
  const down = right ? 'MOUSEEVENTF_RIGHTDOWN' : 'MOUSEEVENTF_LEFTDOWN';
  const up = right ? 'MOUSEEVENTF_RIGHTUP' : 'MOUSEEVENTF_LEFTUP';
  await ps(`${MOUSE_SETUP}
[WinInput]::SetCursorPos(${Math.round(x)}, ${Math.round(y)})
[WinInput]::mouse_event([WinInput]::${down}, 0, 0, 0, [IntPtr]::Zero)
[WinInput]::mouse_event([WinInput]::${up}, 0, 0, 0, [IntPtr]::Zero)`);
}

export async function click(x: number, y: number): Promise<void> {
  await mouseClick(x, y);
}

export async function doubleClick(x: number, y: number): Promise<void> {
  await mouseClick(x, y);
  await mouseClick(x, y);
}

export async function rightClick(x: number, y: number): Promise<void> {
  await mouseClick(x, y, true);
}

export async function moveTo(x: number, y: number): Promise<void> {
  await ps(`${MOUSE_SETUP}
[WinInput]::SetCursorPos(${Math.round(x)}, ${Math.round(y)})`);
}

export async function drag(fromX: number, fromY: number, toX: number, toY: number): Promise<void> {
  await ps(`${MOUSE_SETUP}
[WinInput]::SetCursorPos(${Math.round(fromX)}, ${Math.round(fromY)})
[WinInput]::mouse_event([WinInput]::MOUSEEVENTF_LEFTDOWN, 0, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds 50
[WinInput]::SetCursorPos(${Math.round(toX)}, ${Math.round(toY)})
Start-Sleep -Milliseconds 50
[WinInput]::mouse_event([WinInput]::MOUSEEVENTF_LEFTUP, 0, 0, 0, [IntPtr]::Zero)`);
}

/**
 * Smooth multi-step drag using bezier-eased path.
 * Generates a single PowerShell script for the entire motion.
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

  const lines = [MOUSE_SETUP];
  lines.push(`[WinInput]::SetCursorPos(${Math.round(path[0].x)}, ${Math.round(path[0].y)})`);
  lines.push(`[WinInput]::mouse_event([WinInput]::MOUSEEVENTF_LEFTDOWN, 0, 0, 0, [IntPtr]::Zero)`);

  for (let i = 1; i < path.length; i++) {
    const delay = Math.max(1, delays[i - 1]);
    lines.push(`Start-Sleep -Milliseconds ${delay}`);
    lines.push(`[WinInput]::SetCursorPos(${Math.round(path[i].x)}, ${Math.round(path[i].y)})`);
  }

  lines.push(`Start-Sleep -Milliseconds 10`);
  lines.push(`[WinInput]::mouse_event([WinInput]::MOUSEEVENTF_LEFTUP, 0, 0, 0, [IntPtr]::Zero)`);

  await ps(lines.join('\n'));
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

  const lines = [MOUSE_SETUP];
  for (let i = 0; i < path.length; i++) {
    if (i > 0) {
      lines.push(`Start-Sleep -Milliseconds ${Math.max(1, delays[i - 1])}`);
    }
    lines.push(`[WinInput]::SetCursorPos(${Math.round(path[i].x)}, ${Math.round(path[i].y)})`);
  }

  await ps(lines.join('\n'));
}

// Key mapping from cliclick names to SendKeys tokens
const KEY_MAP: Record<string, string> = {
  'return': '{ENTER}',
  'tab': '{TAB}',
  'escape': '{ESC}',
  'space': ' ',
  'delete': '{DELETE}',
  'backspace': '{BACKSPACE}',
  'arrow-up': '{UP}',
  'arrow-down': '{DOWN}',
  'arrow-left': '{LEFT}',
  'arrow-right': '{RIGHT}',
  'home': '{HOME}',
  'end': '{END}',
  'page-up': '{PGUP}',
  'page-down': '{PGDN}',
  'f1': '{F1}', 'f2': '{F2}', 'f3': '{F3}', 'f4': '{F4}',
  'f5': '{F5}', 'f6': '{F6}', 'f7': '{F7}', 'f8': '{F8}',
  'f9': '{F9}', 'f10': '{F10}', 'f11': '{F11}', 'f12': '{F12}',
};

/** Escape special SendKeys characters: +^%~(){}[] */
function escapeSendKeys(text: string): string {
  return text.replace(/([+^%~(){}[\]])/g, '{$1}');
}

function sendKeysScript(keys: string): string {
  return `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${keys.replace(/'/g, "''")}')`;
}

export async function type(text: string): Promise<void> {
  const escaped = escapeSendKeys(text);
  await ps(sendKeysScript(escaped));
}

export async function keyPress(key: string): Promise<void> {
  const mapped = KEY_MAP[key] ?? `{${key.toUpperCase()}}`;
  await ps(sendKeysScript(mapped));
}

export async function keyDown(key: string): Promise<void> {
  // SendKeys does not support hold-down natively; simulate a press
  await keyPress(key);
}

export async function keyUp(_key: string): Promise<void> {
  // SendKeys does not support separate key-up; no-op after keyDown press
}

/**
 * Scroll using keyboard arrows. Positive dy = scroll down, negative = scroll up.
 */
export async function scroll(x: number, y: number, dy: number): Promise<void> {
  await moveTo(x, y);
  const direction = dy > 0 ? 'arrow-down' : 'arrow-up';
  const steps = Math.abs(Math.round(dy / 3));
  for (let i = 0; i < steps; i++) {
    await keyPress(direction);
  }
}
