import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../dist/app.js';

function config() {
  return {
    port: 18765, host: '127.0.0.1', token: 'test-token-with-at-least-24-chars', nodeId: 'test-node',
    stateTtlMs: 60000, eventHistory: 16, maxBodyBytes: 524288, logLevel: 'silent',
    youtube: { enabled: false, oauthRequired: true, credentialsFile: './missing.json', maxPlaylistTracks: 10, cacheDir: './.cache-test' },
    audio: { ffmpegPath: 'ffmpeg', profile: 'eco', bitrateKbps: 96, bufferMs: 300, maxActivePlayers: 1, maxQueueSize: 10 }
  };
}

async function request(path, init = {}) {
  return fetch(`http://127.0.0.1:18765${path}`, {
    ...init,
    headers: { authorization: 'Bearer test-token-with-at-least-24-chars', 'content-type': 'application/json', ...init.headers }
  });
}

test('health, auth and rich player state', async () => {
  const app = createApp(config());
  await app.server.listen();
  try {
    assert.equal((await fetch('http://127.0.0.1:18765/health')).status, 200);
    assert.equal((await fetch('http://127.0.0.1:18765/v1/status')).status, 401);
    const put = await request('/v1/guilds/123/player', {
      method: 'PUT', body: JSON.stringify({ status: 'playing', extensions: { test: true } })
    });
    assert.equal(put.status, 200);
    const state = await (await request('/v1/guilds/123/player')).json();
    assert.equal(state.status, 'playing');
    assert.equal(state.extensions.test, true);
    const status = await (await request('/v1/status')).json();
    assert.equal(status.node.id, 'test-node');
  } finally { await app.close(); }
});
