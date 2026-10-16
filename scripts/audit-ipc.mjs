#!/usr/bin/env node
/**
 * audit-ipc.mjs
 *
 * Enforces that only channels listed in scripts/ipc-secret-allowlist.txt
 * are marked with the SECRET_INPUT tag in electron/**.
 *
 * A "SECRET_INPUT" tag must appear on a line that mentions an IPC channel
 * string. Any mismatches fail CI.
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const electronDir = path.join(repoRoot, 'electron');
const allowlistFile = path.join(__dirname, 'ipc-secret-allowlist.txt');

function walk(dir, acc = []) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) walk(full, acc);
    else if (full.endsWith('.ts')) acc.push(full);
  }
  return acc;
}

function readAllowlist() {
  if (!fs.existsSync(allowlistFile)) return new Set();
  return new Set(
    fs
      .readFileSync(allowlistFile, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#')),
  );
}

const allow = readAllowlist();
if (!fs.existsSync(electronDir)) {
  console.log('audit-ipc: electron/ not found, skipping');
  process.exit(0);
}
const files = walk(electronDir);
const violations = [];
for (const f of files) {
  const content = fs.readFileSync(f, 'utf8');
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes('SECRET_INPUT')) continue;
    // Find channel strings on the same or previous few lines: 'conn:test' style.
    const window = lines.slice(Math.max(0, i - 2), i + 1).join('\n');
    const channels = [...window.matchAll(/['"`]([a-z]+:[a-zA-Z0-9]+)['"`]/g)].map((m) => m[1]);
    if (channels.length === 0) {
      violations.push(`${path.relative(repoRoot, f)}:${i + 1}: SECRET_INPUT without a nearby channel string`);
      continue;
    }
    for (const ch of channels) {
      if (!allow.has(ch)) {
        violations.push(`${path.relative(repoRoot, f)}:${i + 1}: SECRET_INPUT on '${ch}' not in allowlist`);
      }
    }
  }
}

if (violations.length > 0) {
  console.error('audit-ipc: violations found:');
  for (const v of violations) console.error(' - ' + v);
  process.exit(1);
}
console.log(`audit-ipc: OK (${files.length} files scanned)`);
