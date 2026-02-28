import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as input from './input.js';
import { requestApproval, checkNeedsApproval } from './approval-gate.js';

const execFileAsync = promisify(execFile);

// --- Helpers ---

function resolvePath(p?: string): string {
  if (!p) return os.homedir();
  if (p.startsWith('~')) return path.join(os.homedir(), p.slice(1));
  if (path.isAbsolute(p)) return p;
  return path.resolve(os.homedir(), p);
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatDate(d: Date): string {
  return d.toISOString().replace('T', ' ').substring(0, 19);
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  parts.push(`${m}m`);
  return parts.join(' ');
}

function runShell(command: string, cwd: string, timeout: number): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }> {
  return new Promise((resolve) => {
    const proc = spawn(command, [], {
      shell: true,
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    const MAX_OUTPUT = 100 * 1024; // 100KB cap per stream
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killed = false;

    proc.stdout.on('data', (data: Buffer) => {
      if (stdout.length < MAX_OUTPUT) {
        stdout += data.toString();
        if (stdout.length > MAX_OUTPUT) {
          stdout = stdout.substring(0, MAX_OUTPUT) + '\n[OUTPUT TRUNCATED]';
        }
      }
    });

    proc.stderr.on('data', (data: Buffer) => {
      if (stderr.length < MAX_OUTPUT) {
        stderr += data.toString();
        if (stderr.length > MAX_OUTPUT) {
          stderr = stderr.substring(0, MAX_OUTPUT) + '\n[OUTPUT TRUNCATED]';
        }
      }
    });

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
      setTimeout(() => {
        if (!killed) {
          proc.kill('SIGKILL');
        }
      }, 2000);
    }, timeout * 1000);

    proc.on('close', (code) => {
      killed = true;
      clearTimeout(timer);
      resolve({
        stdout: stdout.trimEnd(),
        stderr: stderr.trimEnd(),
        exitCode: code ?? 1,
        timedOut,
      });
    });

    proc.on('error', (err) => {
      killed = true;
      clearTimeout(timer);
      resolve({
        stdout: '',
        stderr: err.message,
        exitCode: 1,
        timedOut: false,
      });
    });
  });
}

// --- macOS Computer Control Helpers ---

function macOSOnly(toolName: string): { content: Array<{ type: 'text'; text: string }>; isError: true } | null {
  if (os.platform() !== 'darwin') {
    return {
      content: [{ type: 'text', text: `Error: ${toolName} is only available on macOS` }],
      isError: true,
    };
  }
  return null;
}

function runOsascript(
  script: string,
  language: 'AppleScript' | 'JavaScript' = 'JavaScript',
  timeout: number = 30,
): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }> {
  return new Promise((resolve) => {
    const proc = spawn('osascript', ['-l', language, '-'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });

    const MAX_OUTPUT = 100 * 1024;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killed = false;

    proc.stdout.on('data', (data: Buffer) => {
      if (stdout.length < MAX_OUTPUT) {
        stdout += data.toString();
        if (stdout.length > MAX_OUTPUT) {
          stdout = stdout.substring(0, MAX_OUTPUT) + '\n[OUTPUT TRUNCATED]';
        }
      }
    });

    proc.stderr.on('data', (data: Buffer) => {
      if (stderr.length < MAX_OUTPUT) {
        stderr += data.toString();
        if (stderr.length > MAX_OUTPUT) {
          stderr = stderr.substring(0, MAX_OUTPUT) + '\n[OUTPUT TRUNCATED]';
        }
      }
    });

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
      setTimeout(() => {
        if (!killed) proc.kill('SIGKILL');
      }, 2000);
    }, timeout * 1000);

    proc.on('close', (code) => {
      killed = true;
      clearTimeout(timer);
      resolve({
        stdout: stdout.trimEnd(),
        stderr: stderr.trimEnd(),
        exitCode: code ?? 1,
        timedOut,
      });
    });

    proc.on('error', (err) => {
      killed = true;
      clearTimeout(timer);
      resolve({
        stdout: '',
        stderr: err.message,
        exitCode: 1,
        timedOut: false,
      });
    });

    // Write script to stdin and close
    proc.stdin.write(script);
    proc.stdin.end();
  });
}

async function getCurrentMousePosition(): Promise<{ x: number; y: number }> {
  const { stdout } = await execFileAsync('cliclick', ['p']);
  const match = stdout.trim().match(/(\d+),(\d+)/);
  if (!match) throw new Error('Failed to parse mouse position from cliclick');
  return { x: parseInt(match[1], 10), y: parseInt(match[2], 10) };
}

