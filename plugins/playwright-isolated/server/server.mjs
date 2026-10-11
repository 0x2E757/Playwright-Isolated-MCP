// playwright-isolated: the @playwright/mcp engine for many Claude Code agents.
//
// - One Chrome per Claude Code session (a child of this process); each agent (main agent and every subagent)
//   gets its own BrowserContext and its own engine instance. The plugin's PreToolUse hook tags each call
//   with _agent / _session; untagged calls are refused, since without the tag there is no isolation.
// - Engine tools and responses are passed through unchanged, except: browser_run_code_unsafe is hidden
//   (it runs arbitrary code in this process and could reach other agents' contexts), every call is capped
//   at CALL_LIMIT_MS (see recoverTabs), and browser_wait_for is limited to WAIT_LIMIT_S.
// - Cleanup: SubagentStop closes the subagent's context (via a named pipe); when Claude Code goes away
//   (stdin closes) the browser is closed; if this process dies, Windows kills Chrome with it.
// - Output files go under PLAYWRIGHT_ISOLATED_OUTPUT_DIR when it is set, with a session.md brief (see outputConfig).
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline';
import { createConnection } from '@playwright/mcp';
import { chromium } from 'playwright';
import { pipeName } from './ipc.mjs';

const CALL_LIMIT_MS = 60_000;
const WAIT_LIMIT_S = 30;
const RESPOND_MS = 2_000; // a tab that does not run `1` within this is stuck
const ENGINE_CONFIG = { timeouts: { navigation: 45_000 } }; // navigation fails before the call limit
const HIDDEN_TOOLS = new Set(['browser_run_code_unsafe']);
const HEADLESS = process.env.PLAYWRIGHT_ISOLATED_HEADED !== '1';
// Full HD by default (Playwright's own default is 1280x720); PLAYWRIGHT_ISOLATED_VIEWPORT=WIDTHxHEIGHT overrides it.
const [VIEWPORT_W, VIEWPORT_H] = (/^(\d+)x(\d+)$/.exec(process.env.PLAYWRIGHT_ISOLATED_VIEWPORT ?? '') ?? [0, 1920, 1080]).slice(1).map(Number);

const log = (...a) => process.stderr.write(`[playwright-isolated] ${a.join(' ')}\n`);

// --- embedded engine: an in-memory MCP client per agent ---------------------------------------------
async function connectEngine(contextGetter, extraConfig = {}) {
  const server = await createConnection({ ...ENGINE_CONFIG, ...extraConfig }, contextGetter);
  const pending = new Map();
  let nextId = 1;
  const transport = {
    start: async () => {},
    close: async () => {},
    send: async (msg) => {
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    },
  };
  await server.connect(transport);
  const request = (method, params) =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      transport.onmessage({ jsonrpc: '2.0', id, method, params });
    });
  await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'playwright-isolated', version: '0' } });
  transport.onmessage({ jsonrpc: '2.0', method: 'notifications/initialized' });
  return { request, close: () => server.close().catch(() => {}) };
}

// --- browser and agents -------------------------------------------------------------------------------
let browserPromise = null;
const agents = new Map(); // agent id -> { ready, context, engine, queue }

// The same launch options the engine uses in its own isolated mode (validateBrowserConfig + createIsolatedBrowser
// in @playwright/mcp 0.0.83); tests/parity.test.mjs checks that the Chrome command lines match.
const LAUNCH_OPTIONS = {
  channel: 'chrome',
  headless: HEADLESS,
  chromiumSandbox: true,
  args: ['--disable-blink-features=AutomationControlled'],
  handleSIGINT: false,
  handleSIGTERM: false,
};

function getBrowser() {
  browserPromise ??= chromium.launch(LAUNCH_OPTIONS).then((browser) => {
    browser.on('disconnected', () => { browserPromise = null; agents.clear(); });
    return browser;
  });
  return browserPromise;
}

// --- output files ---------------------------------------------------------------------------------------
// Where the engine writes auto-named files (snapshots, console logs, screenshots without a file name).
// With PLAYWRIGHT_ISOLATED_OUTPUT_DIR set: <root>/<YYYY-MM-DD>--playwright-isolated-<session>/<agent>
// (dated per-session folders, like the sessio plugin's), absolute paths in tool results, and a session.md
// brief in the session folder. Unset: the engine's default, .playwright-mcp in the working directory.
const OUTPUT_ROOT = (process.env.PLAYWRIGHT_ISOLATED_OUTPUT_DIR ?? '').trim();
const safeName = (s) => String(s ?? '').replace(/[^0-9a-zA-Z-]/g, '');
let sessionDir = null; // fixed at the session's first call, so agents started after midnight stay in it

function timestamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const zone = `${off >= 0 ? '+' : '-'}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`;
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ${zone}`;
}

function versions() {
  const read = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')).version; } catch { return '?'; } };
  return {
    plugin: read(new URL('../.claude-plugin/plugin.json', import.meta.url)),
    engine: read(createRequire(import.meta.url).resolve('@playwright/mcp/package.json')),
  };
}

/** The session folder, created with its session.md brief at the first call; null without an output root. */
function sessionFolder(meta) {
  if (!OUTPUT_ROOT) return null;
  if (!sessionDir) {
    const date = new Date().toISOString().slice(0, 10);
    sessionDir = path.join(OUTPUT_ROOT, `${date}--playwright-isolated-${safeName(meta.session).slice(0, 8) || 'session'}`);
    const v = versions();
    try {
      fs.mkdirSync(sessionDir, { recursive: true });
      fs.writeFileSync(path.join(sessionDir, 'session.md'), [
        '# playwright-isolated session',
        `- Session: ${meta.session ?? '?'}`,
        `- Working directory: ${meta.cwd ?? process.cwd()}`,
        ...(meta.transcript ? [`- Transcript: ${meta.transcript}`] : []),
        `- Started: ${timestamp()}`,
        `- Plugin: playwright-isolated ${v.plugin}, engine @playwright/mcp ${v.engine}`,
        '',
        '## Agents',
        '',
      ].join('\n'));
    } catch (e) { log('cannot write session brief:', e.message); }
  }
  return sessionDir;
}

function outputConfig(agentId, meta) {
  const dir = sessionFolder(meta);
  if (!dir) return {};
  try {
    fs.appendFileSync(path.join(dir, 'session.md'),
      `- ${timestamp().slice(11, 19)} ${agentId}${meta.agentType ? ` (${meta.agentType})` : ''}\n`);
  } catch (e) { log('cannot update session brief:', e.message); }
  return { outputDir: path.join(dir, safeName(agentId) || 'agent'), filePaths: 'absolute' };
}

// --- call limit: recover the agent's tabs instead of closing them ---------------------------------------
// A CDP session per tab, attached when the tab opens: a tab whose page is stuck no longer accepts a new one.
const cdpSessions = new WeakMap(); // page -> Promise<CDPSession | null>
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function watchTabs(context) {
  context.on('page', (page) => cdpSessions.set(page, context.newCDPSession(page).catch(() => null)));
}

async function responds(page) {
  const cdp = await cdpSessions.get(page);
  const probe = cdp ? cdp.send('Runtime.evaluate', { expression: '1' }) : page.evaluate('1');
  return Promise.race([probe.then(() => true, () => false), sleep(RESPOND_MS).then(() => false)]);
}

/**
 * After a call ran over the limit (it is no longer awaited and may still finish in the background), check each
 * of the agent's tabs: a responsive tab is left alone; a stuck page (JavaScript busy, e.g. an endless loop) gets
 * its running script interrupted; a tab still stuck after that is closed. Only stuck tabs are touched.
 */
async function recoverTabs(agent) {
  const interrupted = [];
  const closed = [];
  await Promise.all((agent.context?.pages() ?? []).map(async (page) => {
    if (await responds(page)) return;
    const url = page.url();
    await (await cdpSessions.get(page))?.send('Runtime.terminateExecution').catch(() => {});
    if (await responds(page)) return interrupted.push(url);
    closed.push(url);
    await Promise.race([page.close().catch(() => {}), sleep(5_000)]);
  }));
  return { interrupted, closed, left: agent.context?.pages().length ?? 0 };
}

function overLimitResult({ interrupted, closed, left }) {
  const list = (urls) => urls.map((u) => u || 'about:blank').join(', ');
  return errorResult([
    `This call did not finish within the ${CALL_LIMIT_MS / 1000}s limit. It is no longer awaited and may still finish in the background.`,
    interrupted.length ? `The page's JavaScript was stuck and was interrupted (the tab is kept): ${list(interrupted)}.` : '',
    closed.length ? `Tabs that stayed unresponsive were closed (cookies, logins and other tabs are kept): ${list(closed)}.` : '',
    left ? 'Take a snapshot to see the current state, then continue in shorter steps.' : 'Navigate again and continue in shorter steps.',
  ].filter(Boolean).join(' '));
}

function agentFor(id, meta) {
  if (!agents.has(id)) {
    const agent = { queue: Promise.resolve() };
    agent.ready = (async () => {
      agent.context = await (await getBrowser()).newContext({ viewport: { width: VIEWPORT_W, height: VIEWPORT_H } });
      watchTabs(agent.context);
      agent.engine = await connectEngine(async () => agent.context, outputConfig(id, meta));
    })();
    agents.set(id, agent);
  }
  return agents.get(id);
}

