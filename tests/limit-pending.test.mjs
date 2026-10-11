// Call limit, responsive tab: a call waiting on something slow (an 70 s fetch) is let go at 60 s; the tab, its
// state and the agent's queue are kept, and the late finish in the background breaks nothing. ~75 s.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, webServer, pageState } from './helpers.mjs';

const srv = await startServer();
const web = await webServer('127.0.0.1', { '/': '<input id=i>', '/slow': { html: 'late data', delayMs: 70_000 } });
after(async () => { web.close(); await srv.stop(); });

test('a call stuck on a slow fetch is let go at the limit; the tab is kept untouched', async () => {
  await srv.call('main', 'browser_navigate', { url: web.url('/') });
  await srv.call('main', 'browser_evaluate', { function: '() => { document.querySelector("#i").value = "kept"; }' });

  const slow = await srv.call('main', 'browser_evaluate', { function: 'async () => (await fetch("/slow")).text()' });
  assert.ok(slow.isError);
  assert.ok(slow.ms >= 60_000 && slow.ms < 70_000, `answered after ${slow.ms} ms`);
  assert.match(slow.text, /did not finish within the 60s limit\. It is no longer awaited/);
  assert.doesNotMatch(slow.text, /interrupted|closed/);
  assert.match(slow.text, /Take a snapshot/);

  const state = await pageState(srv.call, 'main');
  assert.equal(state.value, 'kept');
  assert.equal(state.url, web.url('/'));
  assert.ok(state.ms < 5_000, `next call took ${state.ms} ms (queue not freed?)`);
  const tabs = await srv.call('main', 'browser_tabs', { action: 'list' });
  assert.equal(tabs.text.match(/127\.0\.0\.1/g)?.length, 1, tabs.text);
});

test('the abandoned call finishing later in the background breaks nothing', async () => {
  await web.served('/slow');
  await new Promise((r) => setTimeout(r, 1_000));
  const state = await pageState(srv.call, 'main');
  assert.ok(!state.isError, state.text);
  assert.equal(state.value, 'kept');
  const snap = await srv.call('main', 'browser_snapshot');
  assert.ok(!snap.isError, snap.text);
  assert.match(snap.text, /textbox/);
});
