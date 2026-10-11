// playwright-isolated hooks: node hook.mjs <Event>  (hook JSON on stdin). Must never break the session: errors exit 0.
// - PreToolUse (playwright-isolated tools): tag the call with the calling agent and session, so the server can give
//   each agent its own browser context. No permission decision: the normal permission flow applies.
// - SubagentStop: ask this session's playwright-isolated server to close the finished subagent's browser context.
import net from 'node:net';
import { pipeName } from '../server/ipc.mjs';

const event = process.argv[2];
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', async () => {
  try {
    const data = JSON.parse(raw || '{}');
    if (event === 'PreToolUse') {
      const updatedInput = { ...(data.tool_input ?? {}), _agent: data.agent_id || 'main', _session: data.session_id };
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput } }));
    } else if (event === 'SubagentStop' && data.agent_id && data.session_id) {
      await closeAgent(data.session_id, data.agent_id);
    }
  } catch {}
  process.exit(0);
});

function closeAgent(session, agent) {
  return new Promise((resolve) => {
    const socket = net.connect(pipeName(session));
    const done = () => { socket.destroy(); resolve(); };
    socket.setTimeout(5000, done);
    socket.on('error', done); // no server for this session: nothing to close
    socket.on('connect', () => socket.write(JSON.stringify({ op: 'close-agent', agent }) + '\n'));
    socket.on('data', done);
  });
}
