import { platform } from 'node:os';

interface InputDriver {
  click(x: number, y: number): Promise<void>;
  doubleClick(x: number, y: number): Promise<void>;
  rightClick(x: number, y: number): Promise<void>;
  moveTo(x: number, y: number): Promise<void>;
  drag(fromX: number, fromY: number, toX: number, toY: number): Promise<void>;
  dragSmooth(fromX: number, fromY: number, toX: number, toY: number, steps?: number, durationMs?: number): Promise<void>;
  moveSmooth(toX: number, toY: number, fromX: number, fromY: number, steps?: number, durationMs?: number): Promise<void>;
  type(text: string): Promise<void>;
  keyPress(key: string): Promise<void>;
  keyDown(key: string): Promise<void>;
  keyUp(key: string): Promise<void>;
  scroll(x: number, y: number, dy: number): Promise<void>;
}

let driver: InputDriver | null = null;

async function getDriver(): Promise<InputDriver> {
  if (driver) return driver;

  const os = platform();
  if (os === 'win32') {
    driver = await import('./input-windows.js');
  } else if (os === 'darwin') {
    driver = await import('./input-macos.js');
  } else {
    throw new Error(`Unsupported platform: ${os}. Only macOS and Windows are supported.`);
  }

  return driver;
}

export async function click(x: number, y: number): Promise<void> {
  return (await getDriver()).click(x, y);
}

export async function doubleClick(x: number, y: number): Promise<void> {
  return (await getDriver()).doubleClick(x, y);
}

export async function rightClick(x: number, y: number): Promise<void> {
  return (await getDriver()).rightClick(x, y);
}

export async function moveTo(x: number, y: number): Promise<void> {
  return (await getDriver()).moveTo(x, y);
}

export async function type(text: string): Promise<void> {
  return (await getDriver()).type(text);
}

export async function keyPress(key: string): Promise<void> {
  return (await getDriver()).keyPress(key);
}

export async function keyDown(key: string): Promise<void> {
  return (await getDriver()).keyDown(key);
}

export async function keyUp(key: string): Promise<void> {
  return (await getDriver()).keyUp(key);
}

export async function drag(fromX: number, fromY: number, toX: number, toY: number): Promise<void> {
  return (await getDriver()).drag(fromX, fromY, toX, toY);
}

export async function dragSmooth(fromX: number, fromY: number, toX: number, toY: number, steps?: number, durationMs?: number): Promise<void> {
  return (await getDriver()).dragSmooth(fromX, fromY, toX, toY, steps, durationMs);
}

export async function moveSmooth(toX: number, toY: number, fromX: number, fromY: number, steps?: number, durationMs?: number): Promise<void> {
  return (await getDriver()).moveSmooth(toX, toY, fromX, fromY, steps, durationMs);
}

export async function scroll(x: number, y: number, dy: number): Promise<void> {
  return (await getDriver()).scroll(x, y, dy);
}
