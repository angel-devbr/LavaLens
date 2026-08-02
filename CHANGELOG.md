# Changelog

## 0.2.0 - OAuth obrigatório

- OAuth do YouTube obrigatório em produção.
- Inicialização bloqueada sem `YOUTUBE_OAUTH_REFRESH_TOKEN`.
- Cliente `TV` como único cliente de reprodução do YouTube.
- Reprodução anônima do cliente `WEB` desativada.
- Configuração isolada para emissão inicial do refresh token.
- Validação para Docker Compose, Linux/macOS e Windows PowerShell.
- Proteção do arquivo `.env` no `.gitignore`.
