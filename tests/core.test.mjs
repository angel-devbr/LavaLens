import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createApp } from '../dist/app.js';

const TOKEN = 'test-token-with-at-least-24-chars';
// Porta única por app: evita que o pool keep-alive do undici reuse socket
// de um servidor anterior já encerrado (falso "other side closed").
let nextPort = 18800;
let PORT = nextPort;

function config(overrides = {}) {
  return {
    port: PORT, host: '127.0.0.1', token: TOKEN, nodeId: 'test-node',
    stateTtlMs: 60000, eventHistory: 16, maxBodyBytes: 524288, logLevel: 'silent',
    allowPrivateNetwork: true,
    youtube: { enabled: false, oauthRequired: true, credentialsFile: './missing.json', maxPlaylistTracks: 10, cacheDir: './.cache-test', sabrEnabled: true, sabrAudioQuality: 'AUDIO_QUALITY_MEDIUM', sabrMaxRetries: 1, sabrStallDetectionMs: 5000 },
    audio: { ffmpegPath: 'ffmpeg', profile: 'eco', bitrateKbps: 96, bufferMs: 300, maxActivePlayers: 1, maxQueueSize: 10 },
    ...overrides
  };
}

async function request(path, init = {}) {
  return fetch(`http://127.0.0.1:${PORT}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...init.headers }
  });
}

async function withApp(overrides, fn) {
  PORT = nextPort++;
  const app = createApp(config({ port: PORT, ...overrides }));
  await app.server.listen();
  try { return await fn(app); } finally { await app.close(); }
}

test('health, auth and rich player state', async () => {
  await withApp({}, async () => {
    assert.equal((await fetch(`http://127.0.0.1:${PORT}/health`)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${PORT}/v1/status`)).status, 401);

    const put = await request('/v1/guilds/123/player', {
      method: 'PUT', body: JSON.stringify({ status: 'playing', extensions: { test: true } })
    });
    assert.equal(put.status, 200);

    const state = await (await request('/v1/guilds/123/player')).json();
    assert.equal(state.status, 'playing');
    assert.equal(state.extensions.test, true);

    const status = await (await request('/v1/status')).json();
    assert.equal(status.node.id, 'test-node');
  });
});

test('corpo JSON não-objeto retorna 400, não 500', async () => {
  await withApp({}, async () => {
    for (const body of ['null', '123', '"texto"', '[]']) {
      const res = await request('/v1/guilds/123/load', { method: 'POST', body });
      assert.equal(res.status, 400, `body ${body} deveria dar 400`);
      const data = await res.json();
      assert.ok(['INVALID_BODY', 'INVALID_FIELD'].includes(data.code), `code inesperado: ${data.code}`);
    }
  });
});

test('validação rejeita status/loopMode/volume inválidos', async () => {
  await withApp({}, async () => {
    const badStatus = await request('/v1/guilds/123/player', { method: 'PUT', body: JSON.stringify({ status: 'banana' }) });
    assert.equal(badStatus.status, 400);

    const badLoop = await request('/v1/guilds/123/commands', {
      method: 'POST', body: JSON.stringify({ name: 'setRepeat', args: { mode: 'BANANA' } })
    });
    assert.equal(badLoop.status, 400);

    const badVolume = await request('/v1/guilds/123/commands', {
      method: 'POST', body: JSON.stringify({ name: 'setVolume', args: { volume: 'abc' } })
    });
    assert.equal(badVolume.status, 400);

    // volume permanece válido (nunca vira null)
    const state = await (await request('/v1/guilds/123/player')).json();
    assert.equal(typeof state.volume, 'number');
  });
});

test('PUT não permite forjar guildId nem campos derivados', async () => {
  await withApp({}, async () => {
    await request('/v1/guilds/456/player', {
      method: 'PUT',
      body: JSON.stringify({ guildId: 'HACK', positionMs: 99999, voice: { connected: true }, createdAt: '1999-01-01' })
    });
    const state = await (await request('/v1/guilds/456/player')).json();
    assert.equal(state.guildId, '456');
    assert.equal(state.positionMs, 0);
    assert.equal(state.voice.connected, false);
    assert.notEqual(state.createdAt, '1999-01-01');
  });
});

test('fila rejeita faixas malformadas', async () => {
  await withApp({}, async () => {
    const res = await request('/v1/guilds/789/queue', { method: 'POST', body: JSON.stringify({ tracks: ['lixo', 123, null] }) });
    assert.equal(res.status, 400);

    const ok = await request('/v1/guilds/789/queue', {
      method: 'POST',
      body: JSON.stringify({ tracks: [{ sourceId: 'abc', title: 'T', author: 'A', durationMs: 1000 }] })
    });
    assert.equal(ok.status, 200);
    const state = await ok.json();
    assert.equal(state.queue.tracks.length, 1);
    assert.equal(state.queue.tracks[0].sourceId, 'abc');
  });
});

