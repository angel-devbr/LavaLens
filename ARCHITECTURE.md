# Arquitetura

## Princípios

1. Um único runtime: Node.js 24 e código TypeScript.
2. Sem Lavalink e sem JVM.
3. Núcleo HTTP/WebSocket escrito com módulos nativos para menor overhead.
4. Dependências de voz e YouTube carregadas de forma preguiçosa.
5. Opus passthrough primeiro; FFmpeg somente para incompatibilidades ou seek.
6. Estado rico desacoplado do cliente do bot.

## Plano de dados

`PlayerStore` mantém estados compactos em memória e remove players inativos por TTL. `EventBus` possui histórico limitado e entrega eventos a SSE e WebSocket. O estado pode ser reconstruído pelo bot depois de reinício.

## Plano de voz

`RemoteAdapter` implementa o adaptador customizado do `@discordjs/voice`. O nó publica os payloads que o bot deve enviar ao Discord Gateway. O bot devolve os dois eventos de voz. A biblioteca realiza Voice Gateway v8, UDP, transporte Opus e DAVE.

## Providers

- HTTP: stream direto quando já for WebM/Ogg Opus; caso contrário FFmpeg.
- YouTube: YouTube.js com cliente TV e OAuth obrigatório; tenta WebM/Opus direto e usa googlevideo para SABR/UMP somente áudio.
- Providers futuros seguem a mesma interface e registram uma função `open()` no `SourceRegistry`.

## Escala

Um nó fraco deve limitar players ativos. Vários nós podem ser colocados atrás de um scheduler externo/Cloudflare. Cada guilda deve permanecer fixada ao mesmo nó enquanto estiver tocando.
