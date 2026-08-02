#!/usr/bin/env node
/**
 * OAuth do YouTube (fluxo de dispositivo TV) em duas etapas retomáveis.
 *
 *   node scripts/oauth-device.mjs start   -> gera link + código e salva o estado
 *   node scripts/oauth-device.mjs poll    -> troca o código autorizado por tokens
 *   node scripts/oauth-device.mjs status  -> mostra a situação atual
 *
 * Por que separado do `npm run oauth:youtube`: aquele comando gera o código e
 * fica preso em foreground até você autorizar. Se o processo cair, o código se
 * perde. Aqui o `device_code` é persistido, então o `poll` pode ser executado
 * quantas vezes for preciso, inclusive em outra sessão de terminal.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const CMD = process.argv[2] ?? 'start';
const STATE_FILE = process.env.OAUTH_STATE_FILE ?? './.oauth-device-state.json';
const CREDENTIALS_FILE = process.env.YOUTUBE_OAUTH_CREDENTIALS_FILE ?? './lavalens-oauth.json';

const YT_BASE = 'https://www.youtube.com';
const CODE_URL = `${YT_BASE}/o/oauth2/device/code`;
const TOKEN_URL = `${YT_BASE}/o/oauth2/token`;
const SCOPE = 'http://gdata.youtube.com https://www.googleapis.com/auth/youtube-paid-content';
const GRANT = 'http://oauth.net/grant_type/device/1.0';

const readState = () => (existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : null);
const writeState = (data) => writeFileSync(STATE_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });

/** O client_id do cliente TV é extraído da página /tv, como o youtubei.js faz. */
async function getClientIdentity() {
  const page = await fetch(`${YT_BASE}/tv`, {
    headers: {
      'user-agent': 'Mozilla/5.0 (ChromiumStylePlatform) Cobalt/Version',
      referer: YT_BASE
    }
  }).then((r) => r.text());

  const scriptPath = /<script\s+id="base-js"\s+src="([^"]+)"[^>]*><\/script>/.exec(page)?.[1];
  if (!scriptPath) throw new Error('Não foi possível localizar base.js na página /tv.');

  const script = await fetch(new URL(scriptPath, YT_BASE)).then((r) => r.text());
  const match = /clientId:"(?<client_id>[^"]+)",[^"]*?:"(?<client_secret>[^"]+)"/.exec(script);
  if (!match?.groups) throw new Error('Não foi possível extrair client_id/client_secret.');
  return { client_id: match.groups.client_id, client_secret: match.groups.client_secret };
}

async function start() {
  const client = await getClientIdentity();
  const response = await fetch(CODE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: client.client_id,
      scope: SCOPE,
      device_id: crypto.randomUUID(),
      device_model: 'ytlr::'
    })
  });
  const data = await response.json();
  if (!data.device_code) throw new Error(`Resposta inesperada: ${JSON.stringify(data)}`);

  const expiresAt = new Date(Date.now() + (data.expires_in ?? 1800) * 1000).toISOString();
  writeState({
    client,
    device_code: data.device_code,
    user_code: data.user_code,
    verification_url: data.verification_url,
    interval: data.interval ?? 5,
    expiresAt
  });

  const minutos = Math.round((data.expires_in ?? 1800) / 60);
  console.log('');
  console.log('  ┌──────────────────────────────────────────────┐');
  console.log('  │  AUTORIZE O LAVALENS NO YOUTUBE              │');
  console.log('  └──────────────────────────────────────────────┘');
  console.log('');
  console.log(`  1. Acesse:  ${data.verification_url}`);
  console.log(`  2. Código:  ${data.user_code}`);
  console.log('');
  console.log(`  Validade: ${minutos} minutos (até ${expiresAt}).`);
  console.log('  Use uma conta secundária, nunca a principal.');
  console.log('');
  console.log('  Depois de autorizar, rode:  node scripts/oauth-device.mjs poll');
  console.log('');
}

async function poll() {
  const state = readState();
  if (!state) throw new Error('Nenhum código pendente. Rode "start" primeiro.');
  if (new Date(state.expiresAt) < new Date()) {
    throw new Error('O código expirou. Rode "start" novamente para gerar outro.');
  }

  const payload = {
    client_id: state.client.client_id,
    client_secret: state.client.client_secret,
    code: state.device_code,
    grant_type: GRANT
  };

  const limite = Number(process.env.POLL_SECONDS ?? 60);
  const inicio = Date.now();
  const intervalo = Math.max(state.interval, 5) * 1000;

  while (Date.now() - inicio < limite * 1000) {
    const data = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    }).then((r) => r.json());

    if (!data.error) {
      const credentials = { ...data };
      if (credentials.expires_in) {
        credentials.expiry_date = new Date(Date.now() + credentials.expires_in * 1000).toISOString();
        delete credentials.expires_in;
      }
      credentials.client = state.client;
      mkdirSync(dirname(CREDENTIALS_FILE), { recursive: true });
      writeFileSync(CREDENTIALS_FILE, JSON.stringify(credentials, null, 2), { mode: 0o600 });
      console.log(`OK: credenciais salvas em ${CREDENTIALS_FILE}`);
      console.log(`    refresh_token presente: ${Boolean(credentials.refresh_token)}`);
      return 0;
    }

    if (data.error === 'authorization_pending' || data.error === 'slow_down') {
      process.stdout.write('.');
      await new Promise((r) => setTimeout(r, intervalo));
      continue;
    }
    if (data.error === 'access_denied') throw new Error('Acesso negado pelo usuário.');
    if (data.error === 'expired_token') throw new Error('O código expirou. Rode "start" novamente.');
    throw new Error(`Erro do servidor: ${JSON.stringify(data)}`);
  }
  console.log('\nAINDA_PENDENTE: autorização não concluída. Rode "poll" de novo após autorizar.');
  return 2;
}

function status() {
  if (existsSync(CREDENTIALS_FILE)) {
    const c = JSON.parse(readFileSync(CREDENTIALS_FILE, 'utf8'));
    console.log('AUTENTICADO');
    console.log('  expira em:', c.expiry_date ?? '(desconhecido)');
    console.log('  refresh_token:', c.refresh_token ? 'presente' : 'AUSENTE');
    return 0;
  }
  const state = readState();
  if (!state) { console.log('SEM_CODIGO: rode "start".'); return 1; }
  const expirado = new Date(state.expiresAt) < new Date();
  console.log(expirado ? 'CODIGO_EXPIRADO' : 'AGUARDANDO_AUTORIZACAO');
  console.log('  url:', state.verification_url);
  console.log('  código:', state.user_code);
  console.log('  válido até:', state.expiresAt);
  return expirado ? 1 : 2;
}

try {
  if (CMD === 'start') await start();
  else if (CMD === 'poll') process.exitCode = await poll();
  else if (CMD === 'status') process.exitCode = status();
  else { console.log('Uso: node scripts/oauth-device.mjs start|poll|status'); process.exitCode = 1; }
} catch (error) {
  console.error('ERRO:', error.message);
  process.exitCode = 1;
}
