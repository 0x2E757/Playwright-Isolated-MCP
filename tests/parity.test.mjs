// Parity with the official server: same Chrome command line and the same page-visible browser properties.
// Windows only (reads process command lines); needs Chrome and network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execSync } from 'node:child_process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../plugins/playwright-isolated/', import.meta.url));

async function start(args, tagged) {
  const env = { ...process.env };
  delete env.PLAYWRIGHT_ISOLATED_OUTPUT_DIR; // compare both servers with the engine's default output location
  const srv = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'ignore'], cwd: process.env.TEMP, env });
  const pending = new Map();
  let id = 1;
  readline.createInterface({ input: srv.stdout }).on('line', (l) => { const m = JSON.parse(l); pending.get(m.id)?.(m); });
  const rpc = (method, params) => new Promise((r) => { const i = id++; pending.set(i, r); srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n'); });
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const call = async (name, a) => (await rpc('tools/call', { name, arguments: tagged ? { ...a, _agent: 'main', _session: 'parity' } : a })).result.content[0].text;
  await call('browser_navigate', { url: 'https://example.com' });
  const page = await call('browser_evaluate', {
    function: '() => JSON.stringify({ webdriver: navigator.webdriver, ua: navigator.userAgent, langs: navigator.languages, dpr: devicePixelRatio, tz: Intl.DateTimeFormat().resolvedOptions().timeZone })',
  });
  const exited = new Promise((r) => srv.on('exit', r));
  return { pid: srv.pid, page: page.split('\n')[1], stop: () => { srv.stdin.end(); return exited; } };
}

function chromeArgs(serverPid) {
  const ps = `$ids = @(${serverPid}) + @((Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq ${serverPid} }).ProcessId); ` +
    `(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $ids -contains $_.ParentProcessId -and $_.CommandLine -notmatch '--type=' }).CommandLine`;
  const cmd = execSync('powershell -NoProfile -Command -', { input: ps }).toString().trim();
  return new Set(cmd.match(/--[^\s"]+(?:="[^"]*"|=[^\s]*)?/g)
    .map((a) => a.replace(/playwright_chromiumdev_profile-\w+/, 'PROFILE').replace(/=\d{4,}$/, '=PORT')));
}

test('Chrome is launched exactly like the official server does it', { skip: process.platform !== 'win32' }, async () => {
  const official = await start([`${root}node_modules/@playwright/mcp/cli.js`, '--isolated', '--headless', '--browser', 'chrome'], false);
  const ours = await start([`${root}server/server.mjs`], true);
  try {
    const [a, b] = [chromeArgs(official.pid), chromeArgs(ours.pid)];
    assert.deepEqual([...b].filter((x) => !a.has(x)), [], 'arguments only playwright-isolated passes');
    assert.deepEqual([...a].filter((x) => !b.has(x)), [], 'arguments only the official server passes');
    assert.equal(ours.page, official.page);
  } finally {
    await Promise.all([official.stop(), ours.stop()]);
  }
});
