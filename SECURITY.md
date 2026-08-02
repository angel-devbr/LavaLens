# Segurança

- Nunca publique `LAVALENS_TOKEN`, `YOUTUBE_OAUTH_REFRESH_TOKEN`, senha do Lavalink, token do bot ou cookies de provedores.
- Use HTTPS entre bots, Cloudflare e nós de áudio.
- Use um token diferente por ambiente e faça rotação periódica.
- Não exponha a porta 2333 do Lavalink diretamente sem firewall e autenticação.
- Dados em `extensions`, `pluginInfo` e `userData` devem ser tratados como não confiáveis pelo dashboard.

- Use uma conta Google secundária exclusiva para o nó de áudio; não use sua conta principal.
- O arquivo `.env` deve permanecer fora do Git e com acesso restrito ao usuário do serviço.
- `application-oauth-setup.yml` serve apenas para emitir ou renovar o token; volte ao `application.yml` após concluir.
