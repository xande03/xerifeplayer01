#!/usr/bin/env python3
"""
Atualização diária de fontes e IDs do Xerife Player.

O que faz:
  1. Baixa os catálogos públicos do Saimo (índice, fichas, destaques, letras
     de filmes/séries e canais).
  2. Testa uma amostra de fontes em paralelo (filmes, séries/bases e canais)
     com requisições leves (Range 0-1), medindo quais servidores estão vivos.
  3. Gera public/data/saude-fontes.json  → lista de hosts mortos/instáveis e
     IDs/títulos inativos (todas as fontes em hosts mortos). O app lê esse
     arquivo todo dia e tenta primeiro fontes saudáveis.
  4. Gera public/data/catalogo-status.json → contagens por arquivo e data da
     última atualização (diagnóstico rápido).

Uso:
  python3 scripts/atualizacao_diaria.py                # completo
  python3 scripts/atualizacao_diaria.py --sem-probe    # só catálogos e status
  python3 scripts/atualizacao_diaria.py --amostra 0.3  # amostra menor de testes

Variáveis de ambiente (opcionais):
  XERIFE_AMOSTRA_FILMES (padrão 60)   XERIFE_AMOSTRA_CANAIS (padrão 80)
  XERIFE_PROBE_TIMEOUT  (padrão 8 s)  XERIFE_WORKERS (padrão 16)

Só usa a biblioteca padrão do Python (sem dependências) para rodar direto no
GitHub Actions.
"""
import concurrent.futures
import datetime
import json
import os
import random
import re
import ssl
import sys
import unicodedata
import urllib.error
import urllib.request
from collections import defaultdict
from urllib.parse import urlparse

# ----------------------------------------------------------------------------
# Configuração
# ----------------------------------------------------------------------------
BASE_FILMES = "https://filmes-saimo.pages.dev/"
BASE_CANAIS = "https://canais-saimo.pages.dev/"

UA_BROWSER = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")
UA_VLC = "VLC/3.0.18 LibVLC/3.0.18"
REFERER_EMBED = "https://embedcanaisdetv.xyz/"

LETRAS = [chr(c) for c in range(ord("A"), ord("Z") + 1)]

AMOSTRA_FILMES = int(os.environ.get("XERIFE_AMOSTRA_FILMES", "60"))
AMOSTRA_CANAIS = int(os.environ.get("XERIFE_AMOSTRA_CANAIS", "80"))
PROBE_TIMEOUT = float(os.environ.get("XERIFE_PROBE_TIMEOUT", "8"))
WORKERS = int(os.environ.get("XERIFE_WORKERS", "16"))

LIMITE_INATIVOS = 3000  # por categoria no JSON (o total é sempre real)

_SSL_CTX = ssl.create_default_context()
_SSL_CTX.check_hostname = False
_SSL_CTX.verify_mode = ssl.CERT_NONE


def norm(txt: str) -> str:
    """Minúsculas, sem acentos, espaços colapsados."""
    s = unicodedata.normalize("NFD", str(txt or ""))
    s = "".join(c for c in s if not unicodedata.combining(c)).lower()
    return re.sub(r"\s+", " ", s).strip()


def sem_ano(txt: str) -> str:
    return re.sub(r"\s*\((?:19|20)\d{2}\)\s*$", "", str(txt or "")).strip()


def host_de(url: str) -> str:
    try:
        return (urlparse(url).hostname or "").lower()
    except Exception:
        return ""


# ----------------------------------------------------------------------------
# Download
# ----------------------------------------------------------------------------
def baixar(url: str, timeout: float = 40, tentativas: int = 2) -> str:
    ultimo_erro = None
    for _ in range(tentativas):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA_BROWSER})
            with urllib.request.urlopen(req, timeout=timeout, context=_SSL_CTX) as r:
                data = r.read()
            return data.decode("utf-8", errors="replace")
        except Exception as e:  # noqa: BLE001
            ultimo_erro = e
    print(f"  [aviso] falha ao baixar {url}: {ultimo_erro}")
    return ""


