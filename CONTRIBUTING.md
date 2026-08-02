# Contribuindo

1. Crie uma issue descrevendo mudança, risco e impacto de memória/CPU.
2. Use Node.js 24.
3. Rode `npm test`.
4. Novos providers devem implementar `Provider` e nunca baixar a mídia inteira para memória.
5. Novos recursos de áudio precisam incluir benchmark de RSS, CPU e latência.
6. Não inclua tokens, cookies, credenciais ou mídia protegida nos testes.
