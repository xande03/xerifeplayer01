// functions/api/status.js
// Endpoint de status para deploys estáticos na Cloudflare Pages.
// O boot probe do index.html consulta /api/status para saber se o backend
// (/api/stream-proxy) está disponível: JSON com app "Xerife Player" -> true.

export async function onRequest() {
  return new Response(
    JSON.stringify({
      status: 'online',
      app: 'Xerife Player',
      streamingProxy: true,
      hlsOptimization: true,
      timestamp: new Date().toISOString(),
    }),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
      },
    },
  );
}
