import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { EventBus } from '../dist/event-bus.js';
import { PlayerStore } from '../dist/player-store.js';
import { SourceRegistry } from '../dist/providers/provider.js';
import { VoiceManager } from '../dist/discord/voice.js';

function config(maxActivePlayers = 1) {
  return {
    port: 18766, host: '127.0.0.1', token: 'test-token-with-at-least-24-chars', nodeId: 'test-node',
    stateTtlMs: 60000, eventHistory: 64, maxBodyBytes: 524288, logLevel: 'silent',
    youtube: { enabled: false, oauthRequired: true, credentialsFile: './missing.json', maxPlaylistTracks: 10, cacheDir: './.cache-test' },
    audio: { ffmpegPath: 'ffmpeg', profile: 'eco', bitrateKbps: 96, bufferMs: 300, maxActivePlayers, maxQueueSize: 10 }
  };
}

class MockPlayer extends EventEmitter {
  resource;
  play(resource) { this.resource = resource; queueMicrotask(() => this.emit('playing')); }
  pause() { this.emit('paused'); return true; }
  unpause() { this.emit('playing'); return true; }
  stop() { this.emit('idle'); return true; }
}

class MockConnection extends EventEmitter {
  player;
  destroyed = false;
  subscribe(player) { this.player = player; return {}; }
  destroy() { this.destroyed = true; }
}

function mockVoice() {
  const updates = { server: [], state: [], adapterDestroyed: 0, gatewayPayloads: [] };
  const players = [];
  const connections = [];
  const voice = {
    AudioPlayerStatus: { Playing: 'playing', Paused: 'paused', Idle: 'idle' },
    VoiceConnectionStatus: { Disconnected: 'disconnected', Ready: 'ready' },
    NoSubscriberBehavior: { Pause: 'pause' },
    StreamType: { WebmOpus: 'webm', OggOpus: 'ogg', Arbitrary: 'arbitrary' },
    joinVoiceChannel(options) {
      const methods = {
        onVoiceServerUpdate: (payload) => updates.server.push(payload),
        onVoiceStateUpdate: (payload) => updates.state.push(payload),
        destroy: () => { updates.adapterDestroyed++; }
      };
      const adapter = options.adapterCreator(methods);
      updates.gatewayPayloads.push(adapter);
      const connection = new MockConnection();
      connections.push(connection);
      queueMicrotask(() => adapter.sendPayload({ op: 4, d: { guild_id: options.guildId, channel_id: options.channelId } }));
      return connection;
    },
    createAudioPlayer() { const player = new MockPlayer(); players.push(player); return player; },
    createAudioResource(stream, options) {
      let volume = 1;
      return {
        stream, metadata: options.metadata, inlineVolume: options.inlineVolume,
        volume: { setVolume(value) { volume = value; }, get value() { return volume; } }
      };
    }
  };
  return { voice, updates, players, connections };
}

function track(id, sourceId = id) {
  return {
    id, sourceId, title: `Track ${id}`, author: 'Test', source: 'mock', uri: `mock:${id}`,
    durationMs: 10000, isLive: false, seekable: true
  };
}

function installSource(sources, id) {
  sources.put({
    sourceId: id, provider: 'mock', expiresAt: Date.now() + 60000,
    async open() {
      return { stream: Readable.from([Buffer.from('audio')]), inputType: 'ogg-opus', directPassthrough: true, sourceCodec: 'opus', sourceContainer: 'ogg' };
    }
  });
}

async function tick(ms = 0) { await new Promise((resolve) => setTimeout(resolve, ms)); }

test('voice adapter, capacity, position, real volume and safe stop', async () => {
  const cfg = config(1);
  const events = new EventBus(64);
  const store = new PlayerStore(cfg, events);
  const sources = new SourceRegistry();
  const mock = mockVoice();
  const manager = new VoiceManager(cfg, store, events, sources, async () => mock.voice);
  installSource(sources, 'a'); installSource(sources, 'b');

  try {
    await manager.connect('guild-a', 'channel-a');
    await tick();
    assert.equal(manager.sessionCount, 1);
    assert.ok(events.history().some((event) => event.type === 'DiscordGatewayPayload'));

    manager.ingestUpdate('guild-a', 'server', { token: 'voice-token' });
    manager.ingestUpdate('guild-a', 'state', { session_id: 'session' });
    assert.equal(mock.updates.server.length, 1);
    assert.equal(mock.updates.state.length, 1);

    await assert.rejects(() => manager.connect('guild-b', 'channel-b'), (error) => error.code === 'NODE_CAPACITY');

    await manager.play('guild-a', track('a'));
    await tick(25);
    manager.syncPosition('guild-a');
    assert.equal(store.require('guild-a').status, 'playing');
    assert.ok(store.require('guild-a').positionMs >= 15);

    manager.setVolume('guild-a', 50);
    assert.equal(store.require('guild-a').volume, 50);
    assert.equal(mock.players[0].resource.volume.value, 0.5);
    assert.throws(() => manager.setVolume('guild-a', Number.NaN), (error) => error.code === 'INVALID_VOLUME');

    store.enqueue('guild-a', [track('b')]);
    manager.stop('guild-a');
    assert.equal(store.require('guild-a').status, 'stopped');
    assert.equal(store.require('guild-a').queue.tracks.length, 1, 'stop must not consume the next track');
    assert.equal(store.require('guild-a').track, null);
  } finally {
    manager.close(); sources.close(); store.close();
  }
});

test('natural idle advances queue and changing channel replaces session', async () => {
  const cfg = config(1);
  const events = new EventBus(64);
  const store = new PlayerStore(cfg, events);
  const sources = new SourceRegistry();
  const mock = mockVoice();
  const manager = new VoiceManager(cfg, store, events, sources, async () => mock.voice);
  installSource(sources, 'a'); installSource(sources, 'b');

  try {
    await manager.connect('guild-a', 'channel-a');
    await manager.play('guild-a', track('a'));
    store.enqueue('guild-a', [track('b')]);
    await tick();
    mock.players[0].emit('idle');
    await tick();
    assert.equal(store.require('guild-a').track.id, 'b');
    assert.equal(store.require('guild-a').queue.tracks.length, 0);

    await manager.connect('guild-a', 'channel-new');
    assert.equal(manager.sessionCount, 1);
    assert.equal(store.require('guild-a').voice.channelId, 'channel-new');
    assert.equal(mock.connections[0].destroyed, true);
  } finally {
    manager.close(); sources.close(); store.close();
  }
});
