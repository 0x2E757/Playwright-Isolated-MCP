// Integration test: drives the playwright-isolated server over stdio like Claude Code does (needs Chrome and network).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fileURLToPath(new URL('../plugins/playwright-isolated/', import.meta.url));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-isolated-test-')); // the output root under test
const srv = spawn(process.execPath, [`${root}server/server.mjs`], {
  stdio: ['pipe', 'pipe', 'ignore'],
  env: { ...process.env, PLAYWRIGHT_ISOLATED_OUTPUT_DIR: scratch },
});
const pending = new Map();
let nextId = 1;
readline.createInterface({ input: srv.stdout }).on('line', (l) => { const m = JSON.parse(l); pending.get(m.id)?.(m); });
const rpc = (method, params) => new Promise((r) => { const id = nextId++; pending.set(id, r); srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
const SESSION = `test-${process.pid}`;
const call = async (agent, name, args = {}) => {
  const r = (await rpc('tools/call', { name, arguments: agent ? { ...args, _agent: agent, _session: SESSION } : args })).result;
  return { text: r.content.map((c) => c.text ?? '').join('\n'), isError: Boolean(r.isError) };
};
const exited = new Promise((r) => srv.on('exit', r));
after(async () => {
  srv.stdin.end();
  await exited;
  fs.rmSync(scratch, { recursive: true, force: true });
});

await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });

test('engine tools are listed except browser_run_code_unsafe', async () => {
  const names = (await rpc('tools/list', {})).result.tools.map((t) => t.name);
  assert.ok(names.includes('browser_navigate') && names.includes('browser_snapshot'));
  assert.ok(!names.includes('browser_run_code_unsafe'));
});

test('untagged calls, hidden tools and long waits are refused', async () => {
  assert.match((await call(null, 'browser_navigate', { url: 'https://example.com' })).text, /no agent tag/);
  assert.ok((await call('main', 'browser_run_code_unsafe', { code: 'async () => 1' })).isError);
  assert.match((await call('main', 'browser_wait_for', { time: 31 })).text, /longer than 30s/);
});

test('agents have isolated contexts; SubagentStop closes a subagent context', async () => {
  const get = '() => localStorage.getItem("owner")';
  await call('main', 'browser_navigate', { url: 'https://example.com' });
  await call('sub', 'browser_navigate', { url: 'https://example.com' });
  await call('main', 'browser_evaluate', { function: '() => localStorage.setItem("owner", "main")' });
  await call('sub', 'browser_evaluate', { function: '() => localStorage.setItem("owner", "sub")' });
  assert.match((await call('main', 'browser_evaluate', { function: get })).text, /"main"/);
  assert.match((await call('sub', 'browser_evaluate', { function: get })).text, /"sub"/);
  assert.match((await call('main', 'browser_evaluate', { function: '() => `${innerWidth}x${innerHeight}`' })).text, /"1920x1080"/);

  execFileSync(process.execPath, [`${root}hooks/hook.mjs`, 'SubagentStop'], { input: JSON.stringify({ session_id: SESSION, agent_id: 'sub' }) });
  const tabs = await call('sub', 'browser_tabs', { action: 'list' });
  assert.doesNotMatch(tabs.text, /example\.com/); // a fresh context
  assert.match((await call('main', 'browser_evaluate', { function: get })).text, /"main"/); // main untouched
});

test('with PLAYWRIGHT_ISOLATED_OUTPUT_DIR, output files go to <root>/<date>--playwright-isolated-<session>/<agent>', async () => {
  const nav = await call('main', 'browser_navigate', { url: 'https://example.com' }); // saves a snapshot file
  const date = new Date().toISOString().slice(0, 10);
  const dir = path.join(scratch, `${date}--playwright-isolated-${SESSION.replace(/[^0-9a-zA-Z-]/g, '').slice(0, 8)}`, 'main');
  assert.ok(fs.readdirSync(dir).some((f) => f.endsWith('.yml')), `no snapshot file in ${dir}`);
  assert.ok(nav.text.includes(dir), 'tool results link files by absolute path');
  assert.ok(!fs.existsSync(path.join(process.cwd(), '.playwright-mcp')), 'nothing written into the working directory');
});

test('the session folder has a session.md brief listing the session and its agents', () => {
  const date = new Date().toISOString().slice(0, 10);
  const brief = fs.readFileSync(path.join(scratch, `${date}--playwright-isolated-${SESSION.replace(/[^0-9a-zA-Z-]/g, '').slice(0, 8)}`, 'session.md'), 'utf8');
  assert.match(brief, new RegExp(`^- Session: ${SESSION}$`, 'm'));
  assert.match(brief, /^- Working directory: .+$/m);
  assert.match(brief, /^- Plugin: playwright-isolated \d+\.\d+\.\d+, engine @playwright\/mcp \d+\.\d+\.\d+$/m);
  assert.match(brief, /^## Agents\n- \d\d:\d\d:\d\d main\n- \d\d:\d\d:\d\d sub\n/m);
});
