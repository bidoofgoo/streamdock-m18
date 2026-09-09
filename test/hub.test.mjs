//
// Tests for the daemon's client hub: framing, attach state, dispatch, errors.
// No sockets and no hardware; a fake client just collects the lines it is sent.
//
import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import { StreamDock } from '../src/device/streamdock.js';
import { MODELS } from '../src/device/models.js';
import { createHub } from '../src/service/hub.js';

class FakeHid extends EventEmitter {
  sent = [];
  write(bytes) { this.sent.push(Buffer.from(bytes)); return bytes.length; }
  close() {}
}

const setup = ({ withDock = true } = {}) => {
  const hid = new FakeHid();
  const dock = withDock ? new StreamDock(hid, MODELS.m18) : null;
  const hub = createHub({ getDock: () => dock });
  const connect = () => {
    const lines = [];
    const connection = hub.addClient({ write: line => lines.push(JSON.parse(line)) });
    return {
      ...connection,
      lines,
      send: object => connection.feed(JSON.stringify(object) + '\n'),
      last: () => lines[lines.length - 1],
      typed: type => lines.filter(l => l.type === type),
    };
  };
  return { hid, dock, hub, connect };
};

// --- a new client is greeted with the device description -----------------

{
  const { connect } = setup();
  const client = connect();
  const hello = client.lines[0];
  assert.equal(hello.type, 'hello');
  assert.equal(hello.protocol, 1);
  assert.equal(hello.state, 'online');
  assert.equal(hello.keys, 15);
  assert.equal(hello.attached, true);
}

{
  // with no dock, a client still connects and is told so, rather than hanging
  const { connect } = setup({ withDock: false });
  const client = connect();
  assert.equal(client.lines[0].state, 'offline');
  client.send({ cmd: 'key', index: 0, label: 'x', id: 1 });
  assert.deepEqual(client.last(), { type: 'error', id: 1, message: 'no dock connected' });
  // attach state and ping must work with no device present
  client.send({ cmd: 'ping', id: 2 });
  assert.equal(client.last().pong, true);
}

// --- THE guarantee an app's focus handling relies on ---------------------

{
  const { hub, connect } = setup();
  const attached = connect();
  const detached = connect();
  detached.send({ cmd: 'detach' });
  assert.equal(detached.last().attached, false);

  hub.broadcast({ type: 'key', index: 3, state: 1, aux: false });
  assert.equal(attached.typed('key').length, 1, 'an attached client receives key events');
  assert.equal(detached.typed('key').length, 0, 'a DETACHED client receives none');

  // but it must still be told the panel went blank, or it can never repaint
  hub.broadcast({ type: 'device', state: 'offline', reason: 'unplugged' }, { attachedOnly: false });
  assert.equal(detached.typed('device').length, 1, 'lifecycle news reaches detached clients too');

  // and a detached client is refused writes, with a message saying how to fix it
  detached.send({ cmd: 'brightness', value: 50, id: 9 });
  assert.match(detached.last().message, /detached; send \{"cmd":"attach"\}/);

  // attaching again restores both directions
  detached.send({ cmd: 'attach' });
  hub.broadcast({ type: 'key', index: 4, state: 1, aux: false });
  assert.equal(detached.typed('key').length, 1);
  detached.send({ cmd: 'brightness', value: 50, id: 10 });
  assert.equal(detached.last().type, 'ok');
}

// --- last writer wins, and every client sees every event -----------------

{
  const { hid, hub, connect } = setup();
  const a = connect();
  const b = connect();
  hid.sent = [];
  a.send({ cmd: 'brightness', value: 10 });
  b.send({ cmd: 'brightness', value: 90 });
  assert.equal(a.last().type, 'ok');
  assert.equal(b.last().type, 'ok');
  const lig = hid.sent.filter(x => x.subarray(6, 9).toString('latin1') === 'LIG');
  assert.equal(lig.at(-1)[11], 90, 'the later write wins; no locking, no ownership');

  hub.broadcast({ type: 'key', index: 1, state: 1, aux: false });
  assert.equal(a.typed('key').length, 1);
  assert.equal(b.typed('key').length, 1);
}

// --- framing: TCP does not preserve message boundaries -------------------

{
  const { connect } = setup();
  const client = connect();
  // one command split across three chunks, as a large keyImage really arrives
  client.feed('{"cmd":"pi');
  client.feed('ng","id":');
  assert.equal(client.typed('ok').length, 0, 'a partial line must not be acted on');
  client.feed('1}\n');
  assert.equal(client.last().id, 1, 'the reassembled line is handled once');

  // several commands glued into one chunk, plus a blank line
  client.feed('{"cmd":"ping","id":2}\n\n{"cmd":"ping","id":3}\n');
  assert.deepEqual(client.typed('ok').map(l => l.id), [1, 2, 3]);
}

// --- bad input never costs the connection --------------------------------

{
  const { connect } = setup();
  const client = connect();
  client.feed('not json at all\n');
  assert.deepEqual(client.last(), { type: 'error', message: 'not valid JSON' });
  client.send({ cmd: 'nope', id: 1 });
  assert.match(client.last().message, /unknown command/);
  client.send({ cmd: 'key', index: 999, id: 2 });
  assert.match(client.last().message, /index must be 0\.\.14/);
  // still alive and usable after all that
  client.send({ cmd: 'ping', id: 3 });
  assert.equal(client.last().pong, true);
}

// --- removal stops delivery ---------------------------------------------

{
  const { hub, connect } = setup();
  const client = connect();
  assert.equal(hub.size, 1);
  client.remove();
  assert.equal(hub.size, 0);
  hub.broadcast({ type: 'key', index: 0, state: 1, aux: false });
  assert.equal(client.typed('key').length, 0);
}

console.log('daemon hub tests passed');
