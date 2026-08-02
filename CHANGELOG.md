# Changelog

## 0.1.0-alpha.2 — 2026-08-02

- Corrige limite de capacidade para contar sessões de voz reais.
- `stop` não inicia mais a próxima faixa da fila.
- Volume agora é aplicado ao recurso de áudio, não apenas à telemetria.
- Posição de reprodução passa a avançar e é sincronizada nas consultas.
- Validação de volume, seek, autoplay e modo de repetição.
- Loop de faixa e loop de fila aplicados ao término natural.
- Encerramento seguro de conexões SSE.
- Testes com adaptador de voz simulado e script E2E para Discord real.

## 0.1.0-alpha.1 — 2026-08-02

- Primeira implementação independente em Node.js/TypeScript.
- Sem Lavalink, Java ou banco obrigatório.
- API REST, SSE, WebSocket, telemetria e estado detalhado.
- Adaptador remoto para Discord Voice/DAVE.
- YouTube.js com OAuth TV obrigatório e sem cookies.
- Opus passthrough e FFmpeg sob demanda.
- Worker Cloudflare e exemplos de clientes.
