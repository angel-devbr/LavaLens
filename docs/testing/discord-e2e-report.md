# Relatório de teste end-to-end — Discord

> **Nota de revisão alpha.5:** os relatos online da alpha.4 foram preservados, mas não puderam ser repetidos neste ambiente. A alpha.5 adiciona regressões locais para posição, volume, FFmpeg e interpretador.

> **Atualização (alpha.4): a reprodução do YouTube funciona.**
> O fallback SABR via `googlevideo` foi validado no Discord real — 2 minutos
> contínuos, passthrough Opus (`webm-sabr`), zero travamentos, `npm run test:discord`
> passando. Foram necessários dois consertos: um interpretador JavaScript
> (`node:vm`, sem dependências novas), pois o youtubei.js 17.x embarca apenas um stub
> que sempre lança ao decifrar URLs; e a correção dos intents do teste E2E, que
> pedia só `GUILDS` e nunca recebia `VOICE_STATE_UPDATE`.
> As seções abaixo sobre "limitação SABR" descrevem o estado anterior (alpha.2).

**Versões testadas:** `0.1.0-alpha.1` → `0.1.0-alpha.2`; fallback SABR integrado em `0.1.0-alpha.3`
**Ambiente:** Node.js 24.17.0 · FFmpeg 7.0.2 (libopus) · Linux x64
**Teste real:** bot próprio em servidor real do Discord, canal de voz dedicado

---

## Resumo

O núcleo funciona: conexão de voz, passthrough Opus, transcodificação FFmpeg e DAVE
foram verificados contra o Discord real. Na versão `alpha.1`, porém, **o processo
inteiro caía após cerca de 15 segundos de reprodução**. Foram identificados **15
bugs** (3 críticos), todos corrigidos e cobertos por testes de regressão.

Dois desses bugs só apareceram após concluir o OAuth do YouTube com uma conta real —
busca retornando vazio e URL direta gerando `500`. Ambos corrigidos.

**Atualização alpha.3:** a limitação SABR deixou de ser tratada apenas como erro.
Foi integrado o motor `googlevideo` para UMP/SABR somente áudio. Essa integração
segue precisando de teste E2E com OAuth real e, dependendo do cliente/IP, de PO token.
O provider HTTP continua funcional e testado.

---

## O que já funcionava

| Item | Status |
|---|---|
| `npm install` / `npm run build` | OK |
| Autenticação Bearer com `timingSafeEqual` | OK |
| SSE `/v1/events` com replay via `?after=` | OK |
| WebSocket `/v1/ws` (handshake RFC 6455) | OK |
| Handshake de voz (Opcode 4 → VOICE_STATE/SERVER_UPDATE) | OK |
| Passthrough Opus (`.ogg`) | OK — `directPassthrough: true` |
| Transcodificação FFmpeg (`.mp3`) | OK — `transcoding: true` |
| DAVE (E2EE) | OK — `daveProtocolVersion: 1`, `aead_aes256_gcm_rtpsize` |
| Limites de fila e corpo | OK — `409` / `413` |

A arquitetura de ponte (o bot mantém o Gateway; o LavaLens apenas emite o payload)
funcionou exatamente como descrito no README.

---

## Bugs críticos

### 1. Queda total do processo durante a reprodução

```
AssertionError [ERR_ASSERTION]: assert(!this.paused)
    at Parser.finish (node:internal/deps/undici/undici:7380:9)
```

Não era um erro tratado: o processo Node caía por completo, derrubando todos os
players de todos os servidores.

**Causa raiz:** bug do undici (motor do `fetch()`). A combinação
`fetch()` + `Readable.fromWeb()` quebra quando o consumidor lê sob **backpressure**
e a origem encerra a conexão — exatamente o padrão de um player de áudio, que
consome em tempo real (~20 ms por vez).

Comparação controlada, mesmo arquivo e mesmo padrão de leitura:

| Implementação | Resultado |
|---|---|
| `fetch()` + `Readable.fromWeb()` | crash em ~2 s |
| `node:http` | sobreviveu 20 s |

**Correção:** `src/net/http-stream.ts`, cliente de streaming sobre
`node:http`/`node:https` com redirects, timeout e proteção anti-SSRF.

### 2. `NODE_CAPACITY` bloqueava o nó vazio

A capacidade usava `store.activeCount()`, baseado no campo `status` — que é
**gravável por qualquer cliente** via `PUT /player`. Três requisições
`{"status":"playing"}` deixavam o nó permanentemente inutilizável, sem tocar nada.

**Correção:** a capacidade passa a contar sessões de voz reais
(`voice.activeSessions()`).

### 3. Provider do YouTube inoperante

