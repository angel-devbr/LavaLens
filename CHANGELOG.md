# Changelog

## 0.1.0-alpha.5 — 2026-08-02

### Corrigido

- Posição absoluta correta depois de `seek` e ao recriar o recurso por mudança de volume.
- Voltar o volume para 100% remove o transformer inline e restaura passthrough Opus.
- FFmpeg aplica `-ss` depois de `-i` em streams `pipe:0` não seekáveis.
- Interpretador `node:vm` segue o contrato do `youtubei.js`, fornece Web APIs mínimas e limita o tempo de execução.
- Versões do pacote, lockfile, README e OpenAPI alinhadas.
- Testes cobrem seek + volume, passthrough, argumentos FFmpeg e avaliação realista do player.

### Validação local

- Testes de núcleo e regressão executados sem rede externa.
- O teste real Discord/YouTube relatado na alpha.4 não foi repetido neste ambiente.

## 0.1.0-alpha.4 — 2026-08-02

**A reprodução do YouTube passou a funcionar de ponta a ponta.** Validado no Discord
real: 2 minutos contínuos, passthrough Opus direto (`webm-sabr`), zero travamentos.

### Corrigido — crítico

- **Interpretador JavaScript ausente bloqueava todo o SABR.** O youtubei.js 17.x
  embarca apenas um stub que sempre lança
  (*"you must provide your own JavaScript evaluator"*), então qualquer URL que
  precise ser decifrada — incluindo a `server_abr_streaming_url` do SABR — falhava
  antes de qualquer requisição. Adicionado `src/providers/js-runtime.ts` usando
  `node:vm`, que já vem no Node: **nenhuma dependência nova**, preservando a meta de
  rodar em hosts fracas (sem `jsdom`).
  - O script do player usa `return` no nível superior, então é avaliado dentro de
    uma função (`Illegal return statement` caso contrário).
  - A chamada acontece **dentro** do `vm`: a opção `timeout` só cobre a execução em
    `runInContext`. Invocar a função fora do contexto deixaria um laço infinito
    travando o event loop para sempre.
  - O contexto não expõe `require`, `process` nem `module`.
- **`npm run test:discord` expirava sem nunca conectar.** O script pedia
  `intents: 1` (apenas GUILDS), sem `GUILD_VOICE_STATES` (`1 << 7`). Sem esse bit o
  Discord não envia `VOICE_STATE_UPDATE` do próprio bot, o handshake de voz nunca
  conclui e o teste falhava por timeout.

### Adicionado

- Três testes de regressão para o interpretador: `return` no topo, isolamento de
  `require`/`process` e interrupção de laço infinito por timeout.


## 0.1.0-alpha.3 — 2026-08-02

- Integra `googlevideo` 4.1.1 como fallback SABR/UMP somente áudio quando
  `youtubei.js.download()` não recebe URL direta.
- Mantém OAuth obrigatório e adiciona suporte opcional a `YOUTUBE_PO_TOKEN`.
- Seleciona preferencialmente WebM/Opus para passthrough; usa FFmpeg apenas para
  seek ou formatos incompatíveis.
- `setVolume` agora altera o recurso de áudio real. Em 100% mantém passthrough;
  em outro volume ativa processamento inline sob demanda.
- `setAutoplay` e `queue.autoplay` aceitam somente booleanos JSON verdadeiros.
- Fecha bypasses SSRF por IPv4 mapeado em IPv6, NAT64 e multicast IPv6.
- Fixa no socket o IP validado para impedir DNS rebinding e revalida redirects.
- Restaura `scripts/discord-e2e.mjs` e atualiza `yt:check` para exercitar o provider real.
- Amplia testes de regressão para SABR, booleanos e endereços IPv6 ofuscados.

## 0.1.0-alpha.2 — 2026-08-02

Rodada de correções após teste de integração real com o Discord (conexão de voz,
passthrough Opus, transcodificação FFmpeg e DAVE verificados em um servidor real).

### Corrigido — provider do YouTube (verificado com OAuth real)

- **Busca retornava vazio.** O YouTube passou a devolver itens `LockupView`
  (`content_id` + `metadata.title`) no lugar do antigo `Video` (`id` + `title`).
  O provider procurava só `item.id ?? item.video_id`, não encontrava nada e
  **descartava todos os resultados em silêncio** (`loadType: "empty"`). Agora um
  normalizador entende os dois formatos e extrai também a duração, que hoje vem
  como badge (`"4:38"`) no overlay da miniatura.
- **URL direta retornava 500.** `getInfo()` monta a página inteira do watch e
  quebra com `Cannot read properties of null (reading 'as')` em componentes que a
  biblioteca ainda não conhece. Trocado por `getBasicInfo()`, que usa apenas o
  endpoint `/player` — o suficiente para tocar áudio.
- **Título e autor ausentes.** O `/player` deixou de devolver `videoDetails.title`
  e `.author` (confirmado na resposta crua, em todos os clientes testados).
  Complementados via oEmbed público, que não exige autenticação.
- **Erro de SABR agora é explícito.** Quando o YouTube serve o vídeo somente por
  SABR, `download()` falhava com o críptico `No valid URL to decipher`. Agora
  retorna `503 YOUTUBE_SABR_UNSUPPORTED` com explicação. Ver a limitação conhecida
  em `docs/testing/discord-e2e-report.md`.
- OAuth: tokens renovados passam a ser persistidos (`update-credentials`), evitando
  perder a sessão entre reinícios.

