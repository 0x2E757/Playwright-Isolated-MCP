# playwright-isolated — Playwright MCP for multi-agent Claude Code

The official `@playwright/mcp` engine (pinned `0.0.83`), wrapped so that it is safe to use from many agents:

- **Isolation.** One Chrome per Claude Code session; the main agent and every subagent (parallel ones included)
  get their own `BrowserContext` and engine instance: separate tabs, cookies and storage. A `PreToolUse` hook
  tags each call with the agent and session (`_agent`, `_session`); untagged calls are refused.
- **Cleanup.** `SubagentStop` closes the subagent's context (local named pipe). When Claude Code exits or crashes,
  the server's stdin closes and it closes the browser. If the server itself dies, Windows kills Chrome with it
  (Node keeps its children in a kill-on-close job).
- **Limits.** Every call is capped at 60 s (a call over the limit is stopped by closing the agent's tabs; its
  context with cookies, logins and cart stays); `browser_wait_for` time at 30 s; navigation timeout 45 s.
- **Hidden tool.** `browser_run_code_unsafe` is not offered: it runs arbitrary code inside the server process
  ("RCE-equivalent" per its own description), where it could reach other agents' contexts and bypass the limits.

- **Output files out of your projects.** With `PLAYWRIGHT_ISOLATED_OUTPUT_DIR` set, the files the engine writes
  on its own — page snapshots, console logs, screenshots without a file name — go to
  `<PLAYWRIGHT_ISOLATED_OUTPUT_DIR>/<YYYY-MM-DD>--playwright-isolated-<session>/<agent>/` (one dated folder per
  session, like the [sessio](https://github.com/0x2E757/Omnium) plugin's scratch folders) and tool results link
  them by absolute path. The session folder also gets a `session.md` brief — session id, working directory,
  transcript path, start time, plugin and engine versions — with one line per agent as it starts using the browser.
  Unset: the engine's default, `.playwright-mcp/` in the working directory. Files an agent saves under an explicit
  name are resolved against the working directory either way (engine behaviour).

Everything else — tool set, tool descriptions, responses — is the engine's own behaviour. The server launches Chrome itself (one browser, a context
per agent) but with the engine's own isolated-mode launch options (Chrome sandbox on,
`--disable-blink-features=AutomationControlled`); `tests/parity.test.mjs` checks that the Chrome command line and
the page-visible browser properties match the official server's. Deliberate difference: Full HD viewport.

## Layout

```
plugins/playwright-isolated/
  .mcp.json                   MCP server "playwright" -> node server/server.mjs
  hooks/hooks.json, hook.mjs  PreToolUse (agent tags), SubagentStop (close context)
  server/server.mjs, ipc.mjs  the server; control pipe name
  package.json                dependency: @playwright/mcp 0.0.83 (exact)
tests/server.test.mjs         node --test tests/   (needs Chrome and network)
tests/parity.test.mjs         same Chrome launch and browser properties as the official server (Windows)
```

Not affiliated with Microsoft. The name follows the official server's `--isolated` (in-memory profile) and
extends it: every agent is isolated from every other agent. Tool names: `mcp__plugin_playwright-isolated_playwright__browser_*`.

## Install

Requires Node.js and Google Chrome (no browser is downloaded).

```bash
claude plugin marketplace add 0x2E757/Playwright-Isolated-MCP
claude plugin install playwright-isolated@playwright-isolated
```

Claude Code copies the plugin into its cache and installs the npm dependency from the committed lockfile
(exact versions, install scripts disabled).

## Development

A marketplace added from a local folder is loaded in place (edits apply from the next session), and its
dependencies are not installed automatically:

```bash
git clone https://github.com/0x2E757/Playwright-Isolated-MCP.git
cd Playwright-Isolated-MCP/plugins/playwright-isolated && npm ci
claude plugin marketplace add <absolute path of the clone>
claude plugin install playwright-isolated@playwright-isolated
# or for one session only:
claude --plugin-dir <clone>/plugins/playwright-isolated
```

## Settings

Environment variables, e.g. in the `env` block of Claude Code's `settings.json`:

| Variable | Effect |
|---|---|
| `PLAYWRIGHT_ISOLATED_OUTPUT_DIR` | Root folder for output files (see above). Unset: `.playwright-mcp/` in the working directory. |
| `PLAYWRIGHT_ISOLATED_VIEWPORT` | `WIDTHxHEIGHT`; default `1920x1080` (Full HD; Playwright's own default is 1280x720). |
| `PLAYWRIGHT_ISOLATED_HEADED` | `1` shows the browser window. |
