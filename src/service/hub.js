//
// Client bookkeeping for the daemon: framing, attach state, dispatch and
// error replies.
//
// Split out of tools/dockd.js so it can be tested without a socket and
// without hardware. That split earned itself immediately: "a detached client
// stops receiving key events" is the guarantee an app relies on to unhook
// itself when it loses focus, and while the logic lived inside the server the
// only way to check it was to ask a human to press buttons at the right
// moment. Now it is an assertion.
//
import { applyCommand, describe } from './commands.js';

/**
 * @param getDock  returns the live StreamDock, or null while it is away.
 * @param log      optional; called with human-readable lifecycle lines.
 * @param onApplied  optional; called with (message) after a client's command
 *   succeeds. The daemon uses it to notice that a client has taken over the
 *   panel, so it can stop painting its own status screen over their work.
 * @param onClients  optional; called with the client count whenever it
 *   changes, so the daemon can go back to its status screen when the last one
 *   leaves.
 */
export function createHub({ getDock, log = () => {}, onApplied = () => {}, onClients = () => {} }) {
  const clients = new Set();
  let seq = 0;

  const send = (client, object) => client.write(JSON.stringify(object) + '\n');

  /**
   * @param attachedOnly  true for device traffic a detached client asked not
   *   to receive (key presses); false for lifecycle news it still needs, since
   *   a client that unhooked for focus reasons must still learn that the panel
   *   went blank.
   */
  const broadcast = (event, { attachedOnly = true } = {}) => {
    for (const client of clients) {
      if (attachedOnly && !client.attached) continue;
      send(client, event);
    }
  };

  const handleLine = (client, line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      send(client, { type: 'error', message: 'not valid JSON' });
      return;
    }
    const id = message.id;
    try {
      // attach/detach and ping are about this client's relationship with the
      // daemon, not about the device, so they work with no dock attached.
      if (message.cmd === 'attach' || message.cmd === 'detach') {
        client.attached = message.cmd === 'attach';
        log(`client ${client.id} ${client.attached ? 'attached' : 'detached'}`);
        send(client, { type: 'ok', id, attached: client.attached });
        return;
      }
      if (message.cmd === 'ping') { send(client, { type: 'ok', id, pong: true }); return; }

      const dock = getDock();
      if (!dock) { send(client, { type: 'error', id, message: 'no dock connected' }); return; }
      if (!client.attached) {
        send(client, { type: 'error', id, message: 'detached; send {"cmd":"attach"} first' });
        return;
      }
      const result = applyCommand(dock, message);
      onApplied(message);
      send(client, { type: 'ok', id, ...result });
    } catch (err) {
      // An app under development sends nonsense constantly. Report it and keep
      // the connection: dropping the client would be miserable to debug.
      send(client, { type: 'error', id, message: err.message });
    }
  };

  return {
    get size() { return clients.size; },

    /** @param write  receives complete lines, newline included. */
    addClient({ write }) {
      const client = { write, attached: true, id: ++seq, buffer: '' };
      clients.add(client);
      log(`client ${client.id} connected (${clients.size} total)`);
      onClients(clients.size);

      const dock = getDock();
      send(client, {
        type: 'hello',
        protocol: 1,
        attached: true,
        ...(dock ? { state: 'online', ...describe(dock) } : { state: 'offline' }),
      });

      return {
        client,
        /**
         * TCP does not preserve message boundaries: a big keyImage arrives
         * split across chunks, and several small commands arrive glued into
         * one. So buffer, split on newlines, and keep the trailing partial.
         */
        feed(chunk) {
          client.buffer += chunk;
          const lines = client.buffer.split('\n');
          client.buffer = lines.pop();
          for (const line of lines) handleLine(client, line);
        },
        remove() {
          clients.delete(client);
          log(`client ${client.id} disconnected (${clients.size} left)`);
          onClients(clients.size);
        },
      };
    },

    broadcast,
  };
}
