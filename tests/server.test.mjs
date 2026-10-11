// Integration test: drives the playwright-isolated server over stdio like Claude Code does (needs Chrome and network).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { root, startServer } from './helpers.mjs';

const { rpc, call, stop, scratch, session: SESSION } = await startServer(); // scratch: the output root under test
after(stop);

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
