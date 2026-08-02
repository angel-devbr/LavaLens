# Implantação

## Wispbyte ou host Node.js

- Runtime: Node.js
- Versão: Node.js 24
- Instalação: `npm install`
- Build: `npm run build`
- Inicialização: `npm start`
- FFmpeg deve estar instalado no sistema.

Variáveis mínimas: `LAVALENS_TOKEN`, `YOUTUBE_ENABLED` e, quando YouTube estiver ativo, um arquivo/JSON de credenciais OAuth.

## Docker

```bash
cp .env.example .env
mkdir -p data
docker compose up -d --build
```

## Cloudflare

O Worker em `cloudflare/` é somente a borda HTTP/WebSocket. O nó de voz permanece em uma host com UDP de saída e processo contínuo.
