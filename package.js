#!/usr/bin/env node
/**
 * Distribution packager for RespireeClaw Gateway
 * Creates a zip file with all necessary files for installation on other devices
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import os from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Directories to include (recursively)
const INCLUDE_DIRS = [
  'src',
  'default-skills',
  'browser-extension',
  'docs',
];

// Individual files to include
const INCLUDE_FILES = [
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'agent.js',
  'agent.cjs',
  '_agent.js',
  'package.js',
  '.env.example',
  '.gitignore',
  '.gitmessage',
  'README.md',
  'CONTRIBUTING.md',
  'DOCKER.md',
  'Dockerfile',
  'Dockerfile.dev',
  'docker-compose.yml',
  'docker-compose.dev.yml',
  'docker-entrypoint.sh',
];

// Patterns to exclude
const EXCLUDE_PATTERNS = [
  /\.git$/,
  /\.git\//,
  /node_modules$/,
  /node_modules\//,
  /\.env$/,
  /\.log$/,
  /dist$/,
  /dist\//,
  /build$/,
  /build\//,
  /\.claude$/,
  /\.claude\//,
  /temp$/,
  /temp\//,
  /logs$/,
  /logs\//,
  /\.pid$/,
  /\.tmp$/,
  /respireeclaw-gateway.*\.zip$/,
];

function log(msg) {
  console.log(`[Package] ${msg}`);
}

function error(msg) {
  console.error(`[Package] Error: ${msg}`);
  process.exit(1);
}

function getVersion() {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
  return pkg.version;
}

function shouldExclude(filePath) {
  const normalized = filePath.replace(/\\/g, '/');
  for (const pattern of EXCLUDE_PATTERNS) {
    if (pattern.test(normalized)) return true;
  }
  return false;
}

function collectFiles() {
  const files = [];

  // Add individual files
  for (const file of INCLUDE_FILES) {
    const fullPath = path.join(__dirname, file);
    if (fs.existsSync(fullPath)) {
      files.push({ src: fullPath, dest: file });
    }
  }

  // Add directories recursively
  for (const dir of INCLUDE_DIRS) {
    const dirPath = path.join(__dirname, dir);
    if (!fs.existsSync(dirPath)) {
      log(`Warning: Directory not found: ${dir}`);
      continue;
    }
    collectDirRecursive(dirPath, dir, files);
  }

  return files;
}

function collectDirRecursive(dirPath, relativeDir, files) {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const relativePath = path.join(relativeDir, entry.name);

    if (shouldExclude(relativePath)) continue;

    const fullPath = path.join(dirPath, entry.name);

    if (entry.isDirectory()) {
      collectDirRecursive(fullPath, relativePath, files);
    } else {
      files.push({ src: fullPath, dest: relativePath });
    }
  }
}

function createTempDir() {
  const tmpDir = path.join(os.tmpdir(), `respireeclaw-dist-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  return tmpDir;
}

function copyFiles(files, tempDir) {
  for (const { src, dest } of files) {
    const destPath = path.join(tempDir, dest);
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.copyFileSync(src, destPath);
  }
}

function createZip(sourceDir, outputPath) {
  const platform = os.platform();

  if (platform === 'win32') {
    // Use PowerShell on Windows
    const result = spawnSync('powershell.exe', [
      '-Command',
      `Compress-Archive -Path "${sourceDir}\\*" -DestinationPath "${outputPath}" -Force`
    ], { stdio: 'inherit' });
    return result.status === 0;
  } else {
    // Use zip on Unix-like systems
    const result = spawnSync('zip', ['-r', '-q', outputPath, '.'], {
      cwd: sourceDir,
      stdio: 'inherit'
    });
    return result.status === 0;
  }
}

function createInstallScript(tempDir) {
  const isWindows = os.platform() === 'win32';

  if (isWindows) {
    const batContent = `@echo off
REM RespireeClaw Gateway Installer
REM Run this after extracting the zip file

echo ==========================================
echo  RespireeClaw Gateway Installation
echo ==========================================
echo.

REM Check Node.js
echo Checking Node.js version...
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: Node.js is not installed or not in PATH
    echo Please install Node.js 20+ from https://nodejs.org/
    pause
    exit /b 1
)

for /f "tokens=1" %%a in ('node --version') do (
    set NODE_VERSION=%%a
)
echo Found: %NODE_VERSION%

REM Check version is 20+
echo %NODE_VERSION% | findstr /B /C:"v20." /C:"v21." /C:"v22." >nul
if %errorlevel% neq 0 (
    echo WARNING: Node.js 20+ recommended. Current: %NODE_VERSION%
)

REM Install dependencies
echo.
echo Installing dependencies (this may take a few minutes)...
call npm install --ignore-scripts
if %errorlevel% neq 0 (
    echo ERROR: npm install failed
    pause
    exit /b 1
)

REM Run onboard wizard
echo.
echo ==========================================
echo  Setup complete! Starting onboard wizard...
echo ==========================================
pause
node agent.js onboard

echo.
echo To start the gateway:
echo   node agent.js --daemon
echo.
pause
`;
    fs.writeFileSync(path.join(tempDir, 'INSTALL.bat'), batContent);
  }

  const shContent = `#!/bin/bash
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
`;
  fs.writeFileSync(path.join(tempDir, 'INSTALL.sh'), shContent);
  if (!isWindows) {
    fs.chmodSync(path.join(tempDir, 'INSTALL.sh'), 0o755);
  }
}

function createReadme(tempDir) {
  const content = `RespireeClaw Gateway
====================

Installation
------------

1. Extract this zip file to a permanent location
2. Run the installer:
   - Windows: Double-click INSTALL.bat
   - macOS/Linux: bash INSTALL.sh

3. Follow the onboard wizard prompts

Quick Start
-----------

After installation:

    # Start the server
    node agent.js --daemon

    # Check status
    node agent.js status

    # View logs
    node agent.js logs

    # Stop the server
    node agent.js stop

Configuration
-------------

Configuration files are stored in ~/.aura/:
- config.yaml - Main settings
- agents.yaml - Agent definitions
- skills/ - Installed skills

Requirements
------------

- Node.js 20+
- npm

See README.md for full documentation.
`;
  fs.writeFileSync(path.join(tempDir, 'INSTALL_README.txt'), content);
}

function main() {
  const args = process.argv.slice(2);
  const outputIndex = args.indexOf('--output');
  let outputPath = outputIndex !== -1 ? args[outputIndex + 1] : null;

  if (!outputPath) {
    const version = getVersion();
    outputPath = path.join(__dirname, `respireeclaw-gateway-v${version}.zip`);
  }

  log(`Creating distribution package...`);
  log(`Version: ${getVersion()}`);
  log(`Output: ${outputPath}`);

  // Collect files
  log('Collecting files...');
  const files = collectFiles();
  log(`Found ${files.length} files to include`);

  if (files.length === 0) {
    error('No files found to package!');
  }

  // Show some files
  log('Sample files:');
  files.slice(0, 5).forEach(f => log(`  - ${f.dest}`));
  if (files.length > 5) log(`  ... and ${files.length - 5} more`);

  // Create temp directory and copy files
  const tempDir = createTempDir();
  log(`Copying to temp directory...`);
  copyFiles(files, tempDir);

  // Create install scripts
  log('Creating install scripts...');
  createInstallScript(tempDir);
  createReadme(tempDir);

  // Create zip
  log('Creating zip archive...');
  if (createZip(tempDir, outputPath)) {
    log(`Package created: ${outputPath}`);

    // Get file size
    const stats = fs.statSync(outputPath);
    const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
    log(`Size: ${sizeMB} MB`);
  } else {
    error('Failed to create zip archive');
  }

  // Cleanup
  log('Cleaning up...');
  fs.rmSync(tempDir, { recursive: true, force: true });

  log('Done!');
}

main();
