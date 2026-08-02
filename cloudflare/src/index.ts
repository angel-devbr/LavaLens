interface Env {
  LAVALENS_ORIGIN: string;
  NODE_WAKE_URL?: string;
  LAVALENS_TOKEN: string;
}

async function wake(env: Env): Promise<void> {
  if (!env.NODE_WAKE_URL) return;
  try { await fetch(env.NODE_WAKE_URL, { method: 'POST', headers: { authorization: `Bearer ${env.LAVALENS_TOKEN}` } }); }
  catch { /* o proxy ainda tentará alcançar o nó */ }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health') return Response.json({ ok: true, edge: true });
    if (request.headers.get('upgrade') === 'websocket' || request.method !== 'GET') ctx.waitUntil(wake(env));
    const upstream = new URL(url.pathname + url.search, env.LAVALENS_ORIGIN);
    const headers = new Headers(request.headers);
    headers.set('authorization', `Bearer ${env.LAVALENS_TOKEN}`);
    headers.set('x-lavalens-edge', 'cloudflare');
    return fetch(upstream, { method: request.method, headers, body: request.body, redirect: 'manual' });
  }
} satisfies ExportedHandler<Env>;
