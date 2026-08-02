import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../dist/app.js';

function config(port = 18765) {
  return {
    port, host: '127.0.0.1', token: 'test-token-with-at-least-24-chars', nodeId: 'test-node',
    stateTtlMs: 60000, eventHistory: 16, maxBodyBytes: 524288, logLevel: 'silent',
    youtube: { enabled: false, oauthRequired: true, credentialsFile: './missing.json', maxPlaylistTracks: 10, cacheDir: './.cache-test' },
    audio: { ffmpegPath: 'ffmpeg', profile: 'eco', bitrateKbps: 96, bufferMs: 300, maxActivePlayers: 1, maxQueueSize: 10 }
  };
}

function request(port, path, init = {}) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    ...init,
    headers: { authorization: 'Bearer test-token-with-at-least-24-chars', 'content-type': 'application/json', ...init.headers }
  });
}

test('health, auth and rich player state', async () => {
  const port = 18765;
  const app = createApp(config(port));
  await app.server.listen();
  try {
    assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${port}/v1/status`)).status, 401);
    const put = await request(port, '/v1/guilds/123/player', {
      method: 'PUT', body: JSON.stringify({ status: 'playing', extensions: { test: true } })
    });
    assert.equal(put.status, 200);
    const state = await (await request(port, '/v1/guilds/123/player')).json();
    assert.equal(state.status, 'playing');
    assert.equal(state.extensions.test, true);
    const status = await (await request(port, '/v1/status')).json();
    assert.equal(status.node.id, 'test-node');
  } finally { await app.close(); }
});

test('command validation rejects invalid values', async () => {
  const port = 18767;
  const app = createApp(config(port));
  await app.server.listen();
  try {
    const invalidVolume = await request(port, '/v1/guilds/123/commands', {
      method: 'POST', body: JSON.stringify({ name: 'setVolume', args: { volume: 'not-a-number' } })
    });
    assert.equal(invalidVolume.status, 400);
    assert.equal((await invalidVolume.json()).code, 'INVALID_VOLUME');

    const invalidRepeat = await request(port, '/v1/guilds/123/commands', {
      method: 'POST', body: JSON.stringify({ name: 'setRepeat', args: { mode: 'forever' } })
    });
    assert.equal(invalidRepeat.status, 400);
    assert.equal((await invalidRepeat.json()).code, 'INVALID_REPEAT_MODE');

    const invalidAutoplay = await request(port, '/v1/guilds/123/commands', {
      method: 'POST', body: JSON.stringify({ name: 'setAutoplay', args: { enabled: 'yes' } })
    });
    assert.equal(invalidAutoplay.status, 400);
    assert.equal((await invalidAutoplay.json()).code, 'INVALID_AUTOPLAY');
  } finally { await app.close(); }
});

test('server closes cleanly with an active SSE client', async () => {
  const port = 18768;
  const app = createApp(config(port));
  await app.server.listen();
  const responsePromise = request(port, '/v1/events');
  setTimeout(() => app.events.emit('TestEvent', { ok: true }), 10);
  const response = await responsePromise;
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.equal(first.done, false);

  await Promise.race([
    app.close(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('server close timed out')), 1000))
  ]);
  const end = await reader.read();
  assert.equal(end.done, true);
});