# ----------------------------------------------------------------------------
# Probes de stream
# ----------------------------------------------------------------------------
def probe(url: str, referer: str = "", agent: str = "", timeout: float = PROBE_TIMEOUT,
          base_modo: bool = False):
    """Retorna (status, ok, motivo). ok=True se respondeu mídia de verdade.
    No modo base (pasta de servidor legado), 404/403 provam servidor de pé."""
    h = host_de(url)
    if not agent:
        agent = UA_VLC if (re.match(r"^\d{1,3}(\.\d{1,3}){3}$", h) or
                           ":8080" in url or ":8000" in url) else UA_BROWSER
    if not referer and "embed" in h:
        referer = REFERER_EMBED
    headers = {"User-Agent": agent, "Accept": "*/*", "Range": "bytes=0-1"}
    if referer:
        headers["Referer"] = referer
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=_SSL_CTX) as r:
            status = r.status
            ctype = (r.headers.get("content-type") or "").lower()
            try:
                chunk = r.read(256)
            except Exception:  # noqa: BLE001
                chunk = b""
    except urllib.error.HTTPError as e:
        ok_base = base_modo and e.code in (301, 302, 403, 404)
        return e.code, ok_base, f"HTTP {e.code}"
    except Exception as e:  # noqa: BLE001
        return 0, False, type(e).__name__

    if status in (200, 206):
        if "text/html" in ctype:
            return status, False, "html fake-200"
        if chunk and chunk.lstrip()[:1] == b"<":
            return status, False, "html no corpo"
        return status, True, "ok"
    if base_modo and status in (301, 302, 403, 404):
        return status, True, "servidor de pé (sem arquivo na raiz)"
    return status, False, f"HTTP {status}"


def testar_lote(itens, workers=WORKERS):
    """itens: lista de dicts {url, referer?, agent?} → mesma lista com status/ok/motivo."""
    def um(item):
        try:
            st, ok, motivo = probe(item["url"], item.get("referer", ""),
                                   item.get("agent", ""), base_modo=item.get("base", False))
        except Exception as e:  # noqa: BLE001
            st, ok, motivo = 0, False, type(e).__name__
        item.update(status=st, ok=ok, motivo=motivo)
        return item
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as ex:
        return list(ex.map(um, itens))


# ----------------------------------------------------------------------------
# Parsers dos catálogos
# ----------------------------------------------------------------------------
def parse_indice(txt: str):
    """Linhas 'base: N http://...' → {N: url}"""
    bases = {}
    for linha in (txt or "").splitlines():
        if linha.startswith("base:"):
            partes = linha[5:].strip().split(None, 1)
            if len(partes) == 2 and partes[0].isdigit():
                bases[int(partes[0])] = partes[1].strip()
    return bases


def resolver_item(item: str, bases: dict):
    """'N:caminho' → url completa | 'http...' → própria | '' se inválido."""
    item = (item or "").strip()
    if not item or item == "error.txt":
        return ""
    m = re.match(r"^(\d+):(.+)$", item)
    if m:
        base = bases.get(int(m.group(1)), "")
        if not base or "desativado" in base:
            return ""
        caminho = m.group(2)
        return base + (caminho if "." in caminho else caminho + ".mp4")
    if item.startswith("http"):
        return item
    return ""


def parse_arquivo_letra(txt: str, bases: dict):
    """filmes-*.txt: 'Título\\tdub=url,url\\tleg=...' → [(título, [urls])]"""
    saida = []
    for linha in (txt or "").splitlines():
        if not linha.strip() or linha.startswith("#"):
            continue
        campos = linha.split("\t")
        titulo = campos[0].strip()
        if not titulo:
            continue
        urls = []
        for campo in campos[1:]:
            if "=" not in campo:
                continue
            for item in campo.split("=", 1)[1].split(","):
                u = resolver_item(item, bases)
                if u:
                    urls.append(u)
        saida.append((titulo, urls))
    return saida


