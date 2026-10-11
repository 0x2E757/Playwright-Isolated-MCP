// Shared test helpers: drive the playwright-isolated server over stdio like Claude Code does, and serve local pages.
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

export const root = fileURLToPath(new URL('../plugins/playwright-isolated/', import.meta.url));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Starts the server with its own scratch output root. call(agent, tool, args) -> { text, isError, ms }. */
export async function startServer() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-isolated-test-'));
  const srv = spawn(process.execPath, [`${root}server/server.mjs`], {
    stdio: ['pipe', 'pipe', 'ignore'],
    env: { ...process.env, PLAYWRIGHT_ISOLATED_OUTPUT_DIR: scratch },
  });
  const pending = new Map();
  let nextId = 1;
  readline.createInterface({ input: srv.stdout }).on('line', (l) => { const m = JSON.parse(l); pending.get(m.id)?.(m); });
  const rpc = (method, params) => new Promise((r) => {
    const id = nextId++;
    pending.set(id, r);
    srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const session = `test-${process.pid}`;
  const call = async (agent, name, args = {}) => {
    const started = Date.now();
    const r = (await rpc('tools/call', { name, arguments: agent ? { ...args, _agent: agent, _session: session } : args })).result;
    return { text: r.content.map((c) => c.text ?? '').join('\n'), isError: Boolean(r.isError), ms: Date.now() - started };
  };
  const exited = new Promise((r) => srv.on('exit', r));
  const stop = async () => {
    srv.stdin.end();
    await exited;
    fs.rmSync(scratch, { recursive: true, force: true });
  };
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  return { rpc, call, stop, scratch, session };
}

/**
 * A local web server on `host` (127.0.0.1, or 127.0.0.2 for a second site). routes: path -> html string,
 * or { html, delayMs } to answer late. Returns { url(path), served(path) -> Promise when that path was answered, close }.
 */
export async function webServer(host, routes) {
  const answered = new Map();
  const mark = (p) => { if (!answered.has(p)) answered.set(p, Promise.withResolvers()); return answered.get(p); };
  const server = http.createServer((req, res) => {
    const route = routes[req.url];
    if (route === undefined) { res.statusCode = 404; return res.end(); }
    const { html, delayMs = 0 } = typeof route === 'string' ? { html: route } : route;
    setTimeout(() => {
      res.setHeader('content-type', 'text/html');
      res.end(html);
      mark(req.url).resolve();
    }, delayMs);
  });
  await new Promise((r) => server.listen(0, host, r));
  const base = `http://${host}:${server.address().port}`;
  return {
    url: (p = '/') => base + p,
    served: (p) => mark(p).promise,
    close: () => { server.closeAllConnections(); server.close(); },
  };
}

/** The value of #i and the page URL of the agent's current tab, via browser_evaluate. */
export async function pageState(call, agent) {
  const r = await call(agent, 'browser_evaluate', { function: '() => JSON.stringify({ value: document.querySelector("#i")?.value, url: location.href })' });
  const m = /"(\{.*\})"/.exec(r.text);
  return { ...(m ? JSON.parse(JSON.parse(`"${m[1]}"`)) : {}), ms: r.ms, isError: r.isError, text: r.text };
}