async function closeAgent(id) {
  const agent = agents.get(id);
  if (!agent) return;
  agents.delete(id);
  await agent.ready.catch(() => {});
  await agent.engine?.close();
  await agent.context?.close().catch(() => {});
}

// --- tools -----------------------------------------------------------------------------------------------
const errorResult = (text) => ({ content: [{ type: 'text', text }], isError: true });

let toolsPromise = null;
function listTools() {
  toolsPromise ??= (async () => {
    const probe = await connectEngine(async () => { throw new Error('tool listing only'); });
    const { tools } = (await probe.request('tools/list', {})).result;
    await probe.close();
    return tools.filter((t) => !HIDDEN_TOOLS.has(t.name));
  })();
  return toolsPromise;
}

async function callTool(params) {
  const { name } = params;
  const { _agent: agentId, _session: session, _agent_type: agentType, _cwd: cwd, _transcript: transcript, ...args } =
    params.arguments ?? {};
  if (!agentId) return errorResult('playwright-isolated refused the call: no agent tag (the playwright-isolated plugin hook is not active).');
  if (HIDDEN_TOOLS.has(name)) return errorResult(`${name} is not available.`);
  if (name === 'browser_wait_for' && Number(args.time) > WAIT_LIMIT_S) {
    return errorResult(`Waits longer than ${WAIT_LIMIT_S}s are not allowed. Wait for a specific text, or wait a few seconds and check the page again.`);
  }
  if (session) startControlPipe(session);

  const agent = agentFor(agentId, { session, agentType, cwd, transcript });
  // One call at a time per agent; different agents run in parallel. The limit counts from the start of the
  // call (not its time in the queue); a call over it is no longer awaited, which frees the agent's queue.
  const run = agent.queue.then(() => {
    const call = (async () => {
      await agent.ready;
      const res = await agent.engine.request('tools/call', { name, arguments: args });
      if (name === 'browser_close') await closeAgent(agentId);
      return res.error ? errorResult(res.error.message) : res.result;
    })().catch((e) => errorResult(e.message));
    let timer;
    let overLimit = false;
    const limit = new Promise((resolve) => {
      timer = setTimeout(() => {
        overLimit = true;
        recoverTabs(agent).then((r) => resolve(overLimitResult(r)));
      }, CALL_LIMIT_MS);
    });
    // Once over the limit, the answer is the limit's: recovery itself can end the call (an interrupted script
    // fails it), and that error must not win the race.
    return Promise.race([call.then((r) => (overLimit ? limit : r)), limit]).finally(() => clearTimeout(timer));
  });
  agent.queue = run.catch(() => {});
  return run;
}

// --- control pipe: SubagentStop hook -> close that agent's context ---------------------------------------
let pipeStarted = false;
function startControlPipe(session) {
  if (pipeStarted) return;
  pipeStarted = true;
  const server = net.createServer((socket) => {
    let buf = '';
    socket.on('data', async (chunk) => {
      buf += chunk;
      if (!buf.includes('\n')) return;
      try {
        const msg = JSON.parse(buf.split('\n')[0]);
        if (msg.op === 'close-agent') await closeAgent(msg.agent);
        socket.end('ok\n');
      } catch { socket.end('error\n'); }
    });
    socket.on('error', () => {});
  });
  server.on('error', (e) => log('control pipe error:', e.message));
  server.listen(pipeName(session));
  server.unref();
}

// --- shutdown: Claude Code closed our stdin (exit or crash) ---------------------------------------------
let shuttingDown = false;
async function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('shutting down:', reason);
  const browser = browserPromise && (await browserPromise.catch(() => null));
  await Promise.race([browser?.close(), new Promise((r) => setTimeout(r, 5000))]).catch(() => {});
  process.exit(0);
}

// --- MCP stdio protocol ------------------------------------------------------------------------------------
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');

async function handle({ id, method, params }) {
  try {
    if (method === 'initialize') {
      return send({ jsonrpc: '2.0', id, result: {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'playwright-isolated', version: '0.5.0' },
      } });
    }
    if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: await listTools() } });
    if (method === 'tools/call') return send({ jsonrpc: '2.0', id, result: await callTool(params) });
    if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
    if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
  } catch (e) {
    log('error', e.stack);
    if (id !== undefined) send({ jsonrpc: '2.0', id, result: errorResult(`playwright-isolated internal error: ${e.message}`) });
  }
}

readline.createInterface({ input: process.stdin })
  .on('line', (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    handle(msg);
  })
  .on('close', () => shutdown('stdin closed'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
