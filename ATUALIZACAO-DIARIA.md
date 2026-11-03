# 🔄 Atualização diária de fontes e IDs

Este app se mantém atualizado **sozinho**, todos os dias, para reduzir
"carregamento infinito", "não foi possível iniciar a reprodução" e conteúdo
inativo. Ninguém precisa mexer em nada.

## Como funciona

```
Todo dia 05:00 (Brasília) — GitHub Actions
  └─ scripts/atualizacao_diaria.py
       ├─ baixa os catálogos do Saimo (filmes, séries, canais, fichas/IDs)
       ├─ testa amostras reais de fontes (episódios, filmes e canais)
       ├─ marca hosts mortos / instáveis e IDs de conteúdo inativo
       └─ grava e envia (commit) public/data/saude-fontes.json
                                        public/data/catalogo-status.json

Quando você abre o app
  ├─ index.html carrega a lista de fontes mortas do dia
  │    (raw.githubusercontent.com → fallback: arquivo do deploy)
  ├─ o player (bundle v7) tenta primeiro fontes de hosts saudáveis;
  │    hosts mortos só são usados se não sobrar alternativa
  └─ catálogos do Saimo são buscados com cache-busting diário; se o
       servidor de catálogo cair, vale a última cópia boa no IndexedDB
       (nada de tela travada em "carregando")
```

## Arquivos gerados

| Arquivo | Conteúdo |
| --- | --- |
| `public/data/saude-fontes.json` | Hosts mortos/instáveis do dia, estatísticas por categoria e lista de conteúdo inativo (todas as fontes mortas) com o ID do TMDB |
| `public/data/catalogo-status.json` | Contagens do catálogo (filmes, séries, episódios, canais, fichas) e data da verificação |
| `public/data/RESUMO-diario.md` | Resumo humano (vai para o sumário do job no GitHub) |

## Rodar manualmente

```bash
python3 scripts/atualizacao_diaria.py            # verificação completa
python3 scripts/atualizacao_diaria.py --amostra 0.3   # amostra de 30%
python3 scripts/atualizacao_diaria.py --sem-probe     # só catálogos/status
npm run atualizar-fontes                          # atalho
```

Sem dependências externas — só Python 3 padrão.

## Automação no GitHub

O workflow `.github/workflows/atualizacao-diaria.yml` roda com o cron
`0 8 * * *` (05:00 Brasília) e também pelo botão **Run workflow** na aba
**Actions**. Ele faz commit dos dados novos — e o app os pega direto do
GitHub raw, **sem precisar de redeploy**.

### Opcional: redeploy automático no Cloudflare Pages

Se quiser embutir os dados do dia no próprio deploy, configure nos
**Settings → Secrets and variables → Actions** do repositório:

| Secret | Para quê |
| --- | --- |
| `CLOUDFLARE_DEPLOY_HOOK` | URL do Deploy Hook do Pages (Dashboard → Pages → seu projeto → Settings → Deploy hooks). O workflow dispara `POST` nele. |
| `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` | Alternativa: o workflow roda `npm run build` e publica com `wrangler pages deploy`. |

Sem nenhum secret configurado, o fluxo continua funcionando: os dados novos
sempre chegam ao app pelo GitHub raw.

## Regras de saúde de fonte

- Uma fonte **OK** responde `200/206` com mídia de verdade (HTML disfarçado
  de 200 — bloqueios XUI/Cloudflare — conta como morta).
- Um **host morto** falhou em todos os testes do dia (mínimo 2) ou já estava
  morto no dia anterior sem ser reavaliado hoje. O app pula esses hosts e
  só volta a tentá-los se passarem na verificação de outro dia.
- **Conteúdo inativo** = título/canal cujas *todas* as fontes estão em hosts
  mortos. A lista fica no `saude-fontes.json` para diagnóstico.
