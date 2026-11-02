import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';
import { Readable } from 'stream';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const isProduction = process.env.NODE_ENV === 'production';

// Enable permissive CORS for all clients and video players
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Range, Authorization');
  res.header('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges, Content-Type');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Helper: Rewrite m3u8 playlist so all segment & key URLs route through our stream proxy
function rewriteM3u8(content: string, baseUrl: string, referer?: string): string {
  const lines = content.split('\n');
  return lines
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;

      // Handle Key tags with URI
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

      // Handle stream segment or nested variant playlist URLs
      try {
        const resolved = new URL(trimmed, baseUrl).href;
        return `/api/stream-proxy?url=${encodeURIComponent(resolved)}${referer ? `&referer=${encodeURIComponent(referer)}` : ''}`;
      } catch {
        return trimmed;
      }
    })
    .join('\n');
}

// Resolver dedicado para a fonte real de Homem-Aranha: Um Novo Dia (ID: 969681)
async function resolveHomemAranhaUmNovoDia(): Promise<string> {
  const originUrl = 'http://telaplay93.top:80/movie/LuizDavi@/fBkvnKe5Mq/6250764.mp4';
  try {
    const res = await fetch(originUrl, {
      headers: {
        'User-Agent': 'VLC/3.0.18 LibVLC/3.0.18',
        Accept: '*/*',
      },
      redirect: 'manual',
    });
    if (res.status === 302 || res.status === 301) {
      const loc = res.headers.get('location');
      if (loc) {
        return loc.replace(/^http:\/\//i, 'https://');
      }
    }
  } catch (err: any) {
    console.warn('[Homem-Aranha Resolver error]:', err.message);
  }
  return originUrl;
}

// Stream Proxy Endpoint: Bypasses Mixed Content, missing CORS, and anti-hotlinking headers
app.get('/api/stream-proxy', async (req, res) => {
  const targetUrl = req.query.url as string;
  const customReferer = req.query.referer as string | undefined;
  const customAgent = req.query.agent as string | undefined;

  if (!targetUrl) {
    return res.status(400).json({ error: 'Parâmetro url é obrigatório' });
  }

  // Auto-resolve actual stream for Homem-Aranha: Um Novo Dia 4K [DV][HDR]
  if (
    targetUrl.includes('6250764.mp4') ||
    (targetUrl.includes('telaplay93') && targetUrl.includes('LuizDavi'))
  ) {
    const direct4kUrl = await resolveHomemAranhaUmNovoDia();
    console.log('[StreamProxy] Redirecionando para o arquivo real de Homem-Aranha: Um Novo Dia 4K HDR:', direct4kUrl);
    return res.redirect(direct4kUrl);
  }

  try {
    const urlObj = new URL(targetUrl);
    const headers: Record<string, string> = {
      'User-Agent':
        customAgent ||
        (req.headers['user-agent'] as string) ||
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
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

    if (req.headers.range) {
      headers['Range'] = req.headers.range as string;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);

    const upstreamResponse = await fetch(targetUrl, {
      method: req.method === 'HEAD' ? 'HEAD' : 'GET',
      headers,
      signal: controller.signal,
      redirect: 'follow',
    });

    clearTimeout(timeout);

    const contentType = upstreamResponse.headers.get('content-type') || '';
    const isM3u8 =
      contentType.includes('application/vnd.apple.mpegurl') ||
      contentType.includes('application/x-mpegurl') ||
      targetUrl.includes('.m3u8') ||
      targetUrl.includes('m3u8');

    if (req.method === 'HEAD') {
      res.status(upstreamResponse.status);
      if (upstreamResponse.headers.get('content-type')) {
        res.setHeader('Content-Type', upstreamResponse.headers.get('content-type')!);
      }
      if (upstreamResponse.headers.get('content-length')) {
        res.setHeader('Content-Length', upstreamResponse.headers.get('content-length')!);
      }
      res.setHeader('Accept-Ranges', 'bytes');
      return res.end();
    }

    if (isM3u8) {
      const rawText = await upstreamResponse.text();
      // If it looks like a valid m3u8 playlist, rewrite chunks to keep HTTPS and CORS intact
      if (rawText.includes('#EXTM3U')) {
        const rewritten = rewriteM3u8(rawText, upstreamResponse.url || targetUrl, customReferer);
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        return res.send(rewritten);
      }
      res.setHeader('Content-Type', contentType || 'text/plain');
      return res.send(rawText);
    }

    // Forward binary media chunks (TS, MP4, AAC)
    res.status(upstreamResponse.status);

    for (const [key, val] of upstreamResponse.headers.entries()) {
      const lower = key.toLowerCase();
      if (
        lower === 'content-type' ||
        lower === 'content-length' ||
        lower === 'content-range' ||
        lower === 'accept-ranges' ||
        lower === 'cache-control' ||
        lower === 'etag' ||
        lower === 'last-modified'
      ) {
        res.setHeader(key, val);
      }
    }
    res.setHeader('Accept-Ranges', 'bytes');

    if (upstreamResponse.body) {
      // @ts-expect-error Node.js Readable fromWeb stream
      const nodeStream = Readable.fromWeb(upstreamResponse.body);
      nodeStream.pipe(res);
      req.on('close', () => {
        controller.abort();
      });
    } else {
      res.end();
    }
  } catch (err: any) {
    if (err.name === 'AbortError') {
      return res.status(504).json({ error: 'Timeout ao conectar com a fonte de streaming' });
    }
    console.error('[StreamProxy Error]:', err.message);
    return res.status(502).json({ error: 'Falha ao conectar com o stream remoto', details: err.message });
  }
});

// Proxy for Saimo TV API stream fallback
app.get('/api/stream', async (req, res) => {
  const id = (req.query.id as string) || '';
  const versao = (req.query.versao as string) || 'dub';

  // Dedicated stream resolution for Homem-Aranha: Um Novo Dia (ID: 969681 / 6250764)
  // Resolves directly to the 7GB 4K [DV][HDR] movie stream
  if (id === '969681' || id.startsWith('969681') || id === '6250764') {
    const direct4kUrl = await resolveHomemAranhaUmNovoDia();
    console.log('[API Stream] Homem-Aranha: Um Novo Dia (ID: 969681) resolvido para 4K HDR:', direct4kUrl);
    return res.redirect(direct4kUrl);
  }

  const query = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';
  const targetUrl = `https://saimo-tv.pages.dev/api/stream${query}`;

  try {
    const response = await fetch(targetUrl, {
      headers: {
        'User-Agent': (req.headers['user-agent'] as string) || 'Mozilla/5.0 XerifePlayer/1.0',
        Accept: '*/*',
      },
      redirect: 'manual',
    });

    if (response.status === 302 || response.status === 301) {
      const location = response.headers.get('location');
      if (location) {
        return res.redirect(location);
      }
    }

    if (response.status === 404 && (id === '969681' || id.includes('969681'))) {
      const direct4kUrl = await resolveHomemAranhaUmNovoDia();
      return res.redirect(direct4kUrl);
    }

    const contentType = response.headers.get('content-type') || 'application/json';
    res.setHeader('Content-Type', contentType);
    res.status(response.status);

    if (response.body) {
      // @ts-expect-error Node.js Readable fromWeb stream
      const nodeStream = Readable.fromWeb(response.body);
      nodeStream.pipe(res);
    } else {
      res.end();
    }
  } catch (err: any) {
    console.error('[API Stream Error]:', err.message);
    res.status(502).json({ error: 'Falha no resolvedor de stream', details: err.message });
  }
});

// Catalogs proxy/cache for extreme stability (ensures offline/CDN hiccup resilience)
const catalogCache = new Map<string, { data: string; timestamp: number }>();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

async function fetchCachedText(url: string, cacheKey: string): Promise<string> {
  const cached = catalogCache.get(cacheKey);
  const now = Date.now();
  if (cached && now - cached.timestamp < CACHE_TTL_MS) {
    return cached.data;
  }
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 XerifePlayer/1.0',
      },
    });
    if (res.ok) {
      const text = await res.text();
      catalogCache.set(cacheKey, { data: text, timestamp: now });
      return text;
    }
  } catch (e) {
    console.warn(`[Catalog fetch fallback for ${cacheKey}]:`, e);
  }
  if (cached) return cached.data;
  throw new Error(`Não foi possível carregar o catálogo ${cacheKey}`);
}

