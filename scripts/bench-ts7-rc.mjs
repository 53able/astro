import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tsc = process.env.TSC_BIN || join(root, '.ts-bench-tools', 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');
const benchConfig = join(root, '.astro-bench-tsconfig.json');
const iterations = Number(process.env.BENCH_ITERATIONS || '3');
const extraArgs = process.argv.slice(2);

async function sh(cmd, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { cwd: options.cwd ?? root, stdio: options.stdio ?? 'inherit', shell: process.platform === 'win32' });
    child.on('exit', (code) => code === 0 ? resolvePromise() : reject(new Error(`${cmd} ${args.join(' ')} exited ${code}`)));
  });
}

async function output(cmd, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => stdout += d);
    child.stderr.on('data', (d) => stderr += d);
    child.on('exit', (code) => code === 0 ? resolvePromise(stdout.trim()) : reject(new Error(`${cmd} ${args.join(' ')} exited ${code}\n${stdout}\n${stderr}`)));
  });
}

async function createBenchConfig() {
  const raw = await readFile(join(root, 'tsconfig.json'), 'utf8');
  const paths = [...raw.matchAll(/"path"\s*:\s*"([^"]+)"/g)].map((m) => m[1]);
  const satteri = './packages/markdown/satteri/tsconfig.json';
  if (!paths.includes(satteri)) {
    const astroIndex = paths.indexOf('./packages/astro/tsconfig.json');
    paths.splice(astroIndex >= 0 ? astroIndex : paths.length, 0, satteri);
  }
  await writeFile(benchConfig, JSON.stringify({ files: [], references: paths.map((path) => ({ path })) }, null, 2));
}

async function cleanGeneratedOutputs() {
  // Keep prebuilt dependency outputs that Astro's current solution config assumes exist.
  const keepPrefixes = [
    join(root, 'packages', 'astro-prism', 'dist'),
    join(root, 'packages', 'markdown', 'satteri', 'dist'),
  ];
  const targets = new Set(['.tsbuildinfo', 'dist', '.ts-temp']);
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const abs = join(dir, entry.name);
      if (keepPrefixes.some((prefix) => abs.startsWith(prefix))) continue;
      if (targets.has(entry.name)) {
        await rm(abs, { recursive: true, force: true });
        continue;
      }
      if (entry.isDirectory()) await walk(abs);
    }
  }
  await walk(root);
}

async function sampleRss(pid) {
  try {
    if (process.platform === 'win32') {
      const text = await output('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).WorkingSet64`]);
      return Number(text.trim()) || 0;
    }
    const text = await output('ps', ['-o', 'rss=', '-p', String(pid)]);
    return (Number(text.trim()) || 0) * 1024;
  } catch {
    return 0;
  }
}

async function timedRun(label, args) {
  await cleanGeneratedOutputs();
  return new Promise((resolvePromise) => {
    const started = process.hrtime.bigint();
    const child = spawn(tsc, ['-b', benchConfig, '--force', ...args], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
    let stdout = '';
    let stderr = '';
    let peakRss = 0;
    const timer = setInterval(async () => {
      peakRss = Math.max(peakRss, await sampleRss(child.pid));
    }, 100);
    child.stdout.on('data', (d) => stdout += d);
    child.stderr.on('data', (d) => stderr += d);
    child.on('exit', (code) => {
      clearInterval(timer);
      const elapsedSec = Number(process.hrtime.bigint() - started) / 1e9;
      resolvePromise({ label, code, elapsedSec, peakRss, stdoutTail: stdout.slice(-4000), stderrTail: stderr.slice(-4000), args });
    });
  });
}

async function main() {
  await createBenchConfig();
  await mkdir(join(root, '.ts-bench-tools'), { recursive: true });
  if (!existsSync(tsc)) {
    await writeFile(join(root, '.ts-bench-tools', 'package.json'), '{"private":true,"type":"module"}\n');
    await sh('npm', ['install', 'typescript@rc', '@typescript/typescript6'], { cwd: join(root, '.ts-bench-tools') });
  }

  // Required generated artifacts outside timed section.
  await sh('pnpm', ['--filter', 'astro', 'run', 'prebuild']);
  await sh(tsc, ['-b', 'packages/astro-prism/tsconfig.json', '--force']);
  await sh(tsc, ['-b', 'packages/markdown/satteri/tsconfig.json', '--force']);

  const meta = {
    repo: 'https://github.com/withastro/astro',
    commit: await output('git', ['rev-parse', '--short', 'HEAD']),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    tsc: await output(tsc, ['--version']),
    args: extraArgs,
    iterations,
  };
  const runs = [];
  for (let i = 0; i < iterations; i++) {
    const run = await timedRun(extraArgs.join(' ') || 'default', extraArgs);
    console.log(JSON.stringify(run));
    runs.push(run);
    if (run.code !== 0) break;
  }
  const result = { meta, runs };
  await mkdir(join(root, 'bench-results'), { recursive: true });
  const safeName = (extraArgs.join('_') || 'default').replace(/[^a-zA-Z0-9_.-]+/g, '_');
  const path = join(root, 'bench-results', `ts7-rc-${process.platform}-${safeName}.json`);
  await writeFile(path, JSON.stringify(result, null, 2));
  if (runs.some((run) => run.code !== 0)) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
