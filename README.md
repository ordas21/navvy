# Navvy

AI-powered browser automation through a Chrome extension, WebSocket server, and MCP tools.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node 18+](https://img.shields.io/badge/Node-18%2B-green.svg)](https://nodejs.org)
[![Platform: macOS | Windows](https://img.shields.io/badge/Platform-macOS%20%7C%20Windows-lightgrey.svg)](#windows-support-experimental)

## What is Navvy?

Navvy connects Claude to your browser so it can see, navigate, and interact with web pages autonomously. It works by chaining four components together:

- **Chrome Extension** — side panel UI for chatting with Claude and viewing tool calls in real time
- **WebSocket Server** — relays prompts to the Claude CLI and streams responses back
- **Claude CLI** — runs Claude with access to MCP browser tools
- **MCP Server** — exposes 13 browser automation tools via the Model Context Protocol, using Chrome DevTools Protocol (CDP) and native OS input

## Architecture

```
┌───────────────┐   WebSocket    ┌───────────────┐   stdio    ┌───────────┐   CDP    ┌─────────┐
│   Extension   │ ◄────────────► │    Server      │ ◄────────► │ Claude CLI│ ◄──────► │   MCP   │
│  (Side Panel) │   (ws://3300)  │  (Express+WS)  │            │           │          │  Server │
└───────────────┘                └───────────────┘            └───────────┘          └────┬────┘
                                                                                          │
                                                                                    CDP + OS Input
                                                                                          │
                                                                                    ┌─────▼─────┐
                                                                                    │  Chrome    │
                                                                                    │ (port 9222)│
                                                                                    └───────────┘
```

## Prerequisites

Before you begin, make sure you have the following installed:

| Requirement | Notes |
|-------------|-------|
| **Node.js 18+** | [nodejs.org](https://nodejs.org) |
| **Claude CLI** | Install: `npm install -g @anthropic-ai/claude-code` — must be logged in (`claude` should work in your terminal) |
| **Google Chrome** | Will be launched with a special debug flag |
| **cliclick** (macOS only) | `brew install cliclick` — required for native mouse/keyboard input |

## Quick Start

### 1. Clone and set up

```bash
git clone https://github.com/ordas21/navvy.git
cd navvy
bash setup.sh        # macOS / Linux
```

This installs npm dependencies, builds TypeScript, and creates a `chrome-debug` alias in your shell.

> **Windows:** Use `powershell -ExecutionPolicy Bypass -File setup.ps1` instead.

### 2. Launch Chrome with remote debugging

Open a **new terminal** (so the alias is available) and run:

```bash
chrome-debug
```

Or launch manually:

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.chrome-debug-profile" \
  --no-first-run
```

Navigate to any website — this is the tab Navvy will control.

### 3. Start the Navvy server

In a **separate terminal**:

```bash
cd navvy
npm run dev
```

You should see:
```
Navvy server running on http://localhost:3300
WebSocket endpoint: ws://localhost:3300/ws
```

### 4. Load the Chrome extension

1. Open `chrome://extensions` in the debug Chrome instance
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** and select the `extension/` folder
4. Click the Navvy icon in the toolbar to open the side panel

### 5. Start chatting

Type a task in the side panel, e.g. *"Search for headphones under $50"*. Navvy will take screenshots, read the page, click elements, and navigate — all visible in real time.

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `PORT` | `3300` | WebSocket/HTTP server port (env var) |
| Server URL | `ws://localhost:3300/ws` | Configurable in extension settings |
| CDP port | `9222` | Chrome remote debugging port |

## Project Structure

```
navvy/
├── extension/               # Chrome extension (Manifest V3)
│   ├── manifest.json        # Extension config
│   ├── sidepanel.html       # Side panel UI
│   ├── sidepanel.js         # UI logic, WebSocket client
│   ├── sidepanel.css        # Styles
│   ├── background.js        # Service worker
│   ├── storage.js           # Conversation persistence
│   └── icons/               # Extension icons
├── server/                  # WebSocket relay server
│   └── src/
│       ├── index.ts         # Express + WS server
│       ├── claude.ts        # Claude CLI process management
│       └── types.ts         # Shared message types
├── mcp-server/              # MCP tool server
│   └── src/
│       ├── index.ts         # MCP server entrypoint
│       ├── tools.ts         # 13 browser tool definitions
│       ├── cdp.ts           # Chrome DevTools Protocol client
│       ├── coordinates.ts   # Viewport ↔ screen coordinate mapping
│       ├── input.ts         # OS-detecting input dispatcher
│       ├── input-macos.ts   # macOS input (cliclick)
│       └── input-windows.ts # Windows input (PowerShell + user32.dll)
├── mcp-config.json          # MCP server config for Claude CLI
├── setup.sh                 # macOS/Linux setup script
├── setup.ps1                # Windows setup script
├── package.json             # Root workspace config
└── LICENSE
```

## Browser Tools

| Tool | Description |
|------|-------------|
| `browser_screenshot` | Capture a screenshot of the current page (base64 PNG) |
| `browser_get_dom` | Get simplified DOM tree with tags, ids, classes, roles, text |
| `browser_click` | Click an element by CSS selector (native OS input) |
| `browser_click_at` | Click at viewport coordinates (native OS input) |
| `browser_type` | Type text at the focused element |
| `browser_key_press` | Press a key (return, tab, escape, arrows, etc.) |
| `browser_navigate` | Navigate to a URL |
| `browser_scroll` | Scroll the page up or down |
| `browser_evaluate` | Execute JavaScript on the page |
| `browser_get_url` | Get current page URL and title |
| `browser_wait` | Wait for a selector or a duration |
| `browser_tabs` | List all open browser tabs |
| `browser_switch_tab` | Switch to a tab by ID |

## Windows Support (Experimental)

Windows support uses PowerShell with .NET interop for input simulation instead of cliclick:

- **Mouse**: `user32.dll` → `SetCursorPos` + `mouse_event`
- **Keyboard**: `System.Windows.Forms.SendKeys`
- **Limitations**: `keyDown`/`keyUp` are approximated as full key presses

### Windows Setup

```powershell
# 1. Run setup
powershell -ExecutionPolicy Bypass -File setup.ps1

# 2. Launch Chrome with debugging
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="$env:TEMP\chrome-debug-profile" --no-first-run

# 3. Start the server
npm run dev

# 4. Load extension in chrome://extensions (same as macOS)
```

## Troubleshooting

**Extension shows "Disconnected"**
- Make sure the server is running (`npm run dev`)
- Check the server URL in extension settings (default: `ws://localhost:3300/ws`)

**"Cannot connect to Chrome"**
- Make sure Chrome was launched with `--remote-debugging-port=9222`
- Check that port 9222 is not already in use: `lsof -i :9222` (macOS) or `netstat -ano | findstr 9222` (Windows)

**Claude CLI hangs / "No output after 15s"**
- The server strips `CLAUDE*` env vars automatically, but if you're running inside another Claude session, start the server in a fresh terminal
- Test the CLI directly: `claude -p "say hello" --output-format stream-json --model sonnet`

**Screenshots show the extension instead of the page**
- The MCP server auto-selects the first real browser tab, skipping extension pages
- Make sure you have at least one regular web page open in Chrome

**Clicks land in the wrong position**
- This can happen if Chrome's device pixel ratio doesn't match. Try resetting browser zoom to 100%
- On macOS, make sure cliclick is installed: `brew install cliclick`

**"cliclick: command not found" (macOS)**
- Install it: `brew install cliclick`

**PowerShell errors (Windows)**
- Make sure you're running PowerShell 5.1+ (ships with Windows 10/11)
- If `SendKeys` fails, ensure the target window has focus

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b my-feature`
3. Make your changes and test locally
4. Submit a pull request

## License

[MIT](LICENSE)
