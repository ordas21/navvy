#!/bin/bash
set -e

echo "=== Claude Browser Agent Setup ==="

# Check for cliclick
if ! command -v cliclick &> /dev/null; then
  echo "Installing cliclick..."
  brew install cliclick
else
  echo "cliclick already installed."
fi

# Install dependencies
echo "Installing npm dependencies..."
npm install

# Build TypeScript
echo "Building TypeScript..."
npm run build

# Create Chrome debug launch alias
ALIAS_LINE="alias chrome-debug='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=9222'"
SHELL_RC="$HOME/.zshrc"

if ! grep -q "chrome-debug" "$SHELL_RC" 2>/dev/null; then
  echo "" >> "$SHELL_RC"
  echo "# Chrome with remote debugging for Claude Browser Agent" >> "$SHELL_RC"
  echo "$ALIAS_LINE" >> "$SHELL_RC"
  echo "Added chrome-debug alias to $SHELL_RC"
else
  echo "chrome-debug alias already exists."
fi

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Usage:"
echo "  1. Restart your terminal or run: source $SHELL_RC"
echo "  2. Launch Chrome with debugging: chrome-debug"
echo "  3. Start the server: npm run dev"
echo "  4. Load extension in chrome://extensions (developer mode, load unpacked 'extension/')"
echo "  5. Open the side panel and start chatting!"
