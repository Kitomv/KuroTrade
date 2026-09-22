#!/usr/bin/env node
// Run the whole workspace with: npx trading-start (or) npm run start-all
// Uses npm directly (not npx) for the child commands.
import { spawn } from 'child_process';

const procs = [
  { name: 'backend', color: '\x1b[33m', cmd: 'npm', args: ['--prefix', 'backend', 'run', 'start'] },
  { name: 'frontend', color: '\x1b[36m', cmd: 'npm', args: ['--prefix', 'frontend', 'run', 'dev'] },
];

const prefix = (name, color) => (data) => {
  const str = String(data).trimEnd();
  if (!str) return;
  for (const line of str.split('\n')) {
    console.log(`${color}[${name}]\x1b[0m ${line}`);
  }
};

for (const p of procs) {
  const proc = spawn(p.cmd, p.args, { shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout.on('data', prefix(p.name, p.color));
  proc.stderr.on('data', prefix(p.name, `${p.color}\x1b[2m`));
  proc.on('exit', (code) => console.log(`${p.color}[${p.name}]\x1b[0m exited (code ${code})`));
}

process.on('SIGINT', () => process.exit(0));