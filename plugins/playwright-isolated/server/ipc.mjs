// Control pipe shared by the server and the hooks (local named pipe, no network).
export function pipeName(session) {
  return '\\\\.\\pipe\\playwright-isolated-' + String(session).replace(/[^0-9a-zA-Z-]/g, '');
}
