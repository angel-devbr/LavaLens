# LavaLens Native

Servidor open source de áudio e observabilidade para bots de música do Discord, escrito em **TypeScript/Node.js 24** e sem utilizar Lavalink ou Java.

> Estado: **v0.1.0-alpha.1**. O núcleo HTTP, REST, SSE, WebSocket, providers, OAuth e a ponte de voz estão implementados. Esta versão deve ser testada antes de uso em produção com muitos servidores.

## O que ele mostra

- tocando, pausado, carregando, parado, reconectando ou com erro;
- música, artista, plataforma, URL, duração, posição, capa e dados do provider;
- playlist, foto, dono, posição e total de faixas;
- fila, autoplay, repetição, volume e filtros;
- canal, shard, ouvintes, ping, DAVE, criptografia e reconexões;
- codec de entrada, Opus 48 kHz estéreo, bitrate, passthrough, transcodificação e buffer;
- RAM, CPU, event loop, uptime, players e carga do nó;
- eventos em tempo real por SSE e WebSocket.

## Arquitetura

```text
Bot em qualquer linguagem
        │ REST + WebSocket/SSE
        ▼
LavaLens Native — Node.js/TypeScript
        │
        ├── Provider HTTP/rádio
        ├── YouTube.js + OAuth TV obrigatório
        ├── Opus passthrough quando possível
        └── FFmpeg somente quando necessário
                       │
                       ▼
                Discord Voice + DAVE
```

O bot continua responsável por sua conexão principal ao Discord Gateway. O LavaLens envia o payload de entrada no canal como evento `DiscordGatewayPayload`; o bot envia esse payload ao shard e devolve `VOICE_STATE_UPDATE` e `VOICE_SERVER_UPDATE` para a API. Isso permite uso com discord.js, JDA, nextcord, DSharpPlus ou qualquer outro cliente.

## Instalação

Requisitos:

- Node.js 24;
- FFmpeg 7 ou compatível;
- Linux recomendado;
- `@discordjs/opus` recomendado para menor CPU.

```bash
cp .env.example .env
npm install
npm run build
```

### OAuth obrigatório do YouTube

Com `YOUTUBE_ENABLED=true`, o servidor **recusa iniciar sem OAuth**:

```bash
npm run oauth:youtube
```

Abra o endereço exibido, informe o código e conecte uma conta secundária. As credenciais serão salvas em `lavalens-oauth.json`, que já está no `.gitignore`.

```bash
npm start
```

Para testar o núcleo sem YouTube:

```env
YOUTUBE_ENABLED=false
```

OAuth só funciona no cliente TV do YouTube.js. Cookies não são aceitos por este projeto.

## Consulta detalhada

```bash
curl -H "Authorization: Bearer $LAVALENS_TOKEN" \
  http://localhost:8080/v1/guilds/123/player
```

## Fluxo para tocar

```bash
# 1. Peça a conexão. O evento DiscordGatewayPayload conterá o Opcode 4.
curl -X POST -H "Authorization: Bearer $LAVALENS_TOKEN" -H 'Content-Type: application/json' \
  -d '{"channelId":"987","shardId":0}' \
  http://localhost:8080/v1/guilds/123/voice/connect

# 2. Encaminhe os eventos recebidos do Discord.
curl -X POST -H "Authorization: Bearer $LAVALENS_TOKEN" -H 'Content-Type: application/json' \
  -d '{"type":"server","payload":{}}' \
  http://localhost:8080/v1/guilds/123/voice/update

# 3. Toque.
curl -X POST -H "Authorization: Bearer $LAVALENS_TOKEN" -H 'Content-Type: application/json' \
  -d '{"query":"https://www.youtube.com/watch?v=VIDEO_ID"}' \
  http://localhost:8080/v1/guilds/123/play
```

## Eventos

```bash
curl -N -H "Authorization: Bearer $LAVALENS_TOKEN" http://localhost:8080/v1/events
```

WebSocket:

```text
ws://localhost:8080/v1/ws?token=SEU_TOKEN
```

## Cloudflare

A pasta `cloudflare/` contém um Worker TypeScript que autentica, acorda e encaminha chamadas para o nó. O Worker não processa áudio porque Discord Voice precisa de UDP contínuo.

```bash
cd cloudflare
npm install
npx wrangler secret put LAVALENS_TOKEN
npm run deploy
```

## Limites físicos

A API ociosa foi desenhada para ser pequena. Uma música com Opus passthrough pode se aproximar da meta de 100 MB, mas Node.js, DAVE e bibliotecas nativas variam por host. Transcodificação com FFmpeg ultrapassará 0,1 CPU em muitos casos. O limite `MAX_ACTIVE_PLAYERS` impede que um nó fraco aceite mais sessões do que suporta.

Execute:

```bash
npm test
npm run benchmark -- 10000
```

## Segurança

Nunca publique `.env`, `lavalens-oauth.json`, token do bot ou `LAVALENS_TOKEN`. Use HTTPS em produção e um token diferente por ambiente.

## Licença

MIT.
