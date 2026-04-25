const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

const PROJECT_DIR = path.join(__dirname, '..');

test('smoke endpoints respond when server boots', async (t) => {
  const port = 43111 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: PROJECT_DIR,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      BOT_ENABLED: 'false',
      LOG_REQUESTS: 'false',
      PLATFORM_SEED: process.env.PLATFORM_SEED || 'word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12 word13 word14 word15 word16 word17 word18 word19 word20 word21 word22 word23 word24',
      PLATFORM_ADDRESS: process.env.PLATFORM_ADDRESS || 'z1qplcztj2xrflyh0l6csalv86jx32r9qfxr2qgc',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let startupOutput = '';
  child.stdout.on('data', (chunk) => { startupOutput += chunk.toString(); });
  child.stderr.on('data', (chunk) => { startupOutput += chunk.toString(); });

  t.after(async () => {
    if (!child.killed) child.kill('SIGTERM');
    await waitForExit(child, 3000);
  });

  const ready = await waitForServer(port, startupOutputRef(() => startupOutput));
  if (!ready.ok && /EPERM|EACCES|Sandbox/i.test(ready.error || startupOutput)) {
    t.skip(`Server bind blocked in current environment: ${ready.error || startupOutput}`);
    return;
  }

  assert.equal(ready.ok, true, startupOutput || ready.error);

  const [health, stats, readiness] = await Promise.all([
    fetchJson(`http://127.0.0.1:${port}/health`),
    fetchJson(`http://127.0.0.1:${port}/stats`),
    fetchJson(`http://127.0.0.1:${port}/ready`),
  ]);

  assert.equal(health.status, 'ok');
  assert.equal(typeof stats.sessions.total, 'number');
  assert.ok(['ready', 'starting'].includes(readiness.status));

  child.kill('SIGTERM');
  await waitForExit(child, 3000);
});

async function waitForServer(port, getOutput) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return { ok: true };
    } catch (err) {
      await sleep(150);
      if (Date.now() >= deadline) {
        return { ok: false, error: `${err.code || err.name}: ${err.message}\n${getOutput()}` };
      }
    }
  }
  return { ok: false, error: `Timed out waiting for server\n${getOutput()}` };
}

async function fetchJson(url) {
  const response = await fetch(url);
  assert.equal(response.ok, true, `Expected OK from ${url}, got ${response.status}`);
  return response.json();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function startupOutputRef(fn) {
  return fn;
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return Promise.resolve();

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) {}
      resolve();
    }, timeoutMs);

    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
