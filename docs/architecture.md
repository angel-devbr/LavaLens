# Arquitetura do LavaLens

## 1. Separação obrigatória

### Plano de controle

Pode ser serverless e extremamente leve. Responsabilidades:

- autenticação e rate limits;
- estado atual de cada guild;
- eventos e comandos;
- dashboard e API pública;
- descoberta e balanceamento de nós;
- cache de metadados de música, álbum e playlist.

### Plano de áudio

Precisa permanecer ativo durante a reprodução. Responsabilidades:

- Voice Gateway do Discord;
- DAVE/E2EE;
- UDP, RTP e criptografia;
- obtenção e decodificação da origem;
- Opus estéreo a 48 kHz;
- filtros, volume, seek e buffers.

## 2. Modos de implantação

### Híbrido recomendado

- Cloudflare Worker: domínio, API externa, autenticação e painel;
- LavaLens Go: estado rico, SSE e comandos;
- um ou mais nós Lavalink 4.2.2 ou motores nativos;
- bots em Node.js, Python, Java, Go, Rust, C#, PHP ou qualquer linguagem HTTP.

### 24/7 simples

LavaLens e Lavalink no mesmo VPS/container host. É mais fácil, mas requer RAM suficiente para a JVM.

### Sob demanda

O controle pode dormir. O áudio só pode dormir quando não existem players. Ao iniciar uma música, um provedor externo pode despertar um nó; depois de conectado, ele precisa permanecer ativo até a última música terminar.

## 3. Escala

- Shard por guild ID para evitar um mapa global gigante.
- Um estado compacto por guild, sem armazenar a fila completa por padrão.
- Histórico limitado e TTL.
- Eventos em lote para dashboards grandes.
- Balanceamento por players ativos, CPU, frames deficitários, memória e região.
- Backpressure: observadores lentos perdem telemetria antiga, nunca travam áudio.

## 4. Motor Rust futuro

Componentes propostos:

- `gateway`: REST, WebSocket/SSE e autenticação;
- `voice`: Discord Voice v8, DAVE, UDP/RTP;
- `resolver`: YouTube, SoundCloud, HTTP e plugins;
- `pipeline`: demux, decode, resample e Opus;
- `metadata`: track/album/playlist/artwork;
- `scheduler`: limite de players e balanceamento;
- `telemetry`: estado detalhado compatível com LavaLens.

A primeira otimização deve ser evitar transcodificação quando o fluxo de origem já puder ser entregue em Opus compatível. Quando isso não for possível, CPU por player continuará inevitável.