### Corrigido — crítico

- **Queda total do processo durante a reprodução.** `fetch()` + `Readable.fromWeb()`
  disparava `AssertionError: assert(!this.paused)` no undici quando o stream era
  consumido em tempo real (backpressure) e a origem encerrava a conexão. O processo
  inteiro caía, derrubando todos os players do nó. Todo o streaming de áudio passou a
  usar `node:http`/`node:https` (`src/net/http-stream.ts`).
- **`NODE_CAPACITY` bloqueava o nó vazio.** A capacidade usava o campo `status`, que é
  gravável via `PUT /player`; poucas requisições deixavam o nó permanentemente
  inutilizável. Agora conta sessões de voz reais.
- **Provider do YouTube inoperante.** `client_type: 'TV'` é inválido (gera
  `clientName: "TV"`); o valor correto é `ClientType.TV` (`TVHTML5`). O erro estava
  oculto porque `src/external.d.ts` declarava `youtubei.js` e `@discordjs/voice` como
  módulos sem tipos, desligando o type-check dessas bibliotecas.

### Corrigido — segurança

- **SSRF**: o provider HTTP acessava redes internas e endpoints de metadados de nuvem
  (`169.254.169.254`). Bloqueio de loopback, link-local, RFC1918, CGNAT e IPv6 ULA,
  liberável com `ALLOW_PRIVATE_NETWORK=true`.
- `PUT /player` permitia forjar `guildId`, `positionMs`, `voice.connected` e `createdAt`;
  agora há allow-list de campos.
- Recusa de inicialização quando `LAVALENS_TOKEN` ainda é o valor de exemplo.
- SSE e WebSocket descartam clientes lentos em vez de acumular memória sem limite.

### Corrigido — robustez e conformidade

- Corpo JSON não-objeto (`null`, `123`, `"texto"`, `[]`) retornava `500`; agora `400`.
- URL com escape percentual inválido (`/%ZZ.mp3`) retornava `500`; agora tratada.
- `setVolume` com valor não numérico gravava `volume: null`; validado.
- `setRepeat` e `status` aceitavam valores arbitrários; enums validados.
- Fila aceitava elementos não-objeto; faixas são sanitizadas.
- `loopMode` (`track`/`queue`) estava no schema mas não era implementado.
- `positionMs`, `pingMs`, `endpoint`, `daveProtocolVersion` e `transportEncryption`
  nunca eram preenchidos; agora atualizados em tempo real.
- FFmpeg ausente falhava em silêncio; agora emite `FFMPEG_NOT_FOUND`.
- `stop` deixava o player em estado `error` falso; agora vai para `stopped`.
- `seek` recusava arquivos HTTP tratando-os como transmissão ao vivo.
- Respostas `204` não enviam mais `Content-Length`; métodos inválidos retornam `405`.
- Parser de WebSocket trata máscara, tamanhos estendidos, fragmentação e ping/pong.
- Handlers de `uncaughtException`/`unhandledRejection` que **classificam** o erro:
  falhas de rede transitórias (`ECONNRESET`, `EPIPE`, `ETIMEDOUT`, inclusive as
  embrulhadas em `error.cause` pelo undici) são registradas e o nó segue; qualquer
  outra exceção dispara desligamento controlado com saída `1`, para o supervisor
  reiniciar o processo em estado limpo.
- Versão deixa de ser repetida em seis arquivos (README, openapi, metrics, server,
  index e User-Agent ficavam dessincronizados a cada release).

### Adicionado

- `src/net/http-stream.ts` — streaming HTTP com redirects, timeout e proteção anti-SSRF.
- `webStreamToNode()` — adaptador de ReadableStream web para Node usado pelo provider
  do YouTube no lugar de `Readable.fromWeb()`: cancela o reader no `destroy` (evita
  vazar a conexão do fetch) e propaga erros como evento `error`.
- `src/version.ts` — fonte única de versão lida do `package.json`, consumida por
  `/health`, `/v1/status`, log de inicialização e User-Agent.
- `scripts/yt-stream-check.mjs` (`npm run yt:check`) — verificação prolongada do
  caminho de streaming do YouTube sob consumo em tempo real.
- `package-lock.json` gerado com Node.js 24 (lockfileVersion 3) para builds reproduzíveis.
- `overrides: { "tar": "^7.5.22" }` — zera as 5 vulnerabilidades (4 high, 1 crítica)
  herdadas de `@discordjs/opus` → `node-pre-gyp` → `tar`, mantendo o Opus nativo.
  `npm audit` passa a reportar 0 vulnerabilidades.
- `docs/testing/discord-e2e-report.md` — relatório do teste end-to-end.
- `src/validation.ts` — validação e sanitização de entrada.
- `ALLOW_PRIVATE_NETWORK` (padrão `false`).
- Suíte de testes ampliada de 1 para 14 casos, com regressão para cada bug crítico.
- Novas chaves de erro em `docs/i18n` (pt-BR, en-US, es-ES).

## 0.1.0-alpha.1 — 2026-08-02

- Primeira implementação independente em Node.js/TypeScript.
- Sem Lavalink, Java ou banco obrigatório.
- API REST, SSE, WebSocket, telemetria e estado detalhado.
- Adaptador remoto para Discord Voice/DAVE.
- YouTube.js com OAuth TV obrigatório e sem cookies.
- Opus passthrough e FFmpeg sob demanda.
- Worker Cloudflare e exemplos de clientes.
