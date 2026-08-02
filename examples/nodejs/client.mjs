const baseURL = process.env.LAVALENS_URL ?? "http://localhost:8080";
const token = process.env.LAVALENS_TOKEN ?? "change-this-token";
const guildId = process.argv[2] ?? "1234567890";
const response = await fetch(`${baseURL}/v1/guilds/${guildId}/player`, {headers:{Authorization:`Bearer ${token}`}});
if (!response.ok) throw new Error(`LavaLens ${response.status}: ${await response.text()}`);
const state = await response.json();
console.log({tocando:state.playback.status==="playing",musica:state.track?.title??null,artista:state.track?.author??null,plataforma:state.track?.sourceName??null,foto:state.track?.artworkUrl??null,playlist:state.playlist?.name??null,fotoDaPlaylist:state.playlist?.artworkUrl??null,posicaoMs:state.playback.positionMs,duracaoMs:state.playback.durationMs,ouvintes:state.discord.listeners,pingVozMs:state.discord.voicePingMs,codec:state.audio.codec,bitrateKbps:state.audio.bitrateKbps});
