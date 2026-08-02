# LavaLens

**LavaLens** é um plano de controle e observabilidade ultraleve para bots de música do Discord. Ele expõe em uma API universal tudo o que o bot e o nó de áudio sabem.

## Dados disponíveis

- tocando, pausado, carregando, reconectando, parado ou erro;
- música, artista, plataforma, URL, ISRC, capa, duração e posição;
- playlist, foto, posição e total de faixas;
- fila, próxima música, autoplay, repetição, volume e filtros;
- canal, ouvintes, shard, região e ping;
- codec, 48 kHz, canais, bitrate, buffer, perda de pacotes e transcodificação;
- nó, versão, CPU, RAM, players, frames perdidos e uptime;
- solicitante e extensões livres;
- eventos e comandos remotos por SSE.

## Limite físico

O **LavaLens** é pequeno e pode ser limitado a 64 MB. O motor de áudio não pode prometer 100 MB e 0,1 CPU para muitos players simultâneos. Cada player precisa buscar, decodificar, codificar Opus e transmitir áudio continuamente. A escala cresce com players ativos.

```text
Bot em qualquer linguagem
       │ REST/SSE
Cloudflare Worker opcional ──► LavaLens
                                      │
                                      ├── Lavalink 4.2.2 ou futuro motor Rust
                                      └── UDP + Voice WebSocket ──► Discord
```

Cloudflare hospeda API, painel e controle sob demanda. O nó de voz fica ativo enquanto houver música.

## Rodar

```bash
export LAVALENS_TOKEN='troque-por-um-token-grande'
go run ./cmd/lavalens
```

```bash
docker compose -f compose.lavalens-only.yml up -d
```

```bash
curl http://localhost:8080/health
curl -H 'Authorization: Bearer change-this-token' http://localhost:8080/v1/status
curl -X PUT -H 'Authorization: Bearer change-this-token' -H 'Content-Type: application/json' --data @examples/snapshot.json http://localhost:8080/v1/guilds/1234567890/player
node examples/nodejs/client.mjs 1234567890
```

Comando remoto:

```bash
curl -X POST -H 'Authorization: Bearer change-this-token' -H 'Content-Type: application/json' -d '{"name":"seek","args":{"positionMs":90000}}' http://localhost:8080/v1/guilds/1234567890/commands
```

## OAuth do YouTube obrigatório

A configuração de produção **não inicia o Lavalink sem** `YOUTUBE_OAUTH_REFRESH_TOKEN`. O cliente `TV` é o único autorizado a reproduzir áudio do YouTube; `WEB` e `MUSIC` ficam restritos a busca e metadados. Assim, não existe fallback de reprodução anônima.

### 1. Gerar o refresh token uma única vez

Use uma conta Google secundária. Execute:

```bash
docker compose -f compose.oauth-setup.yml up
```

Abra o endereço exibido no terminal, informe o código mostrado e conclua o login. Depois copie o `refreshToken` impresso no terminal e encerre o processo com `Ctrl+C`.

### 2. Salvar o segredo

```bash
cp .env.example .env
```

Abra `.env` e substitua `cole_o_refresh_token_aqui` pelo token obtido. Não use aspas extras e nunca envie `.env` ao GitHub.

### 3. Iniciar a pilha completa

```bash
docker compose up -d
```

Sem o token, o Docker Compose interrompe antes de criar o serviço. Fora do Docker, `application.yml` também exige a variável de ambiente:

```bash
export YOUTUBE_OAUTH_REFRESH_TOKEN='seu_refresh_token'
./scripts/start-lavalink.sh
```

O arquivo `application-oauth-setup.yml` existe somente para gerar ou trocar o token. Não deve ser usado como configuração de produção.

## Lavalink v4

`POST /v1/ingest/lavalink` converte o objeto `Player` do Lavalink para o modelo rico. Informações adicionais, como foto da playlist e solicitante, entram em `context.playlist`, `context.request` e `context.extensions`.

## Otimizações

- Go sem dependências externas;
- binário estático e imagem `scratch`;
- estado em memória com TTL;
- histórico curto;
- cliente lento não bloqueia eventos;
- JSON limitado a 512 KiB;
- autenticação Bearer em tempo constante;
- sem banco obrigatório;
- SSE compatível com praticamente qualquer linguagem.

## Cloudflare

```bash
cd cloudflare
npm install
npx wrangler secret put LAVALENS_TOKEN
npm run deploy
```

Ajuste `LAVALENS_ORIGIN`. O Worker não envia áudio UDP ao Discord.

## Próxima fase

O motor nativo em Rust deve implementar DAVE, RTP/UDP, Opus 48 kHz, zero-copy quando possível, resolvers por plataforma, limite por player, auto-sleep sem players e balanceamento entre nós. Ainda assim, 100 MB servem poucos players, não usuários ilimitados.

## Perfis do nó de áudio

- `profiles/application-eco.yml`: menor CPU, qualidade Opus 4 e resampling LOW;
- `profiles/application-balanced.yml`: Opus 8 e resampling MEDIUM;
- `profiles/application-quality.yml`: Opus 10 e resampling HIGH, com maior custo de CPU.

A configuração de qualidade máxima não cabe na mesma promessa de 0,1 CPU para muitos players. Escolha o perfil conforme a host.

## Bridge automático

`examples/nodejs/lavalink-bridge.mjs` consulta os players do Lavalink v4 e envia os estados ao LavaLens. Metadados específicos do bot podem ser guardados em `track.userData`.