app.get('/api/catalogo.txt', async (_req, res) => {
  try {
    const data = await fetchCachedText('https://canais-saimo.pages.dev/catalogo.txt', 'catalogo');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(data);
  } catch (err: any) {
    res.status(502).send(err.message);
  }
});

app.get('/api/indice.txt', async (_req, res) => {
  try {
    const data = await fetchCachedText('https://filmes-saimo.pages.dev/indice.txt', 'indice');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(data);
  } catch (err: any) {
    res.status(502).send(err.message);
  }
});

app.get('/api/destaques.txt', async (_req, res) => {
  try {
    const data = await fetchCachedText('https://filmes-saimo.pages.dev/destaques.txt', 'destaques');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=1800');
    res.send(data);
  } catch (err: any) {
    res.status(502).send(err.message);
  }
});

app.get('/api/fichas.txt', async (_req, res) => {
  try {
    const data = await fetchCachedText('https://filmes-saimo.pages.dev/fichas.txt', 'fichas');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=7200');
    res.send(data);
  } catch (err: any) {
    res.status(502).send(err.message);
  }
});

// Generic endpoint for letter files: /api/catalog/filmes-A.txt, /api/catalog/series-B.txt
app.get('/api/catalog/:file', async (req, res) => {
  const fileName = req.params.file;
  if (!/^[\w#.-]+\.txt$/.test(fileName)) {
    return res.status(400).send('Nome de arquivo inválido');
  }
  const baseUrl = fileName === 'catalogo.txt' ? 'https://canais-saimo.pages.dev/' : 'https://filmes-saimo.pages.dev/';
  try {
    let data = await fetchCachedText(`${baseUrl}${fileName}`, fileName);
    if (fileName === 'filmes-H.txt') {
      data = data.replace(
        /Homem-Aranha:\s*Um Novo Dia[^\n]+/g,
        'Homem-Aranha: Um Novo Dia\tdub=/api/stream?tipo=movie&id=969681&versao=dub,/api/stream-proxy?url=http%3A%2F%2Ftelaplay93.top%3A80%2Fmovie%2FLuizDavi%40%2FfBkvnKe5Mq%2F6250764.mp4\tleg=/api/stream?tipo=movie&id=969681&versao=leg'
      );
    }
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(data);
  } catch (err: any) {
    res.status(502).send(err.message);
  }
});

// Comprehensive Catalog & ID Audit endpoint
app.get('/api/catalog-audit', async (_req, res) => {
  try {
    const [destaquesText, fichasSample] = await Promise.all([
      fetchCachedText('https://filmes-saimo.pages.dev/destaques.txt', 'destaques'),
      fetchCachedText('https://filmes-saimo.pages.dev/fichas.txt', 'fichas'),
    ]);

    const fichaLines = fichasSample.split('\n');
    let totalFichas = 0;
    let moviesCount = 0;
    let seriesCount = 0;
    let withTmdbId = 0;
    let withPoster = 0;

    for (let i = 0; i < fichaLines.length; i++) {
      const line = fichaLines[i];
      if (!line || line.startsWith('#') || line.startsWith('capa:')) continue;
      const parts = line.split('\t');
      if (parts.length >= 3) {
        totalFichas++;
        if (parts[0] === 'f') moviesCount++;
        else if (parts[0] === 's') seriesCount++;
        if (parts[2] && parts[2].trim()) withTmdbId++;
        const poster = parts[3]?.trim();
        if (poster && (poster.endsWith('.jpg') || poster.endsWith('.png') || poster.endsWith('.jpeg'))) {
          withPoster++;
        }
      }
    }

    const destaquesLines = destaquesText.split('\n');
    let totalDestaques = 0;
    let destaquesWithPoster = 0;
    const categoriasDestaques: string[] = [];

    for (const line of destaquesLines) {
      if (!line || line.startsWith('#') || line.startsWith('capa:')) continue;
      const parts = line.split('\t');
      if (parts[0] === 'fila') {
        categoriasDestaques.push(parts[1]);
        continue;
      }
      if (parts.length >= 4) {
        totalDestaques++;
        const poster = parts[4]?.trim();
        if (poster && (poster.endsWith('.jpg') || poster.endsWith('.png') || poster.endsWith('.jpeg'))) {
          destaquesWithPoster++;
        }
      }
    }

    res.json({
      status: 'success',
      totalCatalogEntries: totalFichas,
      movies: moviesCount,
      series: seriesCount,
      tmdbCompatibility: {
        totalWithTmdbId: withTmdbId,
        percentageValidTmdbIds: `${((withTmdbId / totalFichas) * 100).toFixed(2)}%`,
        totalWithValidPoster: withPoster,
        percentageValidPosters: `${((withPoster / totalFichas) * 100).toFixed(2)}%`,
      },
      homeHighlights: {
        total: totalDestaques,
        withPosters: destaquesWithPoster,
        categories: categoriasDestaques,
        percentage: `${((destaquesWithPoster / totalDestaques) * 100).toFixed(2)}%`,
      },
      tmdbApiActive: true,
      imageProxyActive: true,
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// App info endpoint
app.get('/api/status', (_req, res) => {
  res.json({
    status: 'online',
    app: 'Xerife Player',
    streamingProxy: true,
    hlsOptimization: true,
    timestamp: new Date().toISOString(),
  });
});

async function startServer() {
  if (!isProduction) {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: process.env.DISABLE_HMR !== 'true',
        watch: process.env.DISABLE_HMR === 'true' ? null : {},
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    // In production, serve the built static directory with SPA fallback
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Xerife Player] Servidor rodando com alta performance na porta ${PORT}`);
  });
}

startServer();
