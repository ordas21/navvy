#!/bin/bash
set -e

echo "=== Navvy Setup ==="

# OS detection
OS="$(uname -s)"
case "$OS" in
  Darwin) ;;
  Linux)
    echo "WARNING: Linux is not fully supported yet. cliclick is macOS-only."
    echo "         The server and extension will work, but native input (click/type) will not."
    ;;
  MINGW*|MSYS*|CYGWIN*)
    echo "ERROR: On Windows, use setup.ps1 instead:"
    echo "       powershell -ExecutionPolicy Bypass -File setup.ps1"
    exit 1
    ;;
  *)
    echo "WARNING: Unknown OS '$OS'. Proceeding anyway..."
    ;;
esac

# Check for cliclick (macOS only)
if [ "$OS" = "Darwin" ]; then
  if ! command -v cliclick &> /dev/null; then
    echo "Installing cliclick..."
    brew install cliclick
  else
    echo "cliclick already installed."
  fi
fi

# Install dependencies
echo "Installing npm dependencies..."
npm install

# Build TypeScript
echo "Building TypeScript..."
npm run build

# Create Chrome debug launch alias (macOS/Linux)
if [ "$OS" = "Darwin" ]; then
  ALIAS_LINE="alias chrome-debug='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=9222 --user-data-dir=\"\$HOME/.chrome-debug-profile\" --no-first-run'"
  SHELL_RC="$HOME/.zshrc"

  if ! grep -q "chrome-debug" "$SHELL_RC" 2>/dev/null; then
    echo "" >> "$SHELL_RC"
    echo "# Chrome with remote debugging for Navvy" >> "$SHELL_RC"
    echo "$ALIAS_LINE" >> "$SHELL_RC"
    echo "Added chrome-debug alias to $SHELL_RC"
  else
    echo "chrome-debug alias already exists."
  fi
fi

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Usage:"
if [ "$OS" = "Darwin" ]; then
  echo "  1. Restart your terminal or run: source $SHELL_RC"
  echo "  2. Launch Chrome with debugging: chrome-debug"
else
  echo "  1. Launch Chrome with --remote-debugging-port=9222"
fi
echo "  3. Start the server: npm run dev"
echo "  4. Load extension in chrome://extensions (developer mode, load unpacked 'extension/')"
echo "  5. Open the side panel and start chatting!"
