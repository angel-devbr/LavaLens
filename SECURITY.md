# Segurança

- OAuth do YouTube é obrigatório quando o provider está habilitado.
- Cookies do navegador não são suportados.
- Credenciais ficam fora do Git e devem ter permissão de arquivo restrita.
- A autenticação usa Bearer token e comparação em tempo constante.
- JSON é limitado por `MAX_BODY_BYTES`.
- Use TLS/HTTPS e firewall; não exponha o nó diretamente sem Cloudflare ou proxy reverso.
- Trate URLs, metadados e extensões como entrada não confiável.
- Faça rotação de tokens e use uma conta Google secundária.
- Reporte vulnerabilidades de forma privada ao mantenedor antes de abrir issue pública.
