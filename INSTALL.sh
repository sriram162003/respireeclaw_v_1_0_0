#!/bin/bash
# RespireeClaw Gateway Installer
# Run this after extracting the zip file

set -e

echo "=========================================="
echo "  RespireeClaw Gateway Installation"
echo "=========================================="
echo ""

# Check Node.js
echo "Checking Node.js version..."
if ! command -v node &> /dev/null; then
    echo "ERROR: Node.js is not installed"
    echo "Please install Node.js 20+ from https://nodejs.org/"
    exit 1
fi

NODE_VERSION=$(node --version)
echo "Found: $NODE_VERSION"

# Check version is 20+
MAJOR=$(echo $NODE_VERSION | cut -d. -f1 | tr -d 'v')
if [ "$MAJOR" -lt 20 ]; then
    echo "WARNING: Node.js 20+ recommended. Current: $NODE_VERSION"
fi

# Install dependencies
echo ""
echo "Installing dependencies (this may take a few minutes)..."
npm install --ignore-scripts

# Run onboard wizard
echo ""
echo "=========================================="
echo "  Setup complete! Starting onboard wizard..."
echo "=========================================="
read -p "Press Enter to continue..."
node agent.js onboard

echo ""
echo "To start the gateway:"
echo "  node agent.js --daemon"