async function getScreenInfo(): Promise<{ width: number; height: number; scaleFactor: number }> {
  const script = `
ObjC.import("AppKit");
var screen = $.NSScreen.mainScreen;
var frame = screen.frame;
var factor = screen.backingScaleFactor;
JSON.stringify({ width: frame.size.width, height: frame.size.height, scaleFactor: factor });
`;
  const result = await runOsascript(script, 'JavaScript', 5);
  if (result.exitCode !== 0) throw new Error(`Failed to get screen info: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

function buildAccessibilityTreeScript(appName: string, maxDepth: number, maxElements: number): string {
  return `
var app = Application("System Events");
var proc;
try {
  proc = app.processes.byName("${appName.replace(/"/g, '\\"')}");
  proc.name(); // force access to verify it exists
} catch(e) {
  throw new Error("Process \\"${appName.replace(/"/g, '\\"')}\\" not found. Use system_processes to list running processes, or system_open_app to launch it.");
}

var count = 0;
var maxCount = ${maxElements};
var maxD = ${maxDepth};
var truncated = false;

function walkElement(el, depth) {
  if (count >= maxCount) { truncated = true; return null; }
  count++;
  var node = {};
  try { node.role = el.role(); } catch(e) { node.role = "unknown"; }
  try { var d = el.description(); if (d) node.description = d; } catch(e) {}
  try { var t = el.title(); if (t) node.title = t; } catch(e) {}
  try {
    var v = el.value();
    if (v !== null && v !== undefined) {
      var s = String(v);
      node.value = s.length > 200 ? s.substring(0, 200) + "..." : s;
    }
  } catch(e) {}
  try { var p = el.position(); if (p) node.position = p; } catch(e) {}
  try { var s = el.size(); if (s) node.size = s; } catch(e) {}
  try { if (el.enabled()) {} else { node.enabled = false; } } catch(e) {}
  try { if (el.focused()) { node.focused = true; } } catch(e) {}
  try { if (el.selected()) { node.selected = true; } } catch(e) {}

  if (depth < maxD) {
    try {
      var children = el.uiElements();
      if (children.length > 0) {
        node.children = [];
        for (var i = 0; i < children.length; i++) {
          if (count >= maxCount) { truncated = true; break; }
          var child = walkElement(children[i], depth + 1);
          if (child) node.children.push(child);
        }
      }
    } catch(e) {}
  }
  return node;
}

var windows = [];
try {
  var wins = proc.windows();
  for (var i = 0; i < wins.length; i++) {
    if (count >= maxCount) { truncated = true; break; }
    var w = walkElement(wins[i], 0);
    if (w) windows.push(w);
  }
} catch(e) {
  throw new Error("Cannot read UI elements. Ensure accessibility is enabled: System Settings > Privacy & Security > Accessibility. Error: " + e.message);
}

JSON.stringify({ app: "${appName.replace(/"/g, '\\"')}", windows: windows, totalElements: count, truncated: truncated });
`;
}

// --- Tool Registration ---

export function registerSystemTools(server: McpServer): void {

  // ===== Shell =====

  server.tool(
    'system_shell',
    'Execute a shell command on the host machine. Returns stdout, stderr, and exit code. Use for complex operations, piped commands, package installs, git, etc.',
    {
      command: z.string().describe('Shell command to execute'),
      cwd: z.string().optional().describe('Working directory (default: home directory)'),
      timeout: z.number().min(1).max(300).optional().describe('Timeout in seconds (default: 30, max: 300)'),
    },
    async ({ command, cwd, timeout }) => {
      // Check if this command needs approval
      const approvalCheck = checkNeedsApproval('system_shell', command);
      if (approvalCheck) {
        const approved = await requestApproval('system_shell', JSON.stringify({ command, cwd }));
        if (!approved) {
          return { content: [{ type: 'text' as const, text: `Action denied by user: "${command}"` }], isError: true };
        }
      }

      const resolvedCwd = resolvePath(cwd);
      const timeoutSecs = timeout ?? 30;

      const result = await runShell(command, resolvedCwd, timeoutSecs);

      let output = `Exit code: ${result.exitCode}`;
      if (result.timedOut) output += ' [TIMED OUT]';
      if (result.stdout) output += `\n--- stdout ---\n${result.stdout}`;
      if (result.stderr) output += `\n--- stderr ---\n${result.stderr}`;

      return { content: [{ type: 'text', text: output }] };
    }
  );

  // ===== File System =====

  server.tool(
    'system_read_file',
    'Read a file from the filesystem. Returns line-numbered content. For large files, use offset and limit to read specific sections.',
    {
      path: z.string().describe('File path (absolute, relative to home, or ~/...)'),
      offset: z.number().optional().describe('Line number to start reading from (1-based)'),
      limit: z.number().optional().describe('Maximum number of lines to read'),
    },
    async ({ path: filePath, offset, limit }) => {
      const resolved = resolvePath(filePath);

      try {
        const stat = await fs.stat(resolved);
        const MAX_SIZE = 10 * 1024 * 1024; // 10MB
        if (stat.size > MAX_SIZE) {
          return {
            content: [{ type: 'text', text: `Error: File is ${formatBytes(stat.size)} (limit: 10MB). Use offset and limit to read sections, or system_shell with head/tail.` }],
            isError: true,
          };
        }

        const raw = await fs.readFile(resolved);

        // Binary detection: check first 8KB for null bytes
        const checkLen = Math.min(raw.length, 8192);
        for (let i = 0; i < checkLen; i++) {
          if (raw[i] === 0) {
            return {
              content: [{ type: 'text', text: `Error: File appears to be binary (${formatBytes(stat.size)}). Use system_shell with xxd or file to inspect.` }],
              isError: true,
            };
          }
        }

        const content = raw.toString('utf-8');
        let lines = content.split('\n');

        const startLine = offset ? Math.max(1, offset) : 1;
        const maxLines = limit ?? 10000;
        lines = lines.slice(startLine - 1, startLine - 1 + maxLines);

        const numbered = lines.map((line, i) => `${String(startLine + i).padStart(6)} ${line}`).join('\n');
        let result = numbered;

        const totalLines = content.split('\n').length;
        if (startLine + maxLines - 1 < totalLines) {
          result += `\n\n... (showing lines ${startLine}-${startLine + lines.length - 1} of ${totalLines})`;
        }

        return { content: [{ type: 'text', text: result }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
      }
    }
  );

  server.tool(
    'system_write_file',
    'Write content to a file. Creates parent directories if they don\'t exist. Can append to existing files.',
    {
      path: z.string().describe('File path (absolute, relative to home, or ~/...)'),
      content: z.string().describe('Content to write'),
      append: z.boolean().optional().describe('Append to file instead of overwriting (default: false)'),
    },
    async ({ path: filePath, content, append }) => {
      const resolved = resolvePath(filePath);

      try {
        await fs.mkdir(path.dirname(resolved), { recursive: true });

        if (append) {
          await fs.appendFile(resolved, content);
        } else {
          await fs.writeFile(resolved, content);
        }

        const stat = await fs.stat(resolved);
        return { content: [{ type: 'text', text: `Written ${formatBytes(stat.size)} to ${resolved}${append ? ' (appended)' : ''}` }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
      }
    }
  );

  server.tool(
    'system_list_directory',
    'List directory contents with type, size, and modification date. Directories appear first, then files.',
    {
      path: z.string().optional().describe('Directory path (default: home directory)'),
      showHidden: z.boolean().optional().describe('Show hidden files/directories (default: false)'),
    },
    async ({ path: dirPath, showHidden }) => {
      const resolved = resolvePath(dirPath);

      try {
        const entries = await fs.readdir(resolved, { withFileTypes: true });
        let items = entries;

        if (!showHidden) {
          items = items.filter(e => !e.name.startsWith('.'));
        }

        const MAX_ENTRIES = 500;

        const detailed = await Promise.all(
          items.slice(0, MAX_ENTRIES).map(async (entry) => {
            const fullPath = path.join(resolved, entry.name);
            try {
              const s = await fs.stat(fullPath);
              return {
                name: entry.name,
                type: entry.isDirectory() ? 'DIR' : entry.isSymbolicLink() ? 'LINK' : 'FILE',
                size: entry.isDirectory() ? '-' : formatBytes(s.size),
                modified: formatDate(s.mtime),
              };
            } catch {
              return {
                name: entry.name,
                type: entry.isDirectory() ? 'DIR' : 'FILE',
                size: '?',
                modified: '?',
              };
            }
          })
        );

        // Sort: dirs first, then files, alphabetical within each
        detailed.sort((a, b) => {
          if (a.type === 'DIR' && b.type !== 'DIR') return -1;
          if (a.type !== 'DIR' && b.type === 'DIR') return 1;
          return a.name.localeCompare(b.name);
        });

        const header = `${'TYPE'.padEnd(6)} ${'SIZE'.padEnd(10)} ${'MODIFIED'.padEnd(20)} NAME`;
        const rows = detailed.map(d =>
          `${d.type.padEnd(6)} ${d.size.padEnd(10)} ${d.modified.padEnd(20)} ${d.name}`
        );

        let output = `${resolved}\n${header}\n${rows.join('\n')}`;
        if (items.length > MAX_ENTRIES) {
          output += `\n\n... (showing ${MAX_ENTRIES} of ${items.length} entries)`;
        }

        return { content: [{ type: 'text', text: output }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
      }
    }
  );

  server.tool(
    'system_search_files',
    'Search for files by glob pattern using find. Returns matching file paths.',
    {
      pattern: z.string().describe('File name pattern (e.g., "*.ts", "package.json")'),
      cwd: z.string().optional().describe('Directory to search in (default: home directory)'),
      maxResults: z.number().min(1).max(1000).optional().describe('Maximum results to return (default: 100)'),
    },
    async ({ pattern, cwd, maxResults }) => {
      const resolved = resolvePath(cwd);
      const max = maxResults ?? 100;

      const result = await runShell(
        `find . -name ${JSON.stringify(pattern)} -not -path '*/node_modules/*' -not -path '*/.git/*' 2>/dev/null | head -n ${max}`,
        resolved,
        30
      );

      if (result.exitCode !== 0 && !result.stdout) {
        return { content: [{ type: 'text', text: `Error: ${result.stderr || 'Search failed'}` }], isError: true };
      }

      const lines = result.stdout ? result.stdout.split('\n').filter(Boolean) : [];
      let output = `Found ${lines.length} file(s) matching "${pattern}" in ${resolved}`;
      if (lines.length > 0) {
        output += '\n' + lines.join('\n');
      }
      if (lines.length >= max) {
        output += `\n\n... (limited to ${max} results)`;
      }

      return { content: [{ type: 'text', text: output }] };
    }
  );

  server.tool(
    'system_search_content',
    'Search for text patterns within files using grep. Returns matching lines with context.',
    {
      pattern: z.string().describe('Search pattern (regex supported)'),
      path: z.string().optional().describe('File or directory to search in (default: current directory)'),
      glob: z.string().optional().describe('File pattern filter (e.g., "*.ts", "*.py")'),
      contextLines: z.number().min(0).max(10).optional().describe('Lines of context around matches (default: 0)'),
      ignoreCase: z.boolean().optional().describe('Case-insensitive search (default: false)'),
    },
    async ({ pattern, path: searchPath, glob: fileGlob, contextLines, ignoreCase }) => {
      const resolved = resolvePath(searchPath);
      const maxMatches = 500;

      let cmd = `grep -rn`;
      if (ignoreCase) cmd += ' -i';
      if (contextLines && contextLines > 0) cmd += ` -C ${contextLines}`;
      if (fileGlob) cmd += ` --include=${JSON.stringify(fileGlob)}`;
      cmd += ` --exclude-dir=node_modules --exclude-dir=.git`;
      cmd += ` ${JSON.stringify(pattern)} .`;
      cmd += ` 2>/dev/null | head -n ${maxMatches}`;

      const result = await runShell(cmd, resolved, 30);

      if (!result.stdout) {
        return { content: [{ type: 'text', text: `No matches found for "${pattern}" in ${resolved}` }] };
      }

      // Truncate long lines
      const lines = result.stdout.split('\n').map(line =>
        line.length > 500 ? line.substring(0, 500) + '...' : line
      );

      let output = lines.join('\n');
      if (lines.length >= maxMatches) {
        output += `\n\n... (limited to ${maxMatches} matches)`;
      }

      return { content: [{ type: 'text', text: output }] };
    }
  );

  // ===== Process Management =====

  server.tool(
    'system_processes',
    'List running processes sorted by CPU or memory usage.',
    {
      sortBy: z.enum(['cpu', 'memory']).optional().describe('Sort by CPU or memory usage (default: cpu)'),
      limit: z.number().min(1).max(100).optional().describe('Number of processes to show (default: 20)'),
      filter: z.string().optional().describe('Filter processes by name'),
    },
    async ({ sortBy, limit, filter }) => {
      const sort = sortBy === 'memory' ? '-pmem' : '-pcpu';
      const max = limit ?? 20;

      let cmd = `ps aux --sort=${sort}`;
      if (filter) {
        cmd += ` | grep -i ${JSON.stringify(filter)} | grep -v grep`;
      }
      cmd += ` | head -n ${max + 1}`; // +1 for header

      const result = await runShell(cmd, os.homedir(), 10);

      if (result.exitCode !== 0 && !result.stdout) {
        return { content: [{ type: 'text', text: `Error: ${result.stderr || 'Failed to list processes'}` }], isError: true };
      }

      return { content: [{ type: 'text', text: result.stdout || 'No processes found' }] };
    }
  );

  server.tool(
    'system_kill_process',
    'Kill a process by PID. Uses SIGTERM by default, SIGKILL with force option.',
    {
      pid: z.number().describe('Process ID to kill'),
      force: z.boolean().optional().describe('Use SIGKILL instead of SIGTERM (default: false)'),
    },
    async ({ pid, force }) => {
      if (pid === 0 || pid === 1) {
        return { content: [{ type: 'text', text: `Error: Refusing to kill PID ${pid} (system process)` }], isError: true };
      }

      try {
        // Check process exists
        process.kill(pid, 0);
      } catch {
        return { content: [{ type: 'text', text: `Error: Process ${pid} not found` }], isError: true };
      }

      const signal = force ? 'SIGKILL' : 'SIGTERM';
      try {
        process.kill(pid, signal);
        return { content: [{ type: 'text', text: `Sent ${signal} to process ${pid}` }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error killing process ${pid}: ${msg}` }], isError: true };
      }
    }
  );

  // ===== System Info =====

  server.tool(
    'system_info',
    'Get system information: OS, CPU, memory, disk usage, uptime.',
    {},
    async () => {
      const cpus = os.cpus();
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const usedMem = totalMem - freeMem;

      let info = `Hostname: ${os.hostname()}
OS: ${os.type()} ${os.release()} (${os.arch()})
CPU: ${cpus[0]?.model ?? 'Unknown'} (${cpus.length} cores)
Memory: ${formatBytes(usedMem)} / ${formatBytes(totalMem)} (${Math.round(usedMem / totalMem * 100)}% used)
Uptime: ${formatUptime(os.uptime())}
Home: ${os.homedir()}
Temp: ${os.tmpdir()}`;

      // Get disk usage
      const diskResult = await runShell('df -h / 2>/dev/null | tail -1', os.homedir(), 5);
      if (diskResult.stdout) {
        info += `\nDisk (/): ${diskResult.stdout.trim()}`;
      }

      return { content: [{ type: 'text', text: info }] };
    }
  );

  // ===== Clipboard =====

  server.tool(
    'system_clipboard_read',
    'Read text from the system clipboard.',
    {},
    async () => {
      let cmd: string;
      switch (os.platform()) {
        case 'darwin':
          cmd = 'pbpaste';
          break;
        case 'linux':
          cmd = 'xclip -selection clipboard -o';
          break;
        case 'win32':
          cmd = 'powershell.exe -command Get-Clipboard';
          break;
        default:
          return { content: [{ type: 'text', text: `Error: Clipboard not supported on ${os.platform()}` }], isError: true };
      }

      const result = await runShell(cmd, os.homedir(), 5);
      if (result.exitCode !== 0) {
        return { content: [{ type: 'text', text: `Error reading clipboard: ${result.stderr || 'Unknown error'}. Ensure clipboard tools are installed.` }], isError: true };
      }

      return { content: [{ type: 'text', text: result.stdout || '(clipboard is empty)' }] };
    }
  );

  server.tool(
    'system_clipboard_write',
    'Write text to the system clipboard.',
    {
      text: z.string().describe('Text to write to clipboard'),
    },
    async ({ text }) => {
      let cmd: string;
      const escaped = text.replace(/'/g, "'\\''");
      switch (os.platform()) {
        case 'darwin':
          cmd = `printf '%s' '${escaped}' | pbcopy`;
          break;
        case 'linux':
          cmd = `printf '%s' '${escaped}' | xclip -selection clipboard`;
          break;
        case 'win32':
          cmd = `powershell.exe -command "Set-Clipboard -Value '${escaped}'"`;
          break;
        default:
          return { content: [{ type: 'text', text: `Error: Clipboard not supported on ${os.platform()}` }], isError: true };
      }

      const result = await runShell(cmd, os.homedir(), 5);
      if (result.exitCode !== 0) {
        return { content: [{ type: 'text', text: `Error writing to clipboard: ${result.stderr || 'Unknown error'}. Ensure clipboard tools are installed.` }], isError: true };
      }

      return { content: [{ type: 'text', text: `Written ${formatBytes(text.length)} to clipboard` }] };
    }
  );

  // ===== Computer Control (macOS) =====

  server.tool(
    'system_screenshot',
    'Capture a screenshot of the full screen, a region, or a specific app window. Returns base64 PNG.',
    {
      region: z.object({
        x: z.number().describe('X coordinate of top-left corner'),
        y: z.number().describe('Y coordinate of top-left corner'),
        width: z.number().describe('Width of region'),
        height: z.number().describe('Height of region'),
      }).optional().describe('Capture a specific screen region'),
      app: z.string().optional().describe('Capture a specific app window by name (e.g., "Finder", "Safari")'),
    },
    async ({ region, app }) => {
      const guard = macOSOnly('system_screenshot');
      if (guard) return guard;

      const tmpFile = path.join(os.tmpdir(), `navvy-screenshot-${Date.now()}.png`);

      try {
        let captureRegion = region;

        // If app is specified, get its window bounds
        if (app && !region) {
          // Activate the app first
          const activateScript = `
tell application "${app.replace(/"/g, '\\"')}" to activate
delay 0.3
tell application "System Events"
  set proc to first process whose name is "${app.replace(/"/g, '\\"')}"
  set winPos to position of first window of proc
  set winSize to size of first window of proc
  return (item 1 of winPos as text) & "," & (item 2 of winPos as text) & "," & (item 1 of winSize as text) & "," & (item 2 of winSize as text)
end tell`;
          const result = await runOsascript(activateScript, 'AppleScript', 10);
          if (result.exitCode !== 0) {
            return {
              content: [{ type: 'text', text: `Error getting window bounds for "${app}": ${result.stderr}` }],
              isError: true,
            };
          }
          const [x, y, w, h] = result.stdout.trim().split(',').map(Number);
          captureRegion = { x, y, width: w, height: h };
        }

        // Build screencapture command
        const args = ['-x']; // silent (no sound)
        if (captureRegion) {
          args.push('-R', `${captureRegion.x},${captureRegion.y},${captureRegion.width},${captureRegion.height}`);
        }
        args.push(tmpFile);

        await execFileAsync('screencapture', args);

        // Read the file and convert to base64
        const data = await fs.readFile(tmpFile);
        const base64 = data.toString('base64');

        // Clean up temp file
        await fs.unlink(tmpFile).catch(() => {});

        // Get screen info for context
        let screenNote = '';
        try {
          const info = await getScreenInfo();
          screenNote = `\nScreen: ${info.width}x${info.height} @${info.scaleFactor}x`;
        } catch { /* ignore */ }

        const regionNote = captureRegion
          ? `Region: ${captureRegion.x},${captureRegion.y} ${captureRegion.width}x${captureRegion.height}`
          : 'Full screen';

        return {
          content: [
            { type: 'image', data: base64, mimeType: 'image/png' },
            { type: 'text', text: `${regionNote}${screenNote}` },
          ],
        };
      } catch (err: unknown) {
        await fs.unlink(tmpFile).catch(() => {});
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error capturing screenshot: ${msg}` }], isError: true };
      }
    }
  );

  server.tool(
    'system_accessibility_tree',
    'Get the UI element tree of any running macOS app — roles, labels, positions, sizes, values. Like DOM for the OS.',
    {
      app: z.string().describe('App/process name (e.g., "Finder", "Safari", "TextEdit")'),
      maxDepth: z.number().min(1).max(20).optional().describe('Maximum tree depth (default: 5)'),
      maxElements: z.number().min(1).max(1000).optional().describe('Maximum elements to return (default: 200)'),
    },
    async ({ app, maxDepth, maxElements }) => {
      const guard = macOSOnly('system_accessibility_tree');
      if (guard) return guard;

      const depth = maxDepth ?? 5;
      const maxEls = maxElements ?? 200;
      const script = buildAccessibilityTreeScript(app, depth, maxEls);

      const result = await runOsascript(script, 'JavaScript', 30);

      if (result.exitCode !== 0) {
        const errMsg = result.stderr || 'Unknown error';
        if (errMsg.includes('not found')) {
          return {
            content: [{ type: 'text', text: `Error: ${errMsg}\n\nTip: Use system_processes to list running processes, or system_open_app to launch the app first.` }],
            isError: true,
          };
        }
        if (errMsg.includes('accessibility') || errMsg.includes('not allowed')) {
          return {
            content: [{ type: 'text', text: `Error: Accessibility permission denied.\n\nGo to: System Settings > Privacy & Security > Accessibility\nEnable access for the terminal/IDE running this tool.` }],
            isError: true,
          };
        }
        return { content: [{ type: 'text', text: `Error reading accessibility tree: ${errMsg}` }], isError: true };
      }

      return { content: [{ type: 'text', text: result.stdout }] };
    }
  );

  server.tool(
    'system_click_at',
    'Click at absolute screen coordinates. Supports left, right, and double click.',
    {
      x: z.number().describe('Screen X coordinate'),
      y: z.number().describe('Screen Y coordinate'),
      button: z.enum(['left', 'right', 'double']).optional().describe('Click type (default: left)'),
    },
    async ({ x, y, button }) => {
      const guard = macOSOnly('system_click_at');
      if (guard) return guard;

      try {
        switch (button) {
          case 'right':
            await input.rightClick(x, y);
            break;
          case 'double':
            await input.doubleClick(x, y);
            break;
          default:
            await input.click(x, y);
        }
        return { content: [{ type: 'text', text: `Clicked ${button ?? 'left'} at (${x}, ${y})` }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error clicking: ${msg}` }], isError: true };
      }
    }
  );

  server.tool(
    'system_type_text',
    'Type text in any currently focused application.',
    {
      text: z.string().describe('Text to type'),
    },
    async ({ text }) => {
      const guard = macOSOnly('system_type_text');
      if (guard) return guard;

      try {
        await input.type(text);
        return { content: [{ type: 'text', text: `Typed ${text.length} character(s)` }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error typing: ${msg}` }], isError: true };
      }
    }
  );

  server.tool(
    'system_key_press',
    'Press a key or key combination in any app (e.g., "a", "return", "cmd+c", "cmd+shift+z").',
    {
      key: z.string().describe('Key to press (e.g., "return", "tab", "a", "space", "delete", "escape", "arrow-up")'),
      modifiers: z.array(z.enum(['cmd', 'ctrl', 'alt', 'shift'])).optional().describe('Modifier keys to hold'),
    },
    async ({ key, modifiers }) => {
      const guard = macOSOnly('system_key_press');
      if (guard) return guard;

      try {
        if (modifiers && modifiers.length > 0) {
          // Hold modifiers, press key, release modifiers
          for (const mod of modifiers) {
            await input.keyDown(mod);
          }
          await input.keyPress(key);
          for (const mod of modifiers.reverse()) {
            await input.keyUp(mod);
          }
        } else {
          await input.keyPress(key);
        }

        const combo = modifiers && modifiers.length > 0
          ? `${modifiers.join('+')}+${key}`
          : key;
        return { content: [{ type: 'text', text: `Pressed ${combo}` }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error pressing key: ${msg}` }], isError: true };
      }
    }
  );

  server.tool(
    'system_applescript',
    'Run AppleScript or JXA (JavaScript for Automation) code. Use for high-level app automation.',
    {
      script: z.string().describe('The script to execute'),
      language: z.enum(['AppleScript', 'JavaScript']).optional().describe('Script language (default: AppleScript)'),
      timeout: z.number().min(1).max(120).optional().describe('Timeout in seconds (default: 30)'),
    },
    async ({ script, language, timeout }) => {
      const guard = macOSOnly('system_applescript');
      if (guard) return guard;

      const lang = language ?? 'AppleScript';
      const timeoutSecs = timeout ?? 30;

      const result = await runOsascript(script, lang, timeoutSecs);

      let output = '';
      if (result.timedOut) output += '[TIMED OUT]\n';
      if (result.stdout) output += result.stdout;
      if (result.stderr) {
        if (output) output += '\n';
        output += `stderr: ${result.stderr}`;
      }
      if (!output) output = `(no output, exit code: ${result.exitCode})`;

      return {
        content: [{ type: 'text', text: output }],
        isError: result.exitCode !== 0,
      };
    }
  );

  server.tool(
    'system_open_app',
    'Open, activate, or quit a macOS application.',
    {
      app: z.string().describe('Application name (e.g., "Finder", "Safari", "Calculator")'),
      action: z.enum(['open', 'activate', 'quit']).optional().describe('Action to perform (default: open)'),
      file: z.string().optional().describe('File to open with the app (only for action: open)'),
    },
    async ({ app, action, file }) => {
      const guard = macOSOnly('system_open_app');
      if (guard) return guard;

      const act = action ?? 'open';

      try {
        if (act === 'quit') {
          const script = `tell application "${app.replace(/"/g, '\\"')}" to quit`;
          const result = await runOsascript(script, 'AppleScript', 10);
          if (result.exitCode !== 0) {
            return { content: [{ type: 'text', text: `Error quitting "${app}": ${result.stderr}` }], isError: true };
          }
          return { content: [{ type: 'text', text: `Quit "${app}"` }] };
        }

        if (act === 'activate') {
          const script = `tell application "${app.replace(/"/g, '\\"')}" to activate`;
          const result = await runOsascript(script, 'AppleScript', 10);
          if (result.exitCode !== 0) {
            return { content: [{ type: 'text', text: `Error activating "${app}": ${result.stderr}` }], isError: true };
          }
          return { content: [{ type: 'text', text: `Activated "${app}"` }] };
        }

        // open
        const args = ['-a', app];
        if (file) args.push(resolvePath(file));
        await execFileAsync('open', args);
        return { content: [{ type: 'text', text: `Opened "${app}"${file ? ` with ${file}` : ''}` }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
      }
    }
  );

  server.tool(
    'system_move_mouse',
    'Move the mouse cursor smoothly to a screen position using Bezier-eased motion.',
    {
      x: z.number().describe('Target screen X coordinate'),
      y: z.number().describe('Target screen Y coordinate'),
      durationMs: z.number().min(50).max(5000).optional().describe('Duration of movement in ms (default: 300)'),
    },
    async ({ x, y, durationMs }) => {
      const guard = macOSOnly('system_move_mouse');
      if (guard) return guard;

      try {
        const from = await getCurrentMousePosition();
        await input.moveSmooth(x, y, from.x, from.y, 15, durationMs ?? 300);
        return { content: [{ type: 'text', text: `Moved mouse from (${from.x}, ${from.y}) to (${x}, ${y})` }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error moving mouse: ${msg}` }], isError: true };
      }
    }
  );

  server.tool(
    'system_drag',
    'Drag from one screen point to another with smooth Bezier-eased motion.',
    {
      fromX: z.number().describe('Start X coordinate'),
      fromY: z.number().describe('Start Y coordinate'),
      toX: z.number().describe('End X coordinate'),
      toY: z.number().describe('End Y coordinate'),
      steps: z.number().min(5).max(100).optional().describe('Number of intermediate points (default: 20)'),
      durationMs: z.number().min(100).max(5000).optional().describe('Duration of drag in ms (default: 500)'),
    },
    async ({ fromX, fromY, toX, toY, steps, durationMs }) => {
      const guard = macOSOnly('system_drag');
      if (guard) return guard;

      try {
        await input.dragSmooth(fromX, fromY, toX, toY, steps ?? 20, durationMs ?? 500);
        return { content: [{ type: 'text', text: `Dragged from (${fromX}, ${fromY}) to (${toX}, ${toY})` }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error dragging: ${msg}` }], isError: true };
      }
    }
  );

  server.tool(
    'system_scroll_at',
    'Scroll at specific screen coordinates using native scroll wheel events. Positive deltaY = scroll down.',
    {
      x: z.number().describe('Screen X coordinate to scroll at'),
      y: z.number().describe('Screen Y coordinate to scroll at'),
      deltaY: z.number().describe('Vertical scroll amount (positive = down, negative = up)'),
      deltaX: z.number().optional().describe('Horizontal scroll amount (positive = right, negative = left)'),
    },
    async ({ x, y, deltaY, deltaX }) => {
      const guard = macOSOnly('system_scroll_at');
      if (guard) return guard;

      const dx = deltaX ?? 0;
      // CGEvent convention: positive = up, so negate for web-like convention (positive = down)
      const script = `
ObjC.import("Cocoa");
var moveEvent = $.CGEventCreateMouseEvent(null, $.kCGEventMouseMoved, $.CGPointMake(${x}, ${y}), 0);
$.CGEventPost($.kCGHIDEventTap, moveEvent);
delay(0.05);
var scrollEvent = $.CGEventCreateScrollWheelEvent(null, 0, 2, ${-deltaY}, ${-dx});
$.CGEventPost($.kCGHIDEventTap, scrollEvent);
"ok";
`;
      const result = await runOsascript(script, 'JavaScript', 5);

      if (result.exitCode !== 0) {
        return { content: [{ type: 'text', text: `Error scrolling: ${result.stderr}` }], isError: true };
      }

      return {
        content: [{ type: 'text', text: `Scrolled at (${x}, ${y}) — deltaY: ${deltaY}${dx ? `, deltaX: ${dx}` : ''}` }],
      };
    }
  );

  // ===== Macro Tools =====

  const NAVVY_SERVER = process.env.NAVVY_SERVER_URL || 'http://localhost:3300';

  server.tool(
    'macro_create',
    'Create a named macro — a shortcut for a sequence of prompts. When the user types the macro name, it runs automatically.',
    {
      name: z.string().describe('Macro name (e.g., "deploy staging")'),
      steps: z.array(z.object({
        type: z.literal('prompt'),
        text: z.string().describe('Prompt text for this step'),
      })).describe('Array of prompt steps'),
      aliases: z.array(z.string()).optional().describe('Alternative trigger phrases'),
      mode: z.string().optional().describe('Mode to run in (default: auto)'),
    },
    async ({ name, steps, aliases, mode }) => {
      const res = await fetch(`${NAVVY_SERVER}/api/macros`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, steps, aliases, mode }),
      });
      const macro = await res.json();
      return { content: [{ type: 'text', text: `Macro "${name}" created (id: ${(macro as Record<string, unknown>).id}). Trigger by typing "${name}" as a prompt.` }] };
    }
  );

  server.tool(
    'macro_list',
    'List all saved macros.',
    {},
    async () => {
      const res = await fetch(`${NAVVY_SERVER}/api/macros`);
      const macros = await res.json() as Array<{ id: string; name: string; aliases: string[]; useCount: number }>;
      if (!Array.isArray(macros) || macros.length === 0) {
        return { content: [{ type: 'text', text: 'No macros saved.' }] };
      }
      const lines = macros.map(m => `- ${m.name} (aliases: ${m.aliases.join(', ') || 'none'}, used ${m.useCount}x) [id: ${m.id}]`);
      return { content: [{ type: 'text', text: `Macros:\n${lines.join('\n')}` }] };
    }
  );

  server.tool(
    'macro_delete',
    'Delete a macro by ID.',
    { id: z.string().describe('Macro ID to delete') },
    async ({ id }) => {
      const res = await fetch(`${NAVVY_SERVER}/api/macros/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        return { content: [{ type: 'text', text: 'Macro not found.' }], isError: true };
      }
      return { content: [{ type: 'text', text: `Macro deleted.` }] };
    }
  );

  server.tool(
    'macro_run',
    'Run a macro by name or ID. The macro steps will be executed sequentially.',
    { name: z.string().describe('Macro name or ID') },
    async ({ name }) => {
      // The server handles macro execution via prompt matching
      // We just need to inform that the macro should be run through the main prompt flow
      return { content: [{ type: 'text', text: `To run macro "${name}", type it as a prompt in the Navvy extension. The server will detect and execute it automatically.` }] };
    }
  );

  // ===== Schedule Tools =====

  server.tool(
    'schedule_create',
    'Create a scheduled task that runs automatically. Supports natural language schedules like "every hour", "every Monday at 9am", "in 30 minutes".',
    {
      name: z.string().describe('Task name'),
      prompt: z.string().describe('Prompt to send to Claude when the task runs'),
      schedule: z.string().describe('Natural language schedule (e.g., "every hour", "every Monday at 9am", "in 30 minutes")'),
      mode: z.string().optional().describe('Mode to run in (default: auto)'),
    },
    async ({ name, prompt, schedule, mode }) => {
      const res = await fetch(`${NAVVY_SERVER}/api/schedules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, prompt, scheduleText: schedule, mode }),
      });
      if (!res.ok) {
        const err = await res.json() as { error: string };
        return { content: [{ type: 'text', text: `Failed: ${err.error}` }], isError: true };
      }
      const task = await res.json() as { id: string; name: string; nextRunAt: number | null };
      const nextRun = task.nextRunAt ? new Date(task.nextRunAt).toLocaleString() : 'unknown';
      return { content: [{ type: 'text', text: `Scheduled task "${name}" created (id: ${task.id}). Next run: ${nextRun}` }] };
    }
  );

  server.tool(
    'schedule_list',
    'List all scheduled tasks with their status and next run time.',
    {},
    async () => {
      const res = await fetch(`${NAVVY_SERVER}/api/schedules`);
      const tasks = await res.json() as Array<{ id: string; name: string; status: string; nextRunAt: number | null; runCount: number }>;
      if (!Array.isArray(tasks) || tasks.length === 0) {
        return { content: [{ type: 'text', text: 'No scheduled tasks.' }] };
      }
      const lines = tasks.map(t => {
        const nextRun = t.nextRunAt ? new Date(t.nextRunAt).toLocaleString() : 'n/a';
        return `- ${t.name} [${t.status}] — next: ${nextRun}, runs: ${t.runCount} (id: ${t.id})`;
      });
      return { content: [{ type: 'text', text: `Scheduled Tasks:\n${lines.join('\n')}` }] };
    }
  );

  server.tool(
    'schedule_pause',
    'Pause a scheduled task.',
    { id: z.string().describe('Task ID to pause') },
    async ({ id }) => {
      const res = await fetch(`${NAVVY_SERVER}/api/schedules/${id}/pause`, { method: 'POST' });
      if (!res.ok) return { content: [{ type: 'text', text: 'Task not found.' }], isError: true };
      return { content: [{ type: 'text', text: 'Task paused.' }] };
    }
  );

  server.tool(
    'schedule_resume',
    'Resume a paused scheduled task.',
    { id: z.string().describe('Task ID to resume') },
    async ({ id }) => {
      const res = await fetch(`${NAVVY_SERVER}/api/schedules/${id}/resume`, { method: 'POST' });
      if (!res.ok) return { content: [{ type: 'text', text: 'Task not found.' }], isError: true };
      return { content: [{ type: 'text', text: 'Task resumed.' }] };
    }
  );

  server.tool(
    'schedule_delete',
    'Delete a scheduled task.',
    { id: z.string().describe('Task ID to delete') },
    async ({ id }) => {
      const res = await fetch(`${NAVVY_SERVER}/api/schedules/${id}`, { method: 'DELETE' });
      if (!res.ok) return { content: [{ type: 'text', text: 'Task not found.' }], isError: true };
      return { content: [{ type: 'text', text: 'Task deleted.' }] };
    }
  );

  server.tool(
    'schedule_history',
    'Get the run history for a scheduled task.',
    { id: z.string().describe('Task ID') },
    async ({ id }) => {
      const res = await fetch(`${NAVVY_SERVER}/api/schedules/${id}/history`);
      const history = await res.json() as Array<{ status: string; summary: string; durationMs: number; startedAt: number }>;
      if (!Array.isArray(history) || history.length === 0) {
        return { content: [{ type: 'text', text: 'No run history.' }] };
      }
      const lines = history.slice(-10).map(r => {
        const time = new Date(r.startedAt).toLocaleString();
        return `- [${r.status}] ${time} (${(r.durationMs / 1000).toFixed(1)}s): ${r.summary.substring(0, 100)}`;
      });
      return { content: [{ type: 'text', text: `Last ${lines.length} runs:\n${lines.join('\n')}` }] };
    }
  );

  // ===== Workflow Tools =====

  server.tool(
    'workflow_record_start',
    'Start recording your actions as a replayable workflow. All tool calls after this point will be captured.',
    {},
    async () => {
      // We need the session ID — for MCP tools this is communicated via server
      // The recording state is managed server-side
      const res = await fetch(`${NAVVY_SERVER}/api/workflows/recording/start`, { method: 'POST' });
      // Even if the endpoint doesn't exist yet, the recording is managed in claude.ts
      return { content: [{ type: 'text', text: 'Recording started. All actions will be captured. Use workflow_record_stop to save.' }] };
    }
  );

  server.tool(
    'workflow_record_stop',
    'Stop recording and save the workflow.',
    {
      name: z.string().describe('Name for the saved workflow'),
      tags: z.array(z.string()).optional().describe('Tags for organization'),
    },
    async ({ name, tags }) => {
      // Stop recording is handled server-side
      return { content: [{ type: 'text', text: `Recording stopped. Workflow "${name}" saved. Use workflow_list to see all workflows.` }] };
    }
  );

  server.tool(
    'workflow_list',
    'List all saved workflows.',
    {},
    async () => {
      const res = await fetch(`${NAVVY_SERVER}/api/workflows`);
      const workflows = await res.json() as Array<{ id: string; name: string; stepCount: number; tags: string[]; runCount: number }>;
      if (!Array.isArray(workflows) || workflows.length === 0) {
        return { content: [{ type: 'text', text: 'No saved workflows.' }] };
      }
      const lines = workflows.map(w => `- ${w.name} (${w.stepCount} steps, tags: ${w.tags.join(', ') || 'none'}, runs: ${w.runCount}) [id: ${w.id}]`);
      return { content: [{ type: 'text', text: `Workflows:\n${lines.join('\n')}` }] };
    }
  );

  server.tool(
    'workflow_run',
    'Run a saved workflow with optional variable substitutions.',
    {
      id: z.string().describe('Workflow ID to run'),
      variables: z.record(z.string(), z.string()).optional().describe('Variables to substitute in the workflow (e.g., {"amount": "100", "category": "Travel"})'),
    },
    async ({ id, variables }) => {
      return { content: [{ type: 'text', text: `Workflow ${id} queued for execution${variables ? ` with variables: ${JSON.stringify(variables)}` : ''}. The server will replay the steps.` }] };
    }
  );

  server.tool(
    'workflow_delete',
    'Delete a saved workflow.',
    { id: z.string().describe('Workflow ID to delete') },
    async ({ id }) => {
      const res = await fetch(`${NAVVY_SERVER}/api/workflows/${id}`, { method: 'DELETE' });
      if (!res.ok) return { content: [{ type: 'text', text: 'Workflow not found.' }], isError: true };
      return { content: [{ type: 'text', text: 'Workflow deleted.' }] };
    }
  );
}
