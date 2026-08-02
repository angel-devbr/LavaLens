# Revisão local — v0.1.0-alpha.5

Data: 2026-08-02

## Resultado

- 26 testes automatizados aprovados; zero falhas.
- Scripts E2E e de verificação do YouTube passaram na checagem sintática.
- Nenhum token Discord, credencial OAuth ou PO token real foi encontrado no pacote.
- Benchmark de 10.000 estados inativos: 24,33 ms; RSS total 66,11 MiB; aumento 22,34 MiB neste ambiente.

## Regressões cobertas

- posição absoluta depois de seek;
- mudança de volume sem perder posição;
- restauração do passthrough ao voltar para 100%;
- ordem correta do `-ss` do FFmpeg em URL e `pipe:0`;
- contrato real do avaliador JavaScript do youtubei.js;
- isolamento de `require` e `process`;
- timeout do interpretador;
- SSRF IPv4/IPv6, NAT64 e DNS pinning;
- seleção de áudio SABR WebM/Opus;
- validação de autoplay.

## Limitações da revisão

O ambiente utilizado não conseguiu instalar as dependências pelo registro npm nem acessar Discord/YouTube. A compilação JavaScript foi emitida com o TypeScript disponível e os testes do núcleo foram executados sobre essa saída. O teste real de Discord Voice, DAVE, OAuth e SABR descrito no relatório da alpha.4 não foi repetido nesta revisão.
