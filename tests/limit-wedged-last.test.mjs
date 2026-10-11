// Call limit, the agent's only tab stays stuck: it is closed, the agent is told to navigate again, and can. ~65 s.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, webServer, pageState } from './helpers.mjs';

const srv = await startServer();
const web = await webServer('127.0.0.1', { '/': '<input id=i>' });
after(async () => { web.close(); await srv.stop(); });

test('the only tab staying stuck is closed; navigating again works, cookies are kept', async () => {
  await srv.call('main', 'browser_navigate', { url: web.url('/') });
  await srv.call('main', 'browser_evaluate', { function: '() => { document.cookie = "login=kept; path=/"; }' });

  const busy = await srv.call('main', 'browser_evaluate', { function: '() => { setInterval(() => { for (;;) {} }, 0); for (;;) {} }' });
  assert.ok(busy.isError);
  assert.ok(busy.ms >= 60_000 && busy.ms < 75_000, `answered after ${busy.ms} ms`);
  assert.match(busy.text, /Tabs that stayed unresponsive were closed/);
  assert.match(busy.text, /Navigate again and continue in shorter steps\./);

  const nav = await srv.call('main', 'browser_navigate', { url: web.url('/') });
  assert.ok(!nav.isError, nav.text);
  assert.ok(nav.ms < 10_000, `navigate took ${nav.ms} ms`);
  const cookie = await srv.call('main', 'browser_evaluate', { function: '() => document.cookie' });
  assert.match(cookie.text, /login=kept/);
  assert.ok(!(await pageState(srv.call, 'main')).isError);
});
