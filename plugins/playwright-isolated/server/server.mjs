// playwright-isolated: the @playwright/mcp engine for many Claude Code agents.
//
// - One Chrome per Claude Code session (a child of this process); each agent (main agent and every subagent)
//   gets its own BrowserContext and its own engine instance. The plugin's PreToolUse hook tags each call
//   with _agent / _session; untagged calls are refused, since without the tag there is no isolation.
// - Engine tools and responses are passed through unchanged, except: browser_run_code_unsafe is hidden
//   (it runs arbitrary code in this process and could reach other agents' contexts), every call is capped
//   at CALL_LIMIT_MS, and browser_wait_for is limited to WAIT_LIMIT_S.
// - Cleanup: SubagentStop closes the subagent's context (via a named pipe); when Claude Code goes away
//   (stdin closes) the browser is closed; if this process dies, Windows kills Chrome with it.
import net from 'node:net';
import readline from 'node:readline';
import { createConnection } from '@playwright/mcp';
import { chromium } from 'playwright';
import { pipeName } from './ipc.mjs';

const CALL_LIMIT_MS = 60_000;
const WAIT_LIMIT_S = 30;
const ENGINE_CONFIG = { timeouts: { navigation: 45_000 } }; // navigation fails before the call limit
const HIDDEN_TOOLS = new Set(['browser_run_code_unsafe']);
const HEADLESS = process.env.PLAYWRIGHT_ISOLATED_HEADED !== '1';
// Full HD by default (Playwright's own default is 1280x720); PLAYWRIGHT_ISOLATED_VIEWPORT=WIDTHxHEIGHT overrides it.
const [VIEWPORT_W, VIEWPORT_H] = (/^(\d+)x(\d+)$/.exec(process.env.PLAYWRIGHT_ISOLATED_VIEWPORT ?? '') ?? [0, 1920, 1080]).slice(1).map(Number);

const log = (...a) => process.stderr.write(`[playwright-isolated] ${a.join(' ')}\n`);

// --- embedded engine: an in-memory MCP client per agent ---------------------------------------------
async function connectEngine(contextGetter) {
  const server = await createConnection(ENGINE_CONFIG, contextGetter);
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

function agentFor(id) {
  if (!agents.has(id)) {
    const agent = { queue: Promise.resolve() };
    agent.ready = (async () => {
      agent.context = await (await getBrowser()).newContext({ viewport: { width: VIEWPORT_W, height: VIEWPORT_H } });
      agent.engine = await connectEngine(async () => agent.context);
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
  const { _agent: agentId, _session: session, ...args } = params.arguments ?? {};
  if (!agentId) return errorResult('playwright-isolated refused the call: no agent tag (the playwright-isolated plugin hook is not active).');
  if (HIDDEN_TOOLS.has(name)) return errorResult(`${name} is not available.`);
  if (name === 'browser_wait_for' && Number(args.time) > WAIT_LIMIT_S) {
    return errorResult(`Waits longer than ${WAIT_LIMIT_S}s are not allowed. Wait for a specific text, or wait a few seconds and check the page again.`);
  }
  if (session) startControlPipe(session);

  const agent = agentFor(agentId);
  // One call at a time per agent; different agents run in parallel.
  const run = agent.queue.then(async () => {
    await agent.ready;
    const res = await agent.engine.request('tools/call', { name, arguments: args });
    if (name === 'browser_close') await closeAgent(agentId);
    return res.error ? errorResult(res.error.message) : res.result;
  });
  agent.queue = run.catch(() => {});
  let timer;
  const limit = new Promise((resolve) => {
    timer = setTimeout(async () => {
      // Stop the runaway call: closing the agent's tabs aborts it (and frees the agent's queue);
      // the context, with its cookies, logins and cart, stays.
      await Promise.all((agent.context?.pages() ?? []).map((p) => p.close().catch(() => {})));
      resolve(errorResult(
        `This call took longer than the ${CALL_LIMIT_MS / 1000}s limit and was stopped by closing your tabs ` +
        '(cookies, logins and cart are kept). Navigate again and continue in shorter steps.'));
    }, CALL_LIMIT_MS);
  });
  return Promise.race([run.catch((e) => errorResult(e.message)), limit]).finally(() => clearTimeout(timer));
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
        serverInfo: { name: 'playwright-isolated', version: '0.3.0' },
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