`src/external.d.ts` declarava `youtubei.js` e `@discordjs/voice` como módulos sem
tipos, o que **desliga o type-check dessas bibliotecas**. Isso escondia um erro real:

```
error TS2322: Type '"TV"' is not assignable to type 'ClientType'
```

Confirmado em execução:

```
client_type: 'TV'           -> clientName: "TV"       (inválido, API responde 400)
client_type: ClientType.TV  -> clientName: "TVHTML5"  (correto)
```

**Correção:** usar `ClientType.TV` e remover os stubs, restaurando o type-check.

---

## Demais correções

| # | Problema | Antes | Depois |
|---|---|---|---|
| 4 | SSRF: `169.254.169.254` (metadados de nuvem) era transmitido | 200 | `403 BLOCKED_ADDRESS` |
| 5 | Corpo JSON não-objeto (`null`, `123`, `[]`) | 500 | `400 INVALID_BODY` |
| 6 | URL com `%` inválido (`/%ZZ.mp3`) | 500 | tratado |
| 7 | `setVolume` não numérico gravava `volume: null` | corrompia | 400 |
| 8 | `setRepeat`/`status` aceitavam valores arbitrários | estado inválido | 400 |
| 9 | `PUT` permitia forjar `guildId`, `positionMs`, `createdAt` | forjável | allow-list |
| 10 | Fila aceitava `["lixo", 123, null]` | 200 | 400 |
| 11 | `positionMs`, `pingMs`, DAVE nunca preenchidos | estáticos | tempo real |
| 12 | `loopMode`/`autoplay` no schema, sem implementação | ignorados | implementados |
| 13 | FFmpeg ausente falhava calado; `stop` gerava `error` falso; SSE/WS vazavam memória; `204` com `Content-Length` | — | corrigidos |

---

## Provider do YouTube (testado com OAuth real)

O fluxo OAuth de dispositivo (TV) foi concluído com uma conta secundária e a sessão
validada (`logged_in = true`, `refresh_token` presente). Isso destravou o provider e
expôs dois bugs que eram invisíveis sem autenticação.

### Bugs encontrados e corrigidos

**Busca retornava vazio.** O YouTube passou a responder com itens `LockupView`
(`content_id` + `metadata.title`) em vez do antigo `Video` (`id` + `title`). O
provider procurava apenas `item.id ?? item.video_id`, não encontrava nada e
descartava todos os resultados em silêncio, devolvendo `loadType: "empty"` — sem
erro algum, o que tornava o diagnóstico difícil.

**URL direta retornava 500.** `getInfo()` monta a página inteira do watch e quebra
com `Cannot read properties of null (reading 'as')` ao encontrar componentes que a
biblioteca ainda não modela. Substituído por `getBasicInfo()`, que consulta somente
o endpoint `/player`.

**Título e autor ausentes.** Verificado na resposta crua do `/player`: os campos
`videoDetails.title` e `.author` não vêm mais preenchidos, em nenhum dos oito
clientes testados. Complementados via oEmbed público, que não exige autenticação.

Resultado após as correções:

```
Busca:      "Never Gonna Give You Up Voice Crack" — MotivationsMelodie — 116000 ms
URL direta: "Rick Astley - Never Gonna Give You Up (4K Remaster)" — Rick Astley — 213000 ms
```

### Streaming SABR no alpha.3

O diagnóstico anterior permanece correto: `youtubei.js.download()` não consegue
baixar todos os vídeos que chegam apenas com `server_abr_streaming_url`. A correção
não tenta inventar uma URL direta. Ela integra a biblioteca `googlevideo`, que
implementa o protocolo proprietário UMP/SABR.

Fluxo atual:

1. tenta o download direto WebM/Opus pelo `youtubei.js`;
2. se a resposta for SABR-only, solicita o player response completo;
3. decifra `server_abr_streaming_url`;
4. converte os adaptive formats com `buildSabrFormat`;
5. inicia `SabrStream` em `AUDIO_ONLY`;
6. seleciona WebM/Opus quando disponível para passthrough;
7. usa FFmpeg somente para seek ou formato incompatível.

OAuth continua obrigatório. Alguns clientes/IPs também exigem Proof-of-Origin;
nesse caso o provider retorna `YOUTUBE_SABR_POTOKEN_REQUIRED` e aceita o valor por
`YOUTUBE_PO_TOKEN`. A geração BotGuard não fica carregada no nó por padrão para não
introduzir `jsdom` e consumo adicional em hosts pequenos.

A integração reduz o bloqueio atual, mas SABR continua sendo um protocolo privado e
sujeito a mudanças sem aviso. O teste repetível agora é:

```bash
npm run build && npm run oauth:youtube
npm run yt:check -- VIDEO_ID 300
```

### Sobre o vetor de crash no caminho do YouTube

Como o bug crítico envolvia `Readable.fromWeb()`, o caminho do YouTube foi
investigado à parte. O `youtubei.js` tem **dois** caminhos de download
(`src/utils/FormatUtils.js`):

- **A** — `type: 'video+audio'` sem `range`: devolve `response.body` **cru** do fetch.
- **B** — demais casos, incluindo **`type: 'audio'`**: devolve
  `new ReadableStream({ pull })`, que lê o fetch em blocos de 10 MB.

Simulação local dos dois, com consumo em tempo real:

| Caminho | Usado quando | Resultado |
|---|---|---|
| A — corpo cru do fetch | `type: 'video+audio'` | **CRASH** `ERR_ASSERTION` |
| B — `ReadableStream` em blocos | **`type: 'audio'`** ← usado pelo LavaLens | **sobreviveu** |

O LavaLens usa `type: 'audio'`, então não está exposto ao bug: cada bloco é
consumido por inteiro dentro do `pull`, sem deixar o corpo do fetch pausado. Ainda
assim foram aplicadas duas proteções: `Readable.fromWeb()` foi trocado por
`webStreamToNode()` (cancela o reader no `destroy` e propaga erros como evento) e um
comentário no provider alerta que mudar para `video+audio` reintroduz o caminho
vulnerável.

## Verificação final (Discord real)

Cenário idêntico ao que provocava a queda, já com as correções:

```
[t+3s]  status=playing  passthrough=true  pos=2480
[t+6s]  status=playing  passthrough=true  pos=5480
[t+9s]  status=playing  passthrough=true  pos=8500
[t+12s] status=playing  passthrough=true  pos=11500
[t+15s] status=playing  passthrough=true  pos=14500   <- ponto da queda anterior
[t+18s] status=playing  passthrough=true  pos=17480

voice: { connected: true, transportEncryption: "aead_aes256_gcm_rtpsize",
         daveProtocolVersion: 1, pingMs: 10 }

health=200 ao final | nenhum erro no log
```

`positionMs` avança em tempo real (antes ficava fixo em `0`).

Segunda rodada (FFmpeg + fila + seek): `seek` → `200` (antes recusava arquivos HTTP
como se fossem transmissão ao vivo), `stop` → `stopped` (antes gerava `error` falso),
nenhuma queda.

**Testes automatizados:** de 1 para **14**, todos passando, com regressão para cada
bug crítico.

---

## Tratamento de exceções

O handler de topo classifica o erro em vez de simplesmente registrar e continuar:

- **Erros de rede transitórios** (`ECONNRESET`, `EPIPE`, `ETIMEDOUT`, incluindo os
  embrulhados em `error.cause` pelo undici) são registrados como `warn` e o processo
  segue — derrubar o nó afetaria todos os demais players.
- **Qualquer outra exceção** é tratada como estado corrompido: desligamento
  controlado (fecha conexões e players) e saída com código `1`, para que o
  supervisor reinicie o processo limpo.

Verificado em execução:

| Cenário | Resultado |
|---|---|
| `ECONNRESET` lançado | `warn` + `/health` continua `200` |
| `TypeError` desconhecido | `uncaughtException` → `shutdown` → exit `1` |

---

## Recomendações

1. **`ALLOW_PRIVATE_NETWORK=false` é o novo padrão.** Para tocar fontes na rede
   local, ative explicitamente.
2. **Vulnerabilidades zeradas.** As 5 CVEs (4 high, 1 crítica) vinham de `tar`
   antigo via `@discordjs/opus` → `node-pre-gyp`. Resolvido com
   `overrides: { "tar": "^7.5.22" }`, mantendo o Opus nativo. `npm audit` agora
   reporta **0 vulnerabilities**.
3. **CI sem FFmpeg:** o workflow roda `npm test` sem instalar FFmpeg, então o
   caminho de transcodificação nunca é exercitado. Vale adicionar o passo.
4. **`autoplay`** continua apenas uma flag; implementação real depende de buscar
   faixas relacionadas pelo provider do YouTube.
5. **Validar o fallback SABR em mais regiões/IPs.** O alpha.3 integra `googlevideo`,
   mas o YouTube pode exigir PO token ou alterar o protocolo. Execute `yt:check` e
   mantenha métricas separadas para caminho direto, SABR e falhas de attestation.
6. **Revogar o acesso OAuth de teste** em <https://myaccount.google.com/permissions>
   quando não for mais necessário. O arquivo `lavalens-oauth.json` contém um
   `refresh_token` de longa duração e está no `.gitignore`.
