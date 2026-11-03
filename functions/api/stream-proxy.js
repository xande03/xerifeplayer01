// functions/api/stream-proxy.js
// Proxy de streaming para deploys estáticos do Xerife Player na Cloudflare Pages.
// Mesma lógica do server.ts (Express): reescreve playlists HLS, injeta Referer/UA,
// repassa Range/HEAD e rejeita "fake-200" (HTML de bloqueio geo/challenge) com 502
// para o player trocar para a próxima fonte imediatamente.
//
// IMPORTANTE: este arquivo só entra no deploy quando publicado com
// `npx wrangler pages deploy` (ou integração Git). O upload por arrastar-e-soltar
// no dashboard NÃO inclui functions/.

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Origin, X-Requested-With, Content-Type, Accept, Range, Authorization',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, Content-Type',
};

function rewriteM3u8(content, baseUrl, referer) {
  const lines = content.split('\n');
  return lines
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;

      if (trimmed.startsWith('#')) {
        if (trimmed.includes('URI="')) {
          return trimmed.replace(/URI="([^"]+)"/g, (_, p1) => {
            try {
              const resolved = new URL(p1, baseUrl).href;
              const proxyUrl = `/api/stream-proxy?url=${encodeURIComponent(resolved)}${referer ? `&referer=${encodeURIComponent(referer)}` : ''}`;
              return `URI="${proxyUrl}"`;
            } catch {
              return `URI="${p1}"`;
            }
          });
        }
        return line;
      }

      try {
        const resolved = new URL(trimmed, baseUrl).href;
        return `/api/stream-proxy?url=${encodeURIComponent(resolved)}${referer ? `&referer=${encodeURIComponent(referer)}` : ''}`;
      } catch {
        return trimmed;
      }
    })
    .join('\n');
}

async function handle(context) {
  const { request } = context;
  const reqUrl = new URL(request.url);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: CORS_HEADERS });
  }

  const targetUrl = reqUrl.searchParams.get('url');
  const customReferer = reqUrl.searchParams.get('referer') || undefined;
  const customAgent = reqUrl.searchParams.get('agent') || undefined;

  if (!targetUrl) {
    return Response.json({ error: 'Parâmetro url é obrigatório' }, { status: 400, headers: CORS_HEADERS });
  }

  let urlObj;
  try {
    urlObj = new URL(targetUrl);
  } catch {
    return Response.json({ error: 'URL inválida' }, { status: 400, headers: CORS_HEADERS });
  }

  // Verificação básica de protocolo (evita open-proxy para esquemas exóticos)
  if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') {
    return Response.json({ error: 'Protocolo não suportado' }, { status: 400, headers: CORS_HEADERS });
  }

  let defaultAgent =
    request.headers.get('user-agent') ||
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/.test(urlObj.hostname) || urlObj.port === '8080' || urlObj.port === '8000') {
    defaultAgent = 'VLC/3.0.18 LibVLC/3.0.18';
  }

  const headers = {
    'User-Agent': customAgent || defaultAgent,
    Accept: '*/*',
    'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
  };

  if (customReferer) {
    headers['Referer'] = customReferer;
    try {
      headers['Origin'] = new URL(customReferer).origin;
    } catch {}
  } else if (urlObj.hostname.includes('cdn13embed') || urlObj.hostname.includes('embedtv')) {
    headers['Referer'] = 'https://embedcanaisdetv.xyz/';
    headers['Origin'] = 'https://embedcanaisdetv.xyz';
  }

  const range = request.headers.get('range');
  if (range) headers['Range'] = range;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

  let upstream;
  try {
    upstream = await fetch(targetUrl, {
      method: request.method === 'HEAD' ? 'HEAD' : 'GET',
      headers,
      signal: controller.signal,
      redirect: 'follow',
      cf: { cacheTtl: 0, cacheEverything: false },
    });
  } catch (err) {
    clearTimeout(timeout);
    const aborted = err && (err.name === 'AbortError' || String(err).includes('abort'));
    return Response.json(
      { error: aborted ? 'Timeout ao conectar com a fonte de streaming' : 'Falha ao conectar com o stream remoto' },
      { status: aborted ? 504 : 502, headers: CORS_HEADERS },
    );
  }
  clearTimeout(timeout);

  if (!upstream.ok) {
    return new Response('Fonte de vídeo indisponível', { status: upstream.status, headers: CORS_HEADERS });
  }

  const contentType = upstream.headers.get('content-type') || '';
  const isM3u8 =
    contentType.includes('application/vnd.apple.mpegurl') ||
    contentType.includes('application/x-mpegurl') ||
    targetUrl.includes('.m3u8') ||
    targetUrl.includes('m3u8');

  if (request.method === 'HEAD') {
    const h = new Headers(CORS_HEADERS);
    if (upstream.headers.get('content-type')) h.set('Content-Type', upstream.headers.get('content-type'));
    if (upstream.headers.get('content-length')) h.set('Content-Length', upstream.headers.get('content-length'));
    h.set('Accept-Ranges', 'bytes');
    return new Response(null, { status: upstream.status, headers: h });
  }

  if (isM3u8) {
    const rawText = await upstream.text();
    if (rawText.includes('#EXTM3U')) {
      const rewritten = rewriteM3u8(rawText, upstream.url || targetUrl, customReferer);
      return new Response(rewritten, {
        status: 200,
        headers: {
          ...CORS_HEADERS,
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
        },
      });
    }
    // Fake-200: 200 sem playlist HLS válida (HTML de bloqueio geo/challenge).
    return Response.json(
      { error: 'Fonte retornou conteúdo inválido (não é uma playlist HLS válida)' },
      { status: 502, headers: CORS_HEADERS },
    );
  }

  // Fake-200 binário: HTML no lugar de mídia (bloqueio geo/challenge).
  if (contentType.includes('text/html')) {
    return Response.json(
      { error: 'Fonte de vídeo bloqueada ou indisponível (resposta HTML)' },
      { status: 502, headers: CORS_HEADERS },
    );
  }

  const out = new Headers(CORS_HEADERS);
  for (const key of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control', 'etag', 'last-modified']) {
    const val = upstream.headers.get(key);
    if (val) out.set(key, val);
  }
  out.set('Accept-Ranges', 'bytes');

  return new Response(upstream.body, { status: upstream.status, headers: out });
}

export const onRequestGet = handle;
export const onRequestHead = handle;
export const onRequestOptions = handle;