test('capacidade usa sessões de voz reais, não o status editável', async () => {
  await withApp({}, async () => {
    // maxActivePlayers = 1; marcar players como "playing" via PUT não pode consumir capacidade
    for (const guild of ['111', '222', '333']) {
      await request(`/v1/guilds/${guild}/player`, { method: 'PUT', body: JSON.stringify({ status: 'playing' }) });
    }
    const status = await (await request('/v1/status')).json();
    assert.equal(status.node.activePlayers, 0, 'sem sessão de voz, activePlayers deve ser 0');
  });
});

test('guildId inválido é rejeitado', async () => {
  await withApp({}, async () => {
    const res = await request('/v1/guilds/..%2F..%2Fetc/player');
    assert.equal(res.status, 400);
  });
});

test('SSRF: endereços privados bloqueados quando não permitidos', async () => {
  await withApp({ allowPrivateNetwork: false }, async () => {
    for (const query of ['http://169.254.169.254/latest/meta-data/', 'http://127.0.0.1:9/x', 'http://10.0.0.1/a', 'http://[::ffff:7f00:1]/', 'http://[::ffff:a9fe:a9fe]/', 'http://[ff02::1]/']) {
      const res = await request('/v1/guilds/123/load', { method: 'POST', body: JSON.stringify({ query }) });
      assert.equal(res.status, 403, `${query} deveria ser bloqueado`);
      assert.equal((await res.json()).code, 'BLOCKED_ADDRESS');
    }
  });
});

test('URL com escape percentual inválido não gera 500', async () => {
  await withApp({}, async () => {
    const res = await request('/v1/guilds/123/load', { method: 'POST', body: JSON.stringify({ query: 'http://127.0.0.1:9/%ZZ.mp3' }) });
    assert.notEqual(res.status, 500);
  });
});

test('protocolos não-http são recusados', async () => {
  await withApp({}, async () => {
    const res = await request('/v1/guilds/123/load', { method: 'POST', body: JSON.stringify({ query: 'file:///etc/passwd' }) });
    assert.equal(res.status, 400);
  });
});

test('play com sourceId inexistente retorna 410 e não 500', async () => {
  await withApp({}, async () => {
    await request('/v1/guilds/123/player', { method: 'PUT', body: JSON.stringify({ status: 'idle' }) });
    const res = await request('/v1/guilds/123/play', {
      method: 'POST',
      body: JSON.stringify({ track: { sourceId: 'nao-existe', title: 'x', author: 'y' } })
    });
    // sem sessão de voz => 409; o importante é não ser 500
    assert.ok([409, 410].includes(res.status), `status inesperado: ${res.status}`);
  });
});