def parse_series_letra(txt: str):
    """series-*.txt: 'Título\\tano\\tpedaco\\tepisódios' → [(título, n_episódios)]"""
    saida = []
    for linha in (txt or "").splitlines():
        if not linha.strip() or linha.startswith("#"):
            continue
        campos = linha.split("\t")
        if len(campos) < 4 or not campos[0].strip():
            continue
        saida.append((campos[0].strip(), int(campos[2] or 0), int(campos[3] or 0)))
    return saida


def parse_fragmento_serie(txt: str):
    """series-L-N.txt: blocos iniciados por '@Título' e linhas de episódio com
    fontes na 4ª coluna → [(título, [[urls do ep1], [urls do ep2], …])]"""
    series_frag, atual = [], None
    for linha in (txt or "").splitlines():
        if linha.startswith("@"):
            atual = (linha[1:].strip(), [])
            series_frag.append(atual)
            continue
        if atual is None or not linha.strip():
            continue
        campos = linha.split("\t")
        if len(campos) < 4:
            continue
        urls = [resolver_item(u, {}) for u in campos[3].split(",")]
        urls = [u for u in urls if u]
        if urls:
            atual[1].append(urls)
    return series_frag


def parse_canais(txt: str):
    """catalogo.txt: canal:/fonte:(/referer:/agente:) → [{nome, fontes:[{url,...}]}]"""
    canais, atual, fonte = [], None, None
    for linha in (txt or "").splitlines():
        linha = linha.strip()
        if linha.startswith("canal:"):
            atual = {"nome": linha[6:].strip(), "fontes": []}
            canais.append(atual)
            fonte = None
        elif linha.startswith("fonte:") and atual is not None:
            u = linha[6:].strip()
            if u and "error.txt" not in u:
                fonte = {"url": u}
                atual["fontes"].append(fonte)
        elif linha.startswith("referer:") and fonte is not None:
            fonte["referer"] = linha[8:].strip()
        elif linha.startswith("agente:") and fonte is not None:
            fonte["agente"] = linha[7:].strip()
    return canais


def parse_fichas(txt: str):
    """fichas.txt: 'f\\tTítulo (ano)\\tid\\tposter\\tgêneros' → {norm(sem ano): id}"""
    mapa = {}
    for linha in (txt or "").splitlines():
        campos = linha.split("\t")
        if len(campos) < 3 or campos[0].strip().lower() != "f":
            continue
        titulo, tid = campos[1].strip(), campos[2].strip()
        if titulo and tid:
            mapa.setdefault(norm(sem_ano(titulo)), tid)
    return mapa


