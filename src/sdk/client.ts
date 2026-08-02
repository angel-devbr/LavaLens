export class LavaLensClient {
  constructor(public readonly baseUrl: string, private readonly token: string) {}
  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(new URL(path, this.baseUrl), {
      ...init,
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json', ...init.headers }
    });
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.message ?? `HTTP ${response.status}`), { data, status: response.status });
    return data as T;
  }
  status() { return this.request('/v1/status'); }
  player(guildId: string) { return this.request(`/v1/guilds/${guildId}/player`); }
  load(guildId: string, query: string, requestedBy?: string) {
    return this.request(`/v1/guilds/${guildId}/load`, { method: 'POST', body: JSON.stringify({ query, requestedBy }) });
  }
  connect(guildId: string, channelId: string, shardId = 0) {
    return this.request(`/v1/guilds/${guildId}/voice/connect`, { method: 'POST', body: JSON.stringify({ channelId, shardId }) });
  }
  voiceUpdate(guildId: string, type: 'server' | 'state', payload: unknown) {
    return this.request(`/v1/guilds/${guildId}/voice/update`, { method: 'POST', body: JSON.stringify({ type, payload }) });
  }
  play(guildId: string, query: string) {
    return this.request(`/v1/guilds/${guildId}/play`, { method: 'POST', body: JSON.stringify({ query }) });
  }
  command(guildId: string, name: string, args: Record<string, unknown> = {}) {
    return this.request(`/v1/guilds/${guildId}/commands`, { method: 'POST', body: JSON.stringify({ name, args }) });
  }
}
