#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

// ── SDK list ─────────────────────────────────────────────────────────────────
const SDKS = ['chat', 'notify', 'signal', 'stream', 'feed', 'dash', 'track', 'sync', 'queue', 'iot', 'collab'];

// Files that get synced between example-app and blueprint.json
const FILE_MAP = {
  '/index.html': 'example-app/index.html',
  '/src/main.js': 'example-app/src/main.js',
};

// ── Helpers ──────────────────────────────────────────────────────────────────
function resolveRoot() {
  // Walk up from this script's directory to find the monorepo root
  // (the directory that contains both js/ and blueprints/ dirs)
  let dir = path.dirname(new URL(import.meta.url).pathname);
  while (dir !== '/') {
    if (fs.existsSync(path.join(dir, 'js')) && fs.existsSync(path.join(dir, 'blueprints'))) return dir;
    dir = path.dirname(dir);
  }
  // Fallback: assume CWD
  return process.cwd();
}

function readFileOrNull(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

function usage() {
  console.log(`
sync-blueprints — Sync example-app files ↔ blueprint.json

Usage:
  sync-blueprints push [--sdk <name>]    Write example-app files into blueprint.json
  sync-blueprints pull [--sdk <name>]    Extract blueprint.json files into example-app
  sync-blueprints status [--sdk <name>]  Show which SDKs are in/out of sync
  sync-blueprints help                   Show this help

Options:
  --sdk <name>    Only process a specific SDK (e.g. --sdk chat)
  --dry-run       Show what would change without writing files

Examples:
  sync-blueprints push                   Push all example-apps into their blueprint.json
  sync-blueprints pull --sdk collab      Extract collab's blueprint.json into example-app
  sync-blueprints status                 Check sync status for all SDKs
`);
}

// ── Commands ─────────────────────────────────────────────────────────────────

function cmdStatus(root, sdks, _dryRun) {
  let allInSync = true;

  for (const sdk of sdks) {
    const bpPath = path.join(root, 'blueprints', sdk, 'blueprint.json');
    const bpContent = readFileOrNull(bpPath);
    if (!bpContent) {
      console.log(`  ${sdk}: ⚠ no blueprint.json`);
      continue;
    }

    const bp = JSON.parse(bpContent);
    const files = bp.files ?? {};
    const diffs = [];

    for (const [bpKey, relPath] of Object.entries(FILE_MAP)) {
      const diskContent = readFileOrNull(path.join(root, 'blueprints', sdk, relPath));
      const bpFileContent = files[bpKey] ?? null;

      if (diskContent === null && bpFileContent === null) continue;
      if (diskContent === null) { diffs.push(`${relPath} missing on disk`); continue; }
      if (bpFileContent === null) { diffs.push(`${bpKey} missing in blueprint.json`); continue; }
      if (diskContent !== bpFileContent) { diffs.push(`${relPath} differs`); }
    }

    if (diffs.length === 0) {
      console.log(`  ${sdk}: ✓ in sync`);
    } else {
      allInSync = false;
      console.log(`  ${sdk}: ✗ out of sync`);
      diffs.forEach(d => console.log(`    - ${d}`));
    }
  }

  if (allInSync) {
    console.log('\nAll SDKs are in sync.');
  } else {
    console.log('\nRun "sync-blueprints push" to update blueprint.json from example-app files.');
    console.log('Run "sync-blueprints pull" to update example-app files from blueprint.json.');
  }
}

function cmdPush(root, sdks, dryRun) {
  for (const sdk of sdks) {
    const bpPath = path.join(root, 'blueprints', sdk, 'blueprint.json');
    const bpContent = readFileOrNull(bpPath);
    if (!bpContent) {
      console.log(`  ${sdk}: ⚠ no blueprint.json, skipping`);
      continue;
    }

    const bp = JSON.parse(bpContent);
    if (!bp.files) bp.files = {};

    let changed = false;

    for (const [bpKey, relPath] of Object.entries(FILE_MAP)) {
      const diskContent = readFileOrNull(path.join(root, 'blueprints', sdk, relPath));
      if (diskContent === null) {
        console.log(`  ${sdk}: ⚠ ${relPath} not found, skipping`);
        continue;
      }

      if (bp.files[bpKey] !== diskContent) {
        bp.files[bpKey] = diskContent;
        changed = true;
        console.log(`  ${sdk}: ← ${relPath} → blueprint.json[${bpKey}]`);
      }
    }

    if (changed) {
      if (dryRun) {
        console.log(`  ${sdk}: (dry-run) would update blueprint.json`);
      } else {
        fs.writeFileSync(bpPath, JSON.stringify(bp, null, 2) + '\n');
        console.log(`  ${sdk}: ✓ blueprint.json updated`);
      }
    } else {
      console.log(`  ${sdk}: ✓ already in sync`);
    }
  }
}

function cmdPull(root, sdks, dryRun) {
  for (const sdk of sdks) {
    const bpPath = path.join(root, 'blueprints', sdk, 'blueprint.json');
    const bpContent = readFileOrNull(bpPath);
    if (!bpContent) {
      console.log(`  ${sdk}: ⚠ no blueprint.json, skipping`);
      continue;
    }

    const bp = JSON.parse(bpContent);
    const files = bp.files ?? {};
    let changed = false;

    for (const [bpKey, relPath] of Object.entries(FILE_MAP)) {
      const bpFileContent = files[bpKey];
      if (bpFileContent === undefined || bpFileContent === null) continue;

      const diskPath = path.join(root, 'blueprints', sdk, relPath);
      const diskContent = readFileOrNull(diskPath);

      if (diskContent !== bpFileContent) {
        changed = true;
        console.log(`  ${sdk}: blueprint.json[${bpKey}] → ${relPath}`);

        if (!dryRun) {
          fs.mkdirSync(path.dirname(diskPath), { recursive: true });
          fs.writeFileSync(diskPath, bpFileContent);
        }
      }
    }

    if (changed) {
      if (dryRun) {
        console.log(`  ${sdk}: (dry-run) would update example-app files`);
      } else {
        console.log(`  ${sdk}: ✓ example-app updated`);
      }
    } else {
      console.log(`  ${sdk}: ✓ already in sync`);
    }
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────
function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    usage();
    process.exit(0);
  }

  const dryRun = args.includes('--dry-run');
  const sdkIdx = args.indexOf('--sdk');
  const sdkFilter = sdkIdx !== -1 ? args[sdkIdx + 1] : null;

  if (sdkFilter && !SDKS.includes(sdkFilter)) {
    console.error(`Unknown SDK: "${sdkFilter}". Available: ${SDKS.join(', ')}`);
    process.exit(1);
  }

  const sdks = sdkFilter ? [sdkFilter] : SDKS;
  const root = resolveRoot();

  console.log(`Root: ${root}`);
  console.log(`Command: ${command}${dryRun ? ' (dry-run)' : ''}`);
  console.log(`SDKs: ${sdks.join(', ')}\n`);

  switch (command) {
    case 'status':
      cmdStatus(root, sdks, dryRun);
      break;
    case 'push':
      cmdPush(root, sdks, dryRun);
      break;
    case 'pull':
      cmdPull(root, sdks, dryRun);
      break;
    default:
      console.error(`Unknown command: "${command}". Run "sync-blueprints help" for usage.`);
      process.exit(1);
  }
}

main();
