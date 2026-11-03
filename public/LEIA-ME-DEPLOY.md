# 🚀 Como publicar o Xerife Player PWA em um link externo permanente

Este projeto contém o **build de produção pronto** (HTML + JS + CSS + PWA:
manifest, service worker e ícones) + **proxy de streaming serverless**
(`functions/`, Cloudflare Pages Functions). O conteúdo vem dos catálogos
públicos do Saimo TV.

> ⚠️ **Importante:** publique sempre com `wrangler` (Opção 2) ou integração
> Git. O upload por **arrastar-e-soltar** (Opção 1) NÃO inclui a pasta
> `functions/` — sem ela, fontes de vídeo `http://` (a maioria dos canais e
> parte dos filmes dublados) não conseguem tocar por causa do bloqueio de
> mixed-content do navegador e o app mostra "Tente novamente".

---

## Opção 1 — Cloudflare Pages por arrastar-e-soltar (limitada)

> ⚠️ Só use se não puder instalar o wrangler. Sem a pasta `functions/`, o
> proxy de streams não existe: canais e filmes com fonte `http://` ficarão
> com "Tente novamente". Prefira a Opção 2.

1. Acesse **https://dash.cloudflare.com** → crie conta grátis (só e-mail)
2. Menu lateral → **Workers & Pages** → **Create** → **Pages** →
   **Upload assets** (enviar arquivos / arrastar pasta)
3. Dê um nome ao projeto (ex.: `xerife-player`) e **arraste o conteúdo**
   desta pasta (arquivos `index.html`, `_redirects`, `_headers`, `assets/`,
   `sw.js`, `manifest.webmanifest`, ícones etc.)
4. Clique em **Deploy (or Deploy site)**

Pronto: em segundos você recebe um link permanente tipo
**https://xerife-player.pages.dev/** — abra no navegador e instale como app:

- **Desktop (Chrome/Edge):** ícone de instalação ⊕ na barra de endereço
- **Android (Chrome):** menu ⋮ → *Adicionar à tela inicial*
- **iPhone (Safari):** Compartilhar → *Adicionar à Tela de Início*

## Opção 2 — Linha de comando (wrangler) ✅ RECOMENDADO

Inclui automaticamente a pasta `functions/` (proxy de streaming serverless
correndo na edge da Cloudflare, sem CORS e sem mixed-content):

```bash
npm install -g wrangler
npm run build          # gera dist/ (index.html + assets + functions)
wrangler login
wrangler pages deploy dist --project-name=xerife-player
```

> A pasta `functions/` deve existir na raiz do projeto ao rodar o deploy — o
> wrangler empacota `dist/` + `functions/` juntos. Valide depois abrindo
> `https://SEU-PROJETO.pages.dev/api/status` — deve retornar JSON com
> `"app": "Xerife Player"`.

## Opção 3 — Qualquer outro host estático

O pacote funciona em Vercel, Netlify, GitHub Pages, hospedagem própria etc.
Requisitos:

1. Servir `index.html` como fallback de rotas (SPA) — os arquivos
   `_redirects` e `_headers` já inclusos fazem isso na Cloudflare Pages;
   em outros hosts configure o equivalente (ex.: Vercel `rewrites`,
   Netlify já usa `_redirects`, nginx `try_files $uri /index.html;`)
2. `manifest.webmanifest` servido como `application/manifest+json`
3. HTTPS obrigatório (para service worker + instalação do PWA)

---

## 📦 O que tem no pacote

| Arquivo | Papel |
| --- | --- |
| `index.html` | Shell do app (interface Xerife Player) |
| `assets/` | JS/CSS com hash + logos das plataformas |
| `manifest.webmanifest` | Manifesto PWA (nome, ícones, standalone) |
| `sw.js` | Service worker: cache do shell + catálogos para offline |
| `pwa-192x192.png`, `pwa-512x512.png` | Ícones de instalação |
| `_redirects`, `_headers` | Config de SPA fallback e cache (Cloudflare Pages) |

## 🎬 Conteúdo

- **Filmes e séries** — catálogos de `filmes-saimo.pages.dev` (metadados TMDB pt-BR)
- **Canais ao vivo** — catálogo de `canais-saimo.pages.dev` (400+ canais)
- Player HLS (hls.js) e MP4 com fallback automático entre fontes,
  mesma lógica do site original saimo-tv.pages.dev

> Observação: as fontes de vídeo são streams públicos e podem oscilar;
> o player troca para a fonte seguinte automaticamente quando uma falha.

## 🔧 Reconstruir o app (opcional)

O código-fonte está no projeto (`src/` + bundle `public/assets/index-xerife-catalog-v6.js`):

```bash
npm install
npm run build      # gera dist/
npm run dev        # servidor Express local com proxy na porta 3000
```

### O que mudou na versão v1.0.5-playback

- `index-xerife-catalog-v6.js`: fontes de canais agora repassam `referer`/`agente`
  ao proxy (antes eram descartados) e o player respeita a sonda `__XERIFE_PROXY__`;
- `sw.js`: versão nova (`xerife-v1.0.5-playback`) e `/api/*` nunca mais vai para
  cache (antes o `index.html` do fallback SPA era cacheado como se fosse vídeo);
- `server.ts` + `functions/api/stream-proxy.js`: respostas "fake-200" (HTML de
  bloqueio geográfico tipo XUI `NOT_IN_ALLOWED_COUNTRY`, challenge Cloudflare ou
  o próprio fallback SPA) agora retornam **502** para o player trocar de fonte
  imediatamente em vez de travar em "Tente novamente";
- `functions/`: proxy serverless para a Cloudflare Pages (deploy estático volta a
  ter o mesmo poder do servidor Express).
