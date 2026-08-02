# LavaLens Native

Servidor open source de áudio e observabilidade para bots de música do Discord, escrito em **TypeScript/Node.js 24** e sem utilizar Lavalink ou Java.

> Estado: **v0.1.0-alpha.5**. O núcleo HTTP, REST, SSE, WebSocket, providers, OAuth e a ponte de voz estão implementados. Esta versão deve ser testada antes de uso em produção com muitos servidores.

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
        ├── googlevideo para streaming SABR/UMP
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

Se preferir gerar o código em duas etapas (útil quando o terminal cai no meio da
autorização, pois o `device_code` fica salvo em disco):

```bash
node scripts/oauth-device.mjs start   # exibe o link e o código
node scripts/oauth-device.mjs poll    # troca pelo token depois de autorizar
```

> **Streaming do YouTube.** O provider tenta primeiro `youtubei.js.download()` para
> preservar o caminho direto WebM/Opus. Quando o vídeo possui somente
> `server_abr_streaming_url`, ele usa `googlevideo` para processar SABR/UMP em modo
> somente áudio. OAuth continua obrigatório e cookies não são aceitos.
>
> Alguns IPs/clientes também exigem um **PO token**. Para não adicionar `jsdom` e
> BotGuard permanentemente ao processo ultraleve, o token é opcional e externo:
> defina `YOUTUBE_PO_TOKEN` quando receber `YOUTUBE_SABR_POTOKEN_REQUIRED`. Como o
> protocolo é privado e muda sem aviso, o fallback reduz a limitação atual, mas não
> transforma o YouTube em uma API estável ou garantida.
>
> **Verificado no Discord real** (bot, servidor e canal de voz reais): 2 minutos
> contínuos de reprodução, passthrough Opus direto (`webm-sabr`), zero travamentos,
> DAVE v1 ativo. Requer o interpretador JavaScript embutido (`src/providers/js-runtime.ts`,
> baseado em `node:vm` — sem dependências extras); sem ele, o youtubei.js não
> consegue decifrar a URL SABR.

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

## Comandos validados

`setAutoplay` aceita somente booleanos JSON reais (`true`/`false`); a string
`"false"` é rejeitada. `setVolume` altera o áudio de verdade. O passthrough Opus
continua sem custo extra em 100%; ao usar outro volume, o recurso ativa volume
inline e passa a consumir mais CPU.

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
npm run yt:check -- VIDEO_ID 180
# Em uma host com internet e uma bot temporária:
npm run test:discord
```

## Segurança

Nunca publique `.env`, `lavalens-oauth.json`, token do bot ou `LAVALENS_TOKEN`. Use HTTPS em produção e um token diferente por ambiente.

## Licença

MIT.
