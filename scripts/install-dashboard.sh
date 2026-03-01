#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DASHBOARD_DIR="$SCRIPT_DIR/../dashboard"

echo "==> Installing dashboard dependencies..."
cd "$DASHBOARD_DIR"
npm install

echo "Done."
