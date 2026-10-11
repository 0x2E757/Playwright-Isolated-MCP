// Call limit, a tab that stays stuck after the interrupt (the page restarts its loop): only that tab is closed;
// the agent's other tab, on another site (another renderer process), is kept. ~65 s.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, webServer, pageState } from './helpers.mjs';

const srv = await startServer();
const good = await webServer('127.0.0.1', { '/': '<input id=i>' });
const bad = await webServer('127.0.0.2', { '/': '<p>wedges itself</p>' });
after(async () => { good.close(); bad.close(); await srv.stop(); });

test('a tab that stays stuck is closed; the other tab is kept', async () => {
  await srv.call('main', 'browser_navigate', { url: good.url('/') });
  await srv.call('main', 'browser_evaluate', { function: '() => { document.querySelector("#i").value = "kept"; }' });
  await srv.call('main', 'browser_tabs', { action: 'new' });
  await srv.call('main', 'browser_navigate', { url: bad.url('/') });

  const busy = await srv.call('main', 'browser_evaluate', { function: '() => { setInterval(() => { for (;;) {} }, 0); for (;;) {} }' });
  assert.ok(busy.isError);
  assert.ok(busy.ms >= 60_000 && busy.ms < 75_000, `answered after ${busy.ms} ms`);
  assert.match(busy.text, /Tabs that stayed unresponsive were closed \(cookies, logins and other tabs are kept\): http:\/\/127\.0\.0\.2:\d+\/\./);
  assert.doesNotMatch(busy.text, /127\.0\.0\.1/);
  assert.match(busy.text, /Take a snapshot/);

  const tabs = await srv.call('main', 'browser_tabs', { action: 'list' });
  assert.doesNotMatch(tabs.text, /127\.0\.0\.2/);
  assert.match(tabs.text, /127\.0\.0\.1/);
  await srv.call('main', 'browser_tabs', { action: 'select', index: 0 });
  const state = await pageState(srv.call, 'main');
  assert.ok(!state.isError, state.text);
  assert.equal(state.value, 'kept');
  assert.equal(state.url, good.url('/'));
});
