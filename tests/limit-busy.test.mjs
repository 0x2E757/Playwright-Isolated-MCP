// Call limit, stuck page: an endless JavaScript loop is interrupted at 60 s and the tab is kept. ~65 s.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, webServer, pageState } from './helpers.mjs';

const srv = await startServer();
const web = await webServer('127.0.0.1', { '/': '<input id=i>' });
after(async () => { web.close(); await srv.stop(); });

test('an endless loop is interrupted at the limit; the tab and its state are kept', async () => {
  await srv.call('main', 'browser_navigate', { url: web.url('/') });
  await srv.call('main', 'browser_evaluate', { function: '() => { document.querySelector("#i").value = "kept"; }' });

  const busy = await srv.call('main', 'browser_evaluate', { function: '() => { for (;;) {} }' });
  assert.ok(busy.isError);
  assert.ok(busy.ms >= 60_000 && busy.ms < 70_000, `answered after ${busy.ms} ms`);
  assert.match(busy.text, /did not finish within the 60s limit/);
  assert.match(busy.text, new RegExp(`JavaScript was stuck and was interrupted \\(the tab is kept\\): ${web.url('/').replace(/[.]/g, '\\.')}`));
  assert.doesNotMatch(busy.text, /closed/);
  assert.match(busy.text, /Take a snapshot/);

  const state = await pageState(srv.call, 'main');
  assert.ok(!state.isError, state.text);
  assert.equal(state.value, 'kept');
  assert.equal(state.url, web.url('/'));
  assert.ok(state.ms < 5_000, `next call took ${state.ms} ms`);
});
