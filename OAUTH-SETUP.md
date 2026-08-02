# Configuração obrigatória do OAuth do YouTube

A configuração de produção do LavaLens/Lavalink recusa iniciar sem um refresh token do YouTube. Cookies não são utilizados.

## Gerar o token

1. Use uma conta Google secundária exclusiva para o bot.
2. Execute `docker compose -f compose.oauth-setup.yml up`.
3. Abra o endereço exibido no terminal e informe o código temporário.
4. Copie o `refreshToken` impresso após a autorização.
5. Encerre o modo de configuração com `Ctrl+C`.

## Ativar a produção

1. Execute `cp .env.example .env`.
2. Coloque o token em `YOUTUBE_OAUTH_REFRESH_TOKEN`.
3. Execute `docker compose up -d`.

O Compose aborta imediatamente se a variável estiver ausente ou vazia. O `application.yml` também referencia a variável sem valor padrão, e `skipInitialization: true` impede que a produção caia silenciosamente no fluxo interativo.

## Como a reprodução foi restringida

- `WEB`: busca, URLs, playlists e metadados; reprodução desativada.
- `MUSIC`: busca do YouTube Music; não reproduz áudio.
- `TV`: único cliente autorizado a reproduzir; exige OAuth.

Assim, o nó não possui fallback anônimo para o stream de áudio do YouTube.
