# 🚀 Como publicar o Xerife Player PWA em um link externo permanente

Este pacote contém o **build de produção pronto** (HTML + JS + CSS + PWA:
manifest, service worker e ícones). Não há backend — todo o conteúdo vem dos
catálogos públicos do Saimo TV. Basta hospedar os arquivos em qualquer host
estático com HTTPS.

Tempo total: **~2 minutos**.

---

## Opção 1 — Cloudflare Pages (recomendado, igual ao Saimo TV)

A mesma plataforma que hospeda o saimo-tv.pages.dev. Grátis, com HTTPS,
SPA fallback e PWA funcionando.

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

## Opção 2 — Linha de comando (wrangler)

```bash
npm install -g wrangler
wrangler login
wrangler pages deploy . --project-name=xerife-player
```

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

O código-fonte completo está no projeto (`xerifeplayer-main/`), sem Supabase
e sem Netlify:

```bash
cd xerifeplayer-main
npm install
npm run build      # gera dist/
```
