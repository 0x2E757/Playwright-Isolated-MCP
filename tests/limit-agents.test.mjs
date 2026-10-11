// Call limit and agents: while one agent's call is stuck, other agents work normally and are not touched by its
// recovery (same site, but every agent has its own browser context, so its own renderer processes); the stuck
// agent's next, queued call starts once the limit lets the stuck one go, and gets its own full limit. ~65 s.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, webServer, pageState } from './helpers.mjs';

const srv = await startServer();
const web = await webServer('127.0.0.1', { '/': '<input id=i>' });
after(async () => { web.close(); await srv.stop(); });

test('a stuck agent blocks only itself; its queued call runs after the limit', async () => {
  await srv.call('a', 'browser_navigate', { url: web.url('/') });
  await srv.call('b', 'browser_navigate', { url: web.url('/') });
  await srv.call('b', 'browser_evaluate', { function: '() => { document.querySelector("#i").value = "b kept"; }' });

  const started = Date.now();
  const stuck = srv.call('a', 'browser_evaluate', { function: '() => { for (;;) {} }' });
  await new Promise((r) => setTimeout(r, 2_000));
  const queued = srv.call('a', 'browser_evaluate', { function: '() => 6 * 7' }); // waits behind the stuck call

  for (let i = 0; i < 3; i++) { // agent b keeps working meanwhile
    const b = await pageState(srv.call, 'b');
    assert.equal(b.value, 'b kept');
    assert.ok(b.ms < 5_000, `agent b call took ${b.ms} ms while agent a was stuck`);
  }

  const first = await stuck;
  assert.ok(first.isError);
  assert.match(first.text, /did not finish within the 60s limit/);
  assert.match(first.text, /interrupted/);

  const second = await queued;
  assert.ok(!second.isError, second.text);
  assert.match(second.text, /42/);
  const total = Date.now() - started;
  assert.ok(total >= 60_000 && total < 75_000, `queued call finished ${total} ms after the stuck one started`);

  const b = await pageState(srv.call, 'b');
  assert.equal(b.value, 'b kept'); // agent a's recovery did not touch agent b's tab
});
