// Integration test: drives the playwright-isolated server over stdio like Claude Code does (needs Chrome and network).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../plugins/playwright-isolated/', import.meta.url));
const srv = spawn(process.execPath, [`${root}server/server.mjs`], { stdio: ['pipe', 'pipe', 'ignore'] });
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
after(async () => { srv.stdin.end(); await exited; });

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