# ----------------------------------------------------------------------------
# Principal
# ----------------------------------------------------------------------------
def main():
    repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    data_dir = os.path.join(repo, "public", "data")
    os.makedirs(data_dir, exist_ok=True)
    agora = datetime.datetime.now(datetime.timezone.utc)
    dia = agora.strftime("%d/%m/%Y")
    dia_iso = agora.strftime("%Y-%m-%d")
    seed = agora.strftime("%Y%m%d")

    sem_probe = "--sem-probe" in sys.argv
    try:
        escala = float(sys.argv[sys.argv.index("--amostra") + 1]) if "--amostra" in sys.argv else 1.0
    except (ValueError, IndexError):
        escala = 1.0

    print(f"=== Atualização diária de fontes — {dia} ===")
    print("[1/5] Baixando catálogos do Saimo…")

    arquivos = {}  # nome → (bytes, texto)

    def pegar(base, nome):
        txt = baixar(base + nome)
        arquivos[nome] = (len(txt.encode("utf-8")), txt)
        return txt

    indice = pegar(BASE_FILMES, "indice.txt")
    fichas = pegar(BASE_FILMES, "fichas.txt")
    destaques = pegar(BASE_FILMES, "destaques.txt")
    busca = pegar(BASE_FILMES, "busca.txt")
    catalogo_canais = pegar(BASE_CANAIS, "catalogo.txt")
    bases = parse_indice(indice)
    print(f"      bases no índice: {len(bases)} | fichas: {len(fichas.encode('utf-8'))} B")

    # Letras de filmes e séries (26 + 26; tolera 404)
    def baixar_letras(prefixo):
        def um(letra):
            return letra, baixar(BASE_FILMES + f"{prefixo}-{letra}.txt", timeout=30)
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as ex:
            return dict(ex.map(um, LETRAS))

    filmes_letras = {k: v for k, v in baixar_letras("filmes").items() if v}
    series_letras = {k: v for k, v in baixar_letras("series").items() if v}
    print(f"      letras de filmes com dados: {len(filmes_letras)} | séries: {len(series_letras)}")

    # Parsers
    filmes = []  # (título, [urls])
    for letra in sorted(filmes_letras):
        filmes.extend(parse_arquivo_letra(filmes_letras[letra], bases))
    series = []
    for letra in sorted(series_letras):
        series.extend((letra, t, p, e) for t, p, e in parse_series_letra(series_letras[letra]))
    canais = parse_canais(catalogo_canais)
    mapa_ids = parse_fichas(fichas)
    destaques_itens = sum(1 for l in destaques.splitlines() if l.startswith("f\t"))

    print(f"[2/5] Catálogos: {len(filmes)} filmes | {len(series)} séries | "
          f"{len(canais)} canais | {len(mapa_ids)} fichas")

    estat = {
        "filmes": {"testados": 0, "ok": 0},
        "series": {"testados": 0, "ok": 0},
        "canais": {"testados": 0, "ok": 0},
        "bases": {"total": len(bases), "testados": 0, "ok": 0},
    }
    stats_host = defaultdict(lambda: {"ok": 0, "falha": 0})
    rodada = {"hosts_mortos": {}, "hosts_instaveis": {}}

    if not sem_probe:
        rng = random.Random(seed)

        print("[3/5] Testando fontes (amostra diária)…")

        # --- filmes: amostra de títulos → até 2 fontes cada
        alvos_filmes = []
        filmes_amostra = (rng.sample(filmes, min(len(filmes), max(1, round(AMOSTRA_FILMES * escala))))
                          if filmes else [])
        for titulo, urls in filmes_amostra:
            escolhidas = urls[:1] + (urls[-1:] if len(urls) > 2 else [])
            for u in dict.fromkeys(escolhidas):
                alvos_filmes.append({"url": u, "titulo": titulo, "tipo": "filmes"})
        # --- canais: fontes distribuídas pelo catálogo inteiro
        fontes_canais = []
        for c in canais:
            for f in c["fontes"]:
                fontes_canais.append({"url": f["url"], "referer": f.get("referer", ""),
                                      "agent": f.get("agente", ""), "titulo": c["nome"],
                                      "tipo": "canais"})
        passo = (max(1, len(fontes_canais) // max(1, round(AMOSTRA_CANAIS * escala)))
                 if fontes_canais else 1)
        alvos_canais = fontes_canais[::passo][: max(1, round(AMOSTRA_CANAIS * escala))]
        # --- séries: amostra de episódios reais (fragmentos series-L-N.txt)
        serie_escolhas = [(l, t, p) for l, t, p, _ in series]
        amostra_series = (rng.sample(serie_escolhas, min(len(serie_escolhas),
                                                         max(1, round(12 * escala))))
                          if serie_escolhas else [])
        fragmentos = {}
        alvos_series = []
        for letra_s, titulo_s, pedaco_s in amostra_series:
            chave = f"{letra_s}-{pedaco_s}"
            if chave not in fragmentos:
                fragmentos[chave] = baixar(BASE_FILMES + f"series-{chave}.txt", timeout=30)
            blocos = parse_fragmento_serie(fragmentos[chave])
            bloco = next((b for b in blocos if norm(b[0]) == norm(titulo_s)),
                         blocos[0] if blocos else None)
            if not bloco:
                continue
            for episodio in bloco[1][:2]:  # até 2 episódios por série
                for u in episodio[:2]:      # até 2 fontes por episódio
                    alvos_series.append({"url": u, "titulo": titulo_s, "tipo": "series"})
        # --- bases (legado): 404 de pasta prova que o servidor está de pé
        alvos_bases = [{"url": u, "titulo": f"base[{i}]", "tipo": "bases", "base": True}
                       for i, u in sorted(bases.items()) if "desativado" not in u]

        for lote, cat in ((alvos_filmes, "filmes"), (alvos_canais, "canais"),
                          (alvos_series, "series"), (alvos_bases, "bases")):
            if not lote:
                continue
            resultados = testar_lote(lote)
            ok_n = 0
            for r in resultados:
                h = host_de(r["url"])
                if not h:
                    continue
                if r["ok"]:
                    stats_host[h]["ok"] += 1
                    ok_n += 1
                else:
                    stats_host[h]["falha"] += 1
            if cat not in estat:
                estat[cat] = {"testados": 0, "ok": 0}
            estat[cat]["testados"] += len(resultados)
            estat[cat]["ok"] += ok_n
            print(f"      {cat}: {ok_n}/{len(resultados)} fontes OK")

        # --- hosts mortos/instáveis nesta rodada
        for h, s in stats_host.items():
            tent = s["ok"] + s["falha"]
            if tent >= 2 and s["ok"] == 0:
                rodada["hosts_mortos"][h] = {"testes": tent, "falhas": s["falha"]}
            elif tent >= 3 and s["falha"] / tent >= 0.5:
                rodada["hosts_instaveis"][h] = {"testes": tent, "falhas": s["falha"]}

        print(f"      hosts mortos na rodada: {len(rodada['hosts_mortos'])} | "
              f"instáveis: {len(rodada['hosts_instaveis'])}")

    # --- mescla com a verificação anterior (host morto confirmado antes segue;
    #     host não testado hoje mantém o status até ser reavaliado)
    anterior_mortos = {}
    caminho_saude = os.path.join(data_dir, "saude-fontes.json")
    try:
        with open(caminho_saude, encoding="utf-8") as f:
            prev = json.load(f)
        for it in prev.get("hosts_mortos", []):
            if isinstance(it, dict):
                anterior_mortos[it.get("host", "")] = it.get("desde", dia_iso)
            elif isinstance(it, str):
                anterior_mortos[it] = dia_iso
    except Exception:  # noqa: BLE001
        pass

    hosts_mortos = {}
    for h, info in rodada["hosts_mortos"].items():
        hosts_mortos[h] = {"host": h, "desde": anterior_mortos.get(h, dia_iso), **info}
    for h, desde in anterior_mortos.items():
        if h not in hosts_mortos and h not in stats_host:
            hosts_mortos[h] = {"host": h, "desde": desde, "testes": 0, "falhas": 0}
    mortos_set = set(hosts_mortos)

    # --- conteúdo inativo: TODAS as fontes em hosts mortos
    print("[4/5] Levantando conteúdo inativo…")
    inativos_filmes = []
    for titulo, urls in filmes:
        hosts = {host_de(u) for u in urls} - {""}
        if hosts and hosts <= mortos_set:
            inativos_filmes.append({"id": mapa_ids.get(norm(sem_ano(titulo)), ""),
                                    "t": titulo})
    inativos_canais = []
    for c in canais:
        if not c["fontes"]:
            continue
        hosts = {host_de(f["url"]) for f in c["fontes"]} - {""}
        if hosts and hosts <= mortos_set:
            inativos_canais.append({"t": c["nome"]})

    total_inativos = len(inativos_filmes) + len(inativos_canais)
    print(f"      filmes inativos: {len(inativos_filmes)} | canais inativos: {len(inativos_canais)}")

    # --- grava JSONs
    saude = {
        "versao": 1,
        "app": "Xerife Player",
        "gerado_em": agora.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "gerado_em_br": dia,
        "estatisticas": estat,
        "hosts_mortos": sorted(hosts_mortos.values(), key=lambda x: -x.get("falhas", 0)),
        "hosts_instaveis": sorted(
            ({"host": h, **info} for h, info in rodada["hosts_instaveis"].items()),
            key=lambda x: -x.get("falhas", 0)),
        "conteudos_inativos": {
            "total": total_inativos,
            "filmes": inativos_filmes[:LIMITE_INATIVOS],
            "canais": inativos_canais[:LIMITE_INATIVOS],
        },
        "amostra": {
            "filmes": estat["filmes"]["testados"],
            "series": estat["series"]["testados"],
            "canais": estat["canais"]["testados"],
        },
    }
    with open(caminho_saude, "w", encoding="utf-8") as f:
        json.dump(saude, f, ensure_ascii=False, separators=(",", ":"))

    def info_arquivo(txt, itens=None):
        d = {"bytes": len(txt.encode("utf-8"))}
        if itens is not None:
            d["itens"] = itens
        return d

    status = {
        "app": "Xerife Player",
        "gerado_em": saude["gerado_em"],
        "gerado_em_br": dia,
        "totais": {
            "filmes": len(filmes),
            "series": len(series),
            "canais": len(canais),
            "episodios": sum(e for *_, e in series),
            "destaques": destaques_itens,
            "fichas_ids": len(mapa_ids),
            "inativos": total_inativos,
        },
        "arquivos": {
            "indice.txt": info_arquivo(indice, len(bases)),
            "fichas.txt": info_arquivo(fichas, len(mapa_ids)),
            "destaques.txt": info_arquivo(destaques, destaques_itens),
            "busca.txt": info_arquivo(busca),
            "catalogo.txt": info_arquivo(catalogo_canais,
                                         sum(len(c["fontes"]) for c in canais)),
            "filmes_letras": {"existentes": sorted(filmes_letras)},
            "series_letras": {"existentes": sorted(series_letras)},
        },
    }
    with open(os.path.join(data_dir, "catalogo-status.json"), "w", encoding="utf-8") as f:
        json.dump(status, f, ensure_ascii=False, separators=(",", ":"))

    # --- resumo humano (stdout + Markdown p/ GitHub Actions)
    linhas = [
        f"## Atualização diária de fontes — {dia}",
        "",
        "| Categoria | Testados | OK |",
        "|---|---|---|",
        f"| Filmes (fontes) | {estat['filmes']['testados']} | {estat['filmes']['ok']} |",
        f"| Séries (episódios) | {estat['series']['testados']} | {estat['series']['ok']} |",
        f"| Bases (legado) | {estat['bases'].get('testados', 0)} | {estat['bases'].get('ok', 0)} |",
        f"| Canais (fontes) | {estat['canais']['testados']} | {estat['canais']['ok']} |",
        "",
        f"- Catálogo: **{len(filmes)} filmes**, **{len(series)} séries** "
        f"({sum(e for *_, e in series)} episódios), **{len(canais)} canais**",
        f"- Hosts mortos: **{len(hosts_mortos)}** | instáveis: "
        f"**{len(rodada['hosts_instaveis'])}**",
        f"- Conteúdo inativo (todas as fontes mortas): **{total_inativos}** "
        f"({len(inativos_filmes)} filmes, {len(inativos_canais)} canais)",
        "",
    ]
    if hosts_mortos:
        linhas.append("### Hosts mortos")
        linhas.append("| Host | Testes | Falhas | Desde |")
        linhas.append("|---|---|---|---|")
        for h in saude["hosts_mortos"][:15]:
            linhas.append(f"| `{h['host']}` | {h.get('testes', 0)} | {h.get('falhas', 0)} "
                          f"| {h.get('desde', '-')} |")
        linhas.append("")
    resumo = "\n".join(linhas)
    with open(os.path.join(data_dir, "RESUMO-diario.md"), "w", encoding="utf-8") as f:
        f.write(resumo + "\n")

    print("[5/5] JSONs gravados em public/data/")
    print(resumo)
    return 0


if __name__ == "__main__":
    sys.exit(main())