test('OPTIONS retorna 204 sem corpo', async () => {
  await withApp({}, async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/v1/status`, { method: 'OPTIONS' });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('content-length'), null);
    assert.equal(await res.text(), '');
  });
});

test('método não permitido retorna 405', async () => {
  await withApp({}, async () => {
    const res = await request('/v1/guilds/123/load', { method: 'GET' });
    assert.equal(res.status, 405);
  });
});

test('SSE entrega eventos e respeita after', async () => {
  await withApp({}, async () => {
    const controller = new AbortController();
    const res = await request('/v1/events', { signal: controller.signal });
    assert.equal(res.status, 200);
    const reader = res.body.getReader();

    await request('/v1/guilds/999/player', { method: 'PUT', body: JSON.stringify({ status: 'loading' }) });
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    assert.match(text, /event: /);
    controller.abort();
  });
});

// --- Regressão dos bugs do provider do YouTube (descobertos com OAuth real) ---
// Testam os normalizadores puros, sem depender de rede nem de credenciais.

test('normaliza item de busca no formato novo (LockupView)', async () => {
  const { __testables } = await import('../dist/providers/youtube.js');
  const item = {
    type: 'LockupView',
    content_id: 'm4pwBrXTAbg',
    content_type: 'VIDEO',
    metadata: {
      title: { text: 'Minha Música' },
      metadata: { metadata_rows: [{ metadata_parts: [{ text: { text: 'Canal Teste' } }] }] }
    },
    content_image: {
      image: { sources: [{ url: 'https://i.ytimg.com/vi/x/hq.jpg', width: 480 }] },
      overlays: [{ type: 'ThumbnailBottomOverlayView', badges: [{ text: '4:38' }] }]
    }
  };
  const r = __testables.normalizeSearchItem(item);
  assert.equal(r.id, 'm4pwBrXTAbg');
  assert.equal(r.title, 'Minha Música');
  assert.equal(r.author, 'Canal Teste');
  assert.equal(r.durationMs, 278000); // 4:38
  assert.equal(r.isLive, false);
  assert.match(r.artworkUrl, /ytimg/);
});

test('normaliza item de busca no formato antigo (Video)', async () => {
  const { __testables } = await import('../dist/providers/youtube.js');
  const r = __testables.normalizeSearchItem({
    id: 'abc12345678',
    title: { text: 'Antigo' },
    author: { name: 'Autor' },
    duration: { seconds: 90 },
    thumbnails: [{ url: 'https://x/y.jpg', width: 320 }]
  });
  assert.equal(r.id, 'abc12345678');
  assert.equal(r.title, 'Antigo');
  assert.equal(r.author, 'Autor');
  assert.equal(r.durationMs, 90000);
});

test('item de busca não reconhecido não quebra nem vira faixa', async () => {
  const { __testables } = await import('../dist/providers/youtube.js');
  for (const lixo of [{}, null, { type: 'Outro' }, { content_id: 'x', content_type: 'CHANNEL' }]) {
    const r = __testables.normalizeSearchItem(lixo);
    assert.equal(r.id, undefined);
  }
});

test('converte texto de duração para milissegundos', async () => {
  const { __testables } = await import('../dist/providers/youtube.js');
  const { durationTextToMs } = __testables;
  assert.equal(durationTextToMs('4:38'), 278000);
  assert.equal(durationTextToMs('1:02:15'), 3735000);
  assert.equal(durationTextToMs('0:30'), 30000);
  assert.equal(durationTextToMs(undefined), 0);
  assert.equal(durationTextToMs('AO VIVO'), 0);
});


test('autoplay aceita somente booleano JSON real', async () => {
  await withApp({}, async () => {
    const bad = await request('/v1/guilds/123/commands', {
      method: 'POST', body: JSON.stringify({ name: 'setAutoplay', args: { enabled: 'false' } })
    });
    assert.equal(bad.status, 400);

    const good = await request('/v1/guilds/123/commands', {
      method: 'POST', body: JSON.stringify({ name: 'setAutoplay', args: { enabled: false } })
    });
    assert.equal(good.status, 200);
    assert.equal((await good.json()).queue.autoplay, false);
  });
});

test('anti-SSRF bloqueia IPv4 ofuscado em IPv6, NAT64 e multicast', async () => {
  const { isPrivateAddress } = await import('../dist/net/http-stream.js');
  for (const address of [
    '::ffff:7f00:1',
    '::ffff:a9fe:a9fe',
    '64:ff9b::7f00:1',
    'ff02::1',
    'fc00::1',
    'fe80::1'
  ]) assert.equal(isPrivateAddress(address), true, `${address} deveria ser privado/bloqueado`);
  assert.equal(isPrivateAddress('2606:4700:4700::1111'), false);
});

test('seletor SABR prefere WebM Opus de alta qualidade', async () => {
  const { __testables } = await import('../dist/providers/youtube.js');
  const formats = [
    { mimeType: 'audio/mp4; codecs="mp4a.40.2"', bitrate: 192000, audioQuality: 'AUDIO_QUALITY_HIGH' },
    { mimeType: 'audio/webm; codecs="opus"', bitrate: 128000, audioQuality: 'AUDIO_QUALITY_MEDIUM' },
    { mimeType: 'audio/webm; codecs="opus"', bitrate: 160000, audioQuality: 'AUDIO_QUALITY_HIGH' }
  ];
  const selected = __testables.chooseSabrAudioFormat(formats, 'AUDIO_QUALITY_HIGH');
  assert.equal(selected.bitrate, 160000);
  assert.equal(__testables.isDirectWebmOpus(selected.mimeType), true);
});

test('setVolume preserva posição absoluta e restaura passthrough em 100%', async () => {
  const [{ VoiceManager }, { PlayerStore }, { EventBus }, { SourceRegistry }] = await Promise.all([
    import('../dist/discord/voice.js'), import('../dist/player-store.js'),
    import('../dist/event-bus.js'), import('../dist/providers/provider.js')
  ]);
  const resources = [], openedOffsets = [];
  class FakePlayer extends EventEmitter { play(resource) { resources.push(resource); } pause() { return true; } unpause() { return true; } stop() { return true; } }
  class FakeConnection extends EventEmitter { subscribe() {} destroy() {} }
  const fakeVoice = {
    AudioPlayerStatus: { Playing: 'playing', Paused: 'paused', AutoPaused: 'autopaused', Idle: 'idle' },
    VoiceConnectionStatus: { Disconnected: 'disconnected', Ready: 'ready' },
    NoSubscriberBehavior: { Pause: 'pause' },
    StreamType: { WebmOpus: 'webm', OggOpus: 'ogg', Arbitrary: 'arbitrary' },
    joinVoiceChannel(options) { options.adapterCreator({ onVoiceServerUpdate() {}, onVoiceStateUpdate() {}, destroy() {} }); return new FakeConnection(); },
    createAudioPlayer() { return new FakePlayer(); },
    createAudioResource(stream, options) {
      const resource = { stream, playbackDuration: 3210, metadata: options.metadata };
      if (options.inlineVolume) resource.volume = { value: 1, setVolume(value) { this.value = value; } };
      return resource;
    }
  };
  const cfg = config(), events = new EventBus(16), store = new PlayerStore(cfg, events), sources = new SourceRegistry();
  const sourceId = 'volume-source';
  sources.put({
    sourceId, provider: 'test', expiresAt: Date.now() + 60_000,
    async open(offsetMs = 0) {
      openedOffsets.push(offsetMs);
      return { stream: new PassThrough(), inputType: 'webm-opus', directPassthrough: true, sourceCodec: 'opus', sourceContainer: 'webm' };
    }
  });
  const voice = new VoiceManager(cfg, store, events, sources, fakeVoice);
  await voice.connect('123', '456');
  const track = { id: 't', sourceId, title: 'T', author: 'A', source: 'test', uri: '', durationMs: 30000, isLive: false, seekable: true };
  await voice.play('123', track, 5000);
  assert.equal(resources.at(-1).volume, undefined);
  assert.equal(openedOffsets.at(-1), 5000);
  await voice.setVolume('123', 50);
  assert.equal(openedOffsets.at(-1), 8210);
  assert.equal(resources.at(-1).volume.value, 0.5);
  assert.equal(store.get('123').audio.directPassthrough, false);
  await voice.setVolume('123', 100);
  assert.equal(openedOffsets.at(-1), 11420);
  assert.equal(resources.at(-1).volume, undefined);
  assert.equal(store.get('123').audio.directPassthrough, true);
  assert.equal(store.get('123').audio.transcoding, false);
  voice.close(); store.close(); sources.close();
});

test('FFmpeg posiciona -ss corretamente para URL e pipe não seekável', async () => {
  const { buildFfmpegArgs } = await import('../dist/audio/ffmpeg.js');
  const cfg = config();
  const urlArgs = buildFfmpegArgs(cfg, 'https://example.com/audio.mp3', 5000, false);
  assert.ok(urlArgs.indexOf('-ss') < urlArgs.indexOf('-i'));
  const pipeArgs = buildFfmpegArgs(cfg, 'pipe:0', 5000, true);
  assert.ok(pipeArgs.indexOf('-ss') > pipeArgs.indexOf('-i'));
});

test('interpretador JS segue o contrato real do youtubei.js e oferece URL', async () => {
  const { evaluatePlayerScript } = await import('../dist/providers/js-runtime.js');
  const output = `
    const exportedVars = (function() {
      function nsigFunction(url, sp, s) {
        const parsed = new URL(url);
        const n = parsed.searchParams.get('n') || '';
        parsed.searchParams.set('n', n.split('').reverse().join(''));
        if (sp && s) parsed.searchParams.set(sp, s.split('').reverse().join(''));
        return parsed;
      }
      return { nsigFunction };
    })({});
    function process(n = "", sp = "", s = "") {
      const url = exportedVars.nsigFunction("https://ytjs.googlevideo.com/videoplayback?n=" + encodeURIComponent(n), sp, s);
      return { n: url.searchParams.get("n"), sig: sp ? url.searchParams.get(sp) : undefined };
    }
    return process(n, sp, sig);
  `;
  const r = evaluatePlayerScript({ output, exported: ['nsigFunction'] }, { n: 'abc', sp: 'sig', sig: 'xyz' });
  assert.equal(r.n, 'cba');
  assert.equal(r.sig, 'zyx');
});

test('interpretador JS não expõe require nem process ao script', async () => {
  const { evaluatePlayerScript } = await import('../dist/providers/js-runtime.js');
  const r = evaluatePlayerScript(
    { output: 'return { vazou: (typeof require !== "undefined") || (typeof process !== "undefined") };', exported: [] }, {}
  );
  assert.equal(r.vazou, false);
});

test('interpretador JS interrompe laço infinito por timeout', async () => {
  const { evaluatePlayerScript } = await import('../dist/providers/js-runtime.js');
  assert.throws(() => evaluatePlayerScript({ output: 'while (true) {}', exported: [] }, {}), /timed out|Script execution/i);
});
