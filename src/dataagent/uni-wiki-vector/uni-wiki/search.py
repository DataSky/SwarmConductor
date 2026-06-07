#!/usr/bin/env python3
"""
uni-wiki BM25 检索脚本 v5.1
------------------------------------------------------
变更日志 v5.1（2026-06-03）：
  [新增] --gap-check：覆盖缺口自动检测
         输入章节名列表（逗号分隔字符串 或 JSON 文件），批量检索判断每个章节是否已有对应 wiki 页面
         输出：🟢 COVERED / 🟡 PARTIAL / 🔴 GAP 三档分类 + 最佳命中页面 + norm_score
         阈值：COVERED >= 0.55 / PARTIAL >= 0.30 / GAP < 0.30（可通过 --gap-threshold 调整）
         JSON 格式支持附加 keywords 字段提升检索准确率
  [新增] --gap-threshold：调整覆盖判定阈值（默认 0.30）

变更日志 v5.0（2026-06-03）：
  [移除] Hybrid 混合检索模块（Milvus Lite + ONNX 向量）：收益有限，代码简化
         检索引擎回归纯 BM25 + 别名扩展 + 字段加权，无外部依赖，启动更快
  [保留] 稳定性徽章（S1/S2/S3）、Checklist 第6项、稳定性元数据解析（v4.1 全部保留）

变更日志 v4.1（2026-06-03）：
  [新增] 稳定性徽章（Stability Badge）：检索结果自动附加 🟢S1 / 🟡S2 / 🔴S3 / ❌deprecated 徽章
  [新增] Checklist 第6项：结果中包含 S3/deprecated 页面时自动触发稳定性警告
  [新增] S2/S3 页面结果后自动附加 ⚠️ 警告行（fallback_to 降级建议、last_verified 日期）

变更日志 v4.0（2026-05-31）：
  [已移除] Hybrid 混合检索模块（见 v5.0 changelog）

变更日志 v3.0（2026-05-28）：
  [核心] 别名扩展 (Alias Expansion)：自动解析 术语别名大全.md，查询时将别名替换为标准术语 + 别名同时检索
         解决 BM25 无法处理同义词的天然缺陷（如 "短引" 自动扩展为 "短引 live头像 is_avator"）
  [核心] 字段加权 (Field Boosting)：解析 frontmatter 的 title/tags，分别计算 BM25 分数
         最终分数 = body_score + title_boost * TITLE_WEIGHT + tag_boost * TAG_WEIGHT
         标题命中权重 3x，标签命中权重 2x，显著提升精确率
  [核心] 索引智能失效：基于文件 mtime 最大值检测索引过期，不再仅靠页面数量判断
  [优化] 紧凑输出模式 (--compact)：只输出前 N 行内容摘要 + 匹配片段，减少 token 消耗
  [优化] 分数归一化：BM25 原始分数归一化到 [0,1]，便于跨查询对比和调试
  [优化] 去除停用词：常见中文停用词（的了是在）和英文停用词不参与计分

变更日志 v2.1（2026-05-27）：
  [新增] --pin-categories  分类保底机制
  [改进] format_output 标注 [PINNED] 标记

变更日志 v2.0（2026-05-27）：
  [新增] --queries  多查询词并行检索
  [新增] --checklist 检索充分性校验
  [新增] hit_by     每个召回页面标注被哪些查询命中
  [优化] ThreadPoolExecutor 并行打分

用法：
  # 基础用法（自动启用别名扩展 + 字段加权）
  python3 search.py --queries "直播 GMV CTR GPM SQL" "短引 曝光 点击" --top 5

  # 带 checklist + compact 输出（推荐，省 token）
  python3 search.py --queries "..." --checklist --compact

  # 显式锁定页面 + 分类保底
  python3 search.py --queries "..." --pin-pages "wiki/sql/短视频SQL.md" --pin-categories sql/ --checklist

  # 禁用别名扩展（调试用）
  python3 search.py --queries "..." --no-alias

  # 重建 BM25 索引（wiki 有新增/修改时执行）
  python3 search.py --rebuild

  # 查看别名字典（调试）
  python3 search.py --show-aliases
"""

import re, math, json, argparse, os, hashlib, time
from collections import Counter
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed

# ── 路径配置 ────────────────────────────────────────────────────────────────
BASE       = Path(__file__).parent
WIKI_DIR   = BASE / "wiki"
INDEX_FILE = BASE / ".bm25_index.json"
ALIAS_FILE = WIKI_DIR / "terms" / "术语别名大全.md"

# ── BM25 超参 ────────────────────────────────────────────────────────────────
K1            = 1.5
B             = 0.75
TOP_N_DEFAULT = 5
MIN_SCORE     = 0.01
MAX_WORKERS   = 4

# ── 字段加权 (Field Boosting) ─────────────────────────────────────────────────
TITLE_WEIGHT  = 3.0   # 标题命中的权重倍数
TAG_WEIGHT    = 2.0   # 标签命中的权重倍数
BODY_WEIGHT   = 1.0   # 正文基础权重

# ── compact 模式摘要行数 ──────────────────────────────────────────────────────
COMPACT_LINES = 30    # compact 模式下每页最多输出行数
SNIPPET_CONTEXT = 2   # 匹配片段上下文行数

# ── 停用词 ────────────────────────────────────────────────────────────────────
STOPWORDS_ZH = set("的了是在有和与或不也都被将把从到为以及但就着过让被能".split() + list("的了是在有和与或不也都"))
STOPWORDS_EN = {"the", "a", "an", "is", "are", "was", "were", "be", "been",
                "and", "or", "of", "to", "in", "for", "on", "at", "by", "from",
                "select", "where", "and", "as", "sum", "count", "group"}

# ── 模块级单例缓存（同进程内复用，避免重复 I/O 和连接开销）─────────────────
_PAGES_CACHE: dict | None = None   # load_pages() 结果缓存（同进程复用）
_IDX_CACHE:   dict | None = None   # load_index() 结果缓存


# ── 别名字典构建 ──────────────────────────────────────────────────────────────
def build_alias_dict() -> dict[str, list[str]]:
    """
    解析 术语别名大全.md 中的表格，构建双向别名映射。
    返回: {任一术语/别名 -> [标准术语, 别名1, 别名2, ...]}
    """
    if not ALIAS_FILE.exists():
        return {}

    content = ALIAS_FILE.read_text(encoding="utf-8")
    alias_map: dict[str, list[str]] = {}

    # 匹配 Markdown 表格行: | 标准术语 | 别名 | 说明 |
    for match in re.finditer(r'\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]*?)\s*\|', content):
        standard = match.group(1).strip()
        aliases_raw = match.group(2).strip()

        # 跳过表头行
        if standard in ("标准术语", "---", "------"):
            continue
        if "---" in standard:
            continue

        # 解析别名（逗号/顿号分隔）
        aliases = [a.strip() for a in re.split(r'[,，、/]', aliases_raw) if a.strip()]
        all_terms = [standard] + aliases

        # 双向映射：任意一个词都能找到所有相关词
        for term in all_terms:
            term_lower = term.lower()
            if term_lower not in alias_map:
                alias_map[term_lower] = []
            for t in all_terms:
                if t.lower() != term_lower and t.lower() not in alias_map[term_lower]:
                    alias_map[term_lower].append(t.lower())

    return alias_map


def expand_query_with_aliases(query: str, alias_map: dict[str, list[str]]) -> str:
    """
    用别名字典扩展查询：如果查询中包含已知术语/别名，追加其同义词。
    策略：最多追加 3 个别名（避免查询过长稀释 BM25 分数）。
    """
    if not alias_map:
        return query

    query_lower = query.lower()
    expansions = []

    # 尝试匹配别名字典中的键（按长度降序，优先匹配长词）
    sorted_terms = sorted(alias_map.keys(), key=len, reverse=True)
    matched_terms = set()

    for term in sorted_terms:
        if term in query_lower and term not in matched_terms:
            # 找到匹配，追加别名（最多 3 个）
            related = alias_map[term][:3]
            expansions.extend(related)
            matched_terms.add(term)
            # 标记别名也不再重复匹配
            for r in related:
                matched_terms.add(r)

    if expansions:
        return query + " " + " ".join(expansions)
    return query


# ── 中英文分词（v3 增强：停用词过滤）────────────────────────────────────────
def tokenize(text: str, remove_stopwords: bool = True) -> list[str]:
    """
    中文：unigram + bigram（提高短语命中率）
    英文/数字/下划线：整体 token（保留字段名如 is_avator）
    v3: 可选停用词过滤
    """
    tokens = []
    for seg in re.findall(r'[\u4e00-\u9fff]+|[a-zA-Z0-9_\.]+', text.lower()):
        if re.match(r'[\u4e00-\u9fff]', seg):
            chars = list(seg)
            bigrams = [seg[i:i+2] for i in range(len(seg) - 1)]
            if remove_stopwords:
                chars = [c for c in chars if c not in STOPWORDS_ZH]
                bigrams = [b for b in bigrams if not all(c in STOPWORDS_ZH for c in b)]
            tokens.extend(chars)
            tokens.extend(bigrams)
        else:
            if remove_stopwords and seg in STOPWORDS_EN:
                continue
            tokens.append(seg)
    return tokens


# ── Frontmatter 解析 ──────────────────────────────────────────────────────────
def parse_frontmatter(content: str) -> tuple[str, str, list[str]]:
    """
    解析 YAML frontmatter，提取 title 和 tags。
    返回: (title, body_without_frontmatter, tags)
    """
    title = ""
    tags = []
    body = content

    fm_match = re.match(r'^---\s*\n(.*?)\n---\s*\n', content, re.DOTALL)
    if fm_match:
        fm_text = fm_match.group(1)
        body = content[fm_match.end():]

        # 提取 title
        title_match = re.search(r'^title:\s*(.+)$', fm_text, re.MULTILINE)
        if title_match:
            title = title_match.group(1).strip()

        # 提取 tags
        tags_match = re.search(r'^tags:\s*\[([^\]]*)\]', fm_text, re.MULTILINE)
        if tags_match:
            tags = [t.strip().strip("'\"") for t in tags_match.group(1).split(",") if t.strip()]

    return title, body, tags


# ── 稳定性元数据解析（v4.1 新增）─────────────────────────────────────────────
def _parse_stability_meta(content: str) -> dict:
    """
    从 frontmatter 中提取稳定性相关字段：
      stability   : S1 / S2 / S3 / 空
      dw_status   : confirmed / pending / volatile / deprecated / 空
      last_verified: YYYY-MM-DD / 空
      fallback_to : 降级路径 / 空
    """
    meta = {"stability": "", "dw_status": "", "last_verified": "", "fallback_to": ""}
    fm_match = re.match(r'^---\s*\n(.*?)\n---\s*\n', content, re.DOTALL)
    if not fm_match:
        return meta
    fm_text = fm_match.group(1)
    for key in meta:
        m = re.search(rf'^{key}:\s*(.+)$', fm_text, re.MULTILINE)
        if m:
            val = m.group(1).strip().strip('"\'')
            if val.lower() != "null":
                meta[key] = val
    return meta


# ── 稳定性徽章映射（v4.1 新增）────────────────────────────────────────────────
_STABILITY_BADGE = {
    "S1": "🟢 S1-Stable",
    "S2": "🟡 S2-Semi-stable",
    "S3": "🔴 S3-Volatile",
}
_STATUS_BADGE = {
    "confirmed":  "",
    "pending":    " [待入仓]",
    "volatile":   " [探索中]",
    "deprecated": " ❌deprecated",
}

def _stability_badge(stability: str, dw_status: str) -> str:
    """返回格式化的稳定性徽章字符串，用于结果标题行附加显示。"""
    badge = _STABILITY_BADGE.get(stability.upper() if stability else "", "")
    if not badge:
        return ""
    status_suffix = _STATUS_BADGE.get(dw_status.lower() if dw_status else "", "")
    return f"  [{badge}{status_suffix}]"


# ── 页面加载（v3: 分离 title/tags/body）────────────────────────────────────
def load_pages() -> dict[str, dict]:
    """
    遍历 wiki/ 目录，读取所有 .md 文件。
    返回: {相对路径: {"content": 全文, "title": str, "body": str, "tags": list}}
    同进程内结果缓存，避免重复读取 1220 个文件（~4s → ~0ms）。
    """
    global _PAGES_CACHE
    if _PAGES_CACHE is not None:
        return _PAGES_CACHE  # 命中缓存
    pages = {}
    for path in sorted(WIKI_DIR.rglob("*.md")):
        rel = str(path.relative_to(BASE))
        content = path.read_text(encoding="utf-8")
        title, body, tags = parse_frontmatter(content)
        pages[rel] = {
            "content":       content,
            "title":         title,
            "body":          body,
            "tags":          tags,
            "mtime":         os.path.getmtime(path),
            **_parse_stability_meta(content),   # v4.1: 稳定性元数据
        }
    _PAGES_CACHE = pages  # 写入模块缓存
    return pages


# ── 索引构建 / 加载（v3: 三字段索引 + mtime 校验）─────────────────────────
def build_index(pages: dict[str, dict]) -> dict:
    """构建三字段 BM25 索引：body / title / tags，持久化到文件"""
    # Body 索引
    body_tokens = {p: tokenize(info["body"]) for p, info in pages.items()}
    N = len(body_tokens)
    body_dl = {p: len(t) for p, t in body_tokens.items()}
    body_avg_dl = sum(body_dl.values()) / N if N else 1

    body_df: Counter = Counter()
    for tokens in body_tokens.values():
        for t in set(tokens):
            body_df[t] += 1

    body_idf = {
        t: math.log((N - f + 0.5) / (f + 0.5) + 1)
        for t, f in body_df.items()
    }
    body_tf = {p: dict(Counter(toks)) for p, toks in body_tokens.items()}

    # Title 索引（短文本，不做 bigram 以保持精度）
    title_tokens = {}
    for p, info in pages.items():
        toks = tokenize(info["title"] + " " + info["title"], remove_stopwords=False)  # title 重复以强化
        title_tokens[p] = toks

    title_dl = {p: max(len(t), 1) for p, t in title_tokens.items()}
    title_avg_dl = sum(title_dl.values()) / N if N else 1
    title_df: Counter = Counter()
    for tokens in title_tokens.values():
        for t in set(tokens):
            title_df[t] += 1
    title_idf = {t: math.log((N - f + 0.5) / (f + 0.5) + 1) for t, f in title_df.items()}
    title_tf = {p: dict(Counter(toks)) for p, toks in title_tokens.items()}

    # Tags 索引
    tag_tokens = {}
    for p, info in pages.items():
        tag_text = " ".join(info["tags"])
        tag_tokens[p] = tokenize(tag_text, remove_stopwords=False)

    tag_dl = {p: max(len(t), 1) for p, t in tag_tokens.items()}
    tag_avg_dl = sum(tag_dl.values()) / N if N else 1
    tag_df: Counter = Counter()
    for tokens in tag_tokens.values():
        for t in set(tokens):
            tag_df[t] += 1
    tag_idf = {t: math.log((N - f + 0.5) / (f + 0.5) + 1) for t, f in tag_df.items()}
    tag_tf = {p: dict(Counter(toks)) for p, toks in tag_tokens.items()}

    # Mtime 指纹
    max_mtime = max(info["mtime"] for info in pages.values()) if pages else 0

    idx = {
        "N": N,
        "max_mtime": max_mtime,
        "body":  {"avg_dl": body_avg_dl,  "idf": body_idf,  "tf": body_tf,  "dl": body_dl},
        "title": {"avg_dl": title_avg_dl, "idf": title_idf, "tf": title_tf, "dl": title_dl},
        "tags":  {"avg_dl": tag_avg_dl,   "idf": tag_idf,   "tf": tag_tf,   "dl": tag_dl},
    }
    INDEX_FILE.write_text(json.dumps(idx, ensure_ascii=False), encoding="utf-8")
    global _PAGES_CACHE; _PAGES_CACHE = None  # rebuild 后使 pages 缓存失效
    global _IDX_CACHE; _IDX_CACHE = None  # rebuild 后使 idx 缓存失效
    return idx


def load_index(pages: dict[str, dict]) -> dict:
    """加载缓存索引；页面数变化或文件更新时自动重建。同进程缓存避免重复读取 7.7MB JSON。"""
    global _IDX_CACHE
    if _IDX_CACHE is not None:
        return _IDX_CACHE  # 命中缓存
    max_mtime = max(info["mtime"] for info in pages.values()) if pages else 0

    if INDEX_FILE.exists():
        try:
            idx = json.loads(INDEX_FILE.read_text(encoding="utf-8"))
            # v3: 双重校验 — 页面数 + 最新修改时间
            if idx.get("N") == len(pages) and abs(idx.get("max_mtime", 0) - max_mtime) < 1.0:
                _IDX_CACHE = idx  # 写入模块缓存，避免重复读取 7.7MB JSON
                return idx
        except (json.JSONDecodeError, KeyError):
            pass
    return build_index(pages)


# ── BM25 打分（通用字段打分函数）──────────────────────────────────────────
def bm25_field_score(query_tokens: list[str], doc_path: str, field: dict) -> float:
    """对单个字段（body/title/tags）计算 BM25 分数"""
    tf     = field["tf"].get(doc_path, {})
    dl     = field["dl"].get(doc_path, 1)
    avg_dl = field["avg_dl"]
    idf    = field["idf"]
    score  = 0.0
    for t in set(query_tokens):
        if t not in idf:
            continue
        f = tf.get(t, 0)
        if f == 0:
            continue
        score += idf[t] * (f * (K1 + 1)) / (f + K1 * (1 - B + B * dl / avg_dl))
    return score


def bm25_combined_score(query_tokens: list[str], doc_path: str, idx: dict) -> float:
    """
    三字段加权融合分数：
    final = BODY_WEIGHT * body_score + TITLE_WEIGHT * title_score + TAG_WEIGHT * tag_score
    """
    body_score  = bm25_field_score(query_tokens, doc_path, idx["body"])
    title_score = bm25_field_score(query_tokens, doc_path, idx["title"])
    tag_score   = bm25_field_score(query_tokens, doc_path, idx["tags"])

    return (BODY_WEIGHT * body_score +
            TITLE_WEIGHT * title_score +
            TAG_WEIGHT * tag_score)


# ── 多查询并行检索（v3: 集成别名扩展 + 字段加权）──────────────────────────
def search_multi(queries: list[str], top_n: int = TOP_N_DEFAULT,
                 use_alias: bool = True) -> tuple[list[dict], dict[str, float], dict[str, dict]]:
    """
    多查询并行检索，v3 增强：
      - 别名自动扩展
      - 三字段加权评分
      - 分数归一化（max normalization）
    """
    pages = load_pages()
    if not pages:
        return [], {}, {}
    idx = load_index(pages)

    # 别名扩展
    alias_map = build_alias_dict() if use_alias else {}
    expanded_queries = []
    for q in queries:
        eq = expand_query_with_aliases(q, alias_map) if use_alias else q
        expanded_queries.append(eq)

    # 并行打分
    def score_one(query: str) -> tuple[str, dict[str, float]]:
        q_tok = tokenize(query)
        return query, {p: bm25_combined_score(q_tok, p, idx) for p in pages}

    all_max: dict[str, float] = {}
    hit_by: dict[str, list[str]] = {}

    with ThreadPoolExecutor(max_workers=min(len(expanded_queries), MAX_WORKERS)) as ex:
        futures = {ex.submit(score_one, q): (q, orig)
                   for q, orig in zip(expanded_queries, queries)}
        for fut in as_completed(futures):
            query, scores = fut.result()
            _, orig_query = futures[fut]
            for page, score in scores.items():
                if score >= MIN_SCORE:
                    hit_by.setdefault(page, []).append(orig_query)
                if score > all_max.get(page, 0.0):
                    all_max[page] = score

    # 分数归一化（max normalization）
    max_score = max(all_max.values()) if all_max else 1.0
    if max_score > 0:
        normalized = {p: s / max_score for p, s in all_max.items()}
    else:
        normalized = all_max

    # 排序截取
    sorted_pages = sorted(all_max.items(), key=lambda x: -x[1])
    results = []
    for p, s in sorted_pages[:top_n]:
        if s < MIN_SCORE:
            break
        results.append({
            "path":       p,
            "score":      round(s, 3),
            "norm_score": round(normalized.get(p, 0), 3),
            "content":    pages[p]["content"],
            "title":      pages[p]["title"],
            "hit_by":     list(set(hit_by.get(p, []))),
            "pinned":     False,
            # v4.1: 稳定性元数据直通
            "stability":     pages[p].get("stability", ""),
            "dw_status":     pages[p].get("dw_status", ""),
            "last_verified": pages[p].get("last_verified", ""),
            "fallback_to":   pages[p].get("fallback_to", ""),
        })

    return results, all_max, pages


# ── 单查询检索（向后兼容）────────────────────────────────────────────────────
def search(query: str, top_n: int = TOP_N_DEFAULT, use_alias: bool = True) -> list[dict]:
    """单查询检索（v3 兼容入口）"""
    results, _, _ = search_multi([query], top_n=top_n, use_alias=use_alias)
    return results


# ── Pin 机制（复用 v2.1）─────────────────────────────────────────────────────
def apply_pin_pages(results, pages, all_scores, pin_paths):
    if not pin_paths:
        return results
    result_paths = {r["path"] for r in results}
    for pp in pin_paths:
        if pp in result_paths:
            continue
        if pp in pages:
            results.append({
                "path":       pp,
                "score":      round(all_scores.get(pp, 0.0), 3),
                "norm_score": 0.0,
                "content":    pages[pp]["content"],
                "title":      pages[pp].get("title", ""),
                "hit_by":     [],
                "pinned":     True,
                # v4.1: 稳定性元数据直通
                "stability":     pages[pp].get("stability", ""),
                "dw_status":     pages[pp].get("dw_status", ""),
                "last_verified": pages[pp].get("last_verified", ""),
                "fallback_to":   pages[pp].get("fallback_to", ""),
            })
            result_paths.add(pp)
    return results


def apply_pin_categories(results, pages, all_scores, categories, pin_min=1):
    if not categories:
        return results
    result_paths = {r["path"] for r in results}
    for cat in categories:
        full_cat = cat if cat.startswith("wiki/") else f"wiki/{cat}"
        in_result_count = sum(1 for r in results if r["path"].startswith(full_cat))
        if in_result_count >= pin_min:
            continue
        cat_candidates = [
            (p, s) for p, s in all_scores.items()
            if p.startswith(full_cat) and p not in result_paths and s >= MIN_SCORE
        ]
        cat_candidates.sort(key=lambda x: -x[1])
        need = pin_min - in_result_count
        for p, s in cat_candidates[:need]:
            results.append({
                "path":       p,
                "score":      round(s, 3),
                "norm_score": 0.0,
                "content":    pages[p]["content"],
                "title":      pages[p].get("title", ""),
                "hit_by":     [],
                "pinned":     True,
                # v4.1: 稳定性元数据直通
                "stability":     pages[p].get("stability", ""),
                "dw_status":     pages[p].get("dw_status", ""),
                "last_verified": pages[p].get("last_verified", ""),
                "fallback_to":   pages[p].get("fallback_to", ""),
            })
            result_paths.add(p)
    return results


# ── Checklist（v4.1: 新增第6项稳定性检验）────────────────────────────────────
CHECKLIST_ITEMS = [
    {"key": "table_name", "desc": "Hive 表名已出现（ks_plateco_core / dws_eco 系列）",
     "patterns": [r"ks_plateco_core", r"dws_eco_con", r"dws_eco_trd", r"ks_plateco\."]},
    {"key": "filter_field", "desc": "关键过滤字段已出现（is_avator / is_field / field_business_type）",
     "patterns": [r"is_avator", r"is_field", r"field_business_type", r"is_local_order"]},
    {"key": "sql_block", "desc": "至少存在一个 SQL 代码块（```sql）",
     "patterns": [r"```sql"]},
    {"key": "gmv_unit", "desc": "GMV 单位说明已出现（分/元换算）",
     "patterns": [r"单位[^\n]*分", r"/\s*100", r"unrisk_pay_order_amt"]},
    {"key": "carrier_split", "desc": "载体区分逻辑已出现（直播/短视频/短引识别方式）",
     "patterns": [r"简易直播间", r"is_avator\s*=\s*[01]", r"field_business_type.*直播间"]},
    # v4.1 新增：稳定性检验（使用 custom_check 标记，由 run_checklist 特殊处理）
    {"key": "stability_safe", "desc": "结果中不含 S3/deprecated 页面（生产可用）",
     "patterns": [], "custom_check": "no_s3"},
]


def run_checklist(results: list[dict]) -> list[dict]:
    combined = "\n".join(r["content"] for r in results)
    out = []
    for item in CHECKLIST_ITEMS:
        # v4.1: 自定义检验逻辑
        if item.get("custom_check") == "no_s3":
            # 检查：所有结果是否都不含 S3 或 deprecated
            has_s3 = any(
                r.get("stability", "").upper() == "S3" or
                r.get("dw_status", "").lower() in ("volatile", "deprecated")
                for r in results
            )
            out.append({"key": item["key"], "desc": item["desc"], "ok": not has_s3,
                        "warn_msg": _build_s3_warn(results) if has_s3 else ""})
        else:
            ok = any(re.search(p, combined, re.IGNORECASE) for p in item["patterns"])
            out.append({"key": item["key"], "desc": item["desc"], "ok": ok, "warn_msg": ""})
    return out


def _build_s3_warn(results: list[dict]) -> str:
    """构建 S3/deprecated 页面的警告消息列表"""
    warns = []
    for r in results:
        stab = r.get("stability", "").upper()
        status = r.get("dw_status", "").lower()
        if stab == "S3" or status in ("volatile", "deprecated"):
            badge = _stability_badge(stab, status)
            fallback = r.get("fallback_to", "")
            fb_hint = f" → fallback: {fallback}" if fallback else ""
            warns.append(f"    ⚠️  {r.get('title', r['path'])}{badge}{fb_hint}")
    return "\n".join(warns)


# ── 紧凑摘要生成 (v3 新增) ────────────────────────────────────────────────────
def compact_content(content: str, query_tokens: list[str], max_lines: int = COMPACT_LINES) -> str:
    """
    生成紧凑摘要：
    1. 优先输出标题 + 口径行
    2. 输出匹配 query token 的上下文片段
    3. 总行数不超过 max_lines
    """
    lines = content.split("\n")
    output_lines = []
    used_indices = set()

    # Phase 1: 抓取标题行和 SQL 起始行
    for i, line in enumerate(lines):
        if (line.startswith("#") or line.startswith("**口径**") or
            line.startswith("> ") or "```sql" in line):
            start = max(0, i)
            end = min(len(lines), i + 3)
            for j in range(start, end):
                if j not in used_indices:
                    output_lines.append((j, lines[j]))
                    used_indices.add(j)

    # Phase 2: 抓取包含 query token 的行（带上下文）
    if query_tokens:
        pattern = "|".join(re.escape(t) for t in query_tokens if len(t) > 1)
        if pattern:
            for i, line in enumerate(lines):
                if i in used_indices:
                    continue
                if re.search(pattern, line, re.IGNORECASE):
                    start = max(0, i - SNIPPET_CONTEXT)
                    end = min(len(lines), i + SNIPPET_CONTEXT + 1)
                    for j in range(start, end):
                        if j not in used_indices:
                            output_lines.append((j, lines[j]))
                            used_indices.add(j)

    # 按行号排序，截取
    output_lines.sort(key=lambda x: x[0])
    if len(output_lines) > max_lines:
        output_lines = output_lines[:max_lines]
        output_lines.append((-1, f"... (共 {len(lines)} 行，已截取前 {max_lines} 行关键内容)"))

    return "\n".join(line for _, line in output_lines)


# ── 格式化输出（v5: 纯 BM25 + 稳定性徽章）───────────────────────────────────
def format_output(results: list[dict],
                  list_only: bool = False,
                  show_checklist: bool = False,
                  compact: bool = False,
                  queries: list[str] = None,
                  expanded_info: str = "") -> str:
    if not results:
        return "[uni-wiki] 未找到相关页面，建议查看 index.md 后手动定位。\n"

    parts = []

    # 头部
    q_info = f"  queries={queries}" if queries and len(queries) > 1 else ""
    parts.append(f"[uni-wiki BM25 v5.0] 召回 {len(results)} 个页面{q_info}")
    if expanded_info:
        parts.append(f"  别名扩展: {expanded_info}")
    parts.append("")

    # Checklist
    if show_checklist:
        checklist = run_checklist(results)
        # v4.1: 前5项必须全OK才算充分；第6项稳定性为独立警告
        core_items = [c for c in checklist if c["key"] != "stability_safe"]
        stab_item  = next((c for c in checklist if c["key"] == "stability_safe"), None)
        all_ok = all(c["ok"] for c in core_items)
        parts.append("── Checklist ──────────────────────────────────────────")
        for c in checklist:
            if c["key"] == "stability_safe":
                mark = "OK" if c["ok"] else "WARN"
                parts.append(f"  [{mark}] {c['desc']}")
                if not c["ok"] and c.get("warn_msg"):
                    parts.append(c["warn_msg"])
            else:
                mark = "OK" if c["ok"] else "MISS"
                parts.append(f"  [{mark}] {c['desc']}")
        verdict = "-> 充分，可直接生成 SQL" if all_ok else "-> 有缺口，SQL 中加注释标注"
        if stab_item and not stab_item["ok"]:
            verdict += "  ⚠️ 含不稳定口径，生产使用前请确认"
        parts.append(f"  {verdict}")
        parts.append("")

    # 页面内容
    all_query_tokens = []
    if queries:
        for q in queries:
            all_query_tokens.extend(tokenize(q, remove_stopwords=True))

    for i, r in enumerate(results, 1):
        hit_info    = f"  hit_by={r['hit_by']}" if r.get("hit_by") else ""
        pin_mark    = "  [PINNED]"              if r.get("pinned") else ""
        title_info  = f"  《{r['title']}》"    if r.get("title")  else ""
        # v4.1: 稳定性徽章
        stab_badge  = _stability_badge(r.get("stability", ""), r.get("dw_status", ""))
        parts.append("=" * 60)
        parts.append(
            f"[{i}] {r['path']}  (score={r['score']}, norm={r.get('norm_score', '-')})"
            f"{title_info}{stab_badge}{hit_info}{pin_mark}"
        )
        parts.append("=" * 60)
        # v4.1: S2/S3 页面在内容前插入警告行
        stab = r.get("stability", "").upper()
        dw   = r.get("dw_status", "").lower()
        if stab in ("S2", "S3") or dw in ("volatile", "deprecated"):
            last_v   = r.get("last_verified", "未知")
            fallback = r.get("fallback_to", "")
            fb_line  = f" → 降级方案: {fallback}" if fallback else ""
            if dw == "deprecated":
                parts.append(f"❌ [DEPRECATED] 此口径已下线，禁止用于生产！最后验证: {last_v}{fb_line}")
            elif stab == "S3":
                parts.append(f"🔴 [S3-Volatile] DA探索性口径，未正式入仓，最后验证: {last_v}{fb_line}")
            else:  # S2
                parts.append(f"🟡 [S2-Semi-stable] 算法/业务产出口径，字段可能随模型迭代变化，最后验证: {last_v}{fb_line}")
        if not list_only:
            if compact:
                parts.append(compact_content(r["content"], all_query_tokens))
            else:
                parts.append(r["content"])
        parts.append("")

    return "\n".join(parts)


# ── Gap Check：覆盖缺口自动检测（v5.1 新增）────────────────────────────────────
# 绝对分数经验阈值（raw BM25 combined score，非 norm）：
#   强相关命中（章节有直接对应 wiki 页面）：通常 100~300+
#   弱相关命中（部分词命中，但不是目标）：  通常 40~100
#   无关命中（语义完全不匹配）：            通常 < 40
GAP_COVERED_THRESHOLD = 100  # raw score >= 100 → 候选 COVERED（还需标题重叠确认）
GAP_PARTIAL_THRESHOLD = 40   # raw score >= 40  → PARTIAL（疑似有关，需人工确认）
                              # raw score < 40   → GAP（无对应页面）
GAP_TITLE_OVERLAP_MIN = 2    # 标题 bigram 重叠数 >= 2 才能最终确认 COVERED，否则降为 PARTIAL


def _gap_title_overlap(query: str, title: str) -> int:
    """计算查询词和页面标题之间的中文 bigram 重叠数，用于二次确认覆盖可信度。"""
    def bigrams(s: str) -> set:
        s = re.sub(r'[^\u4e00-\u9fff]', '', s)  # 仅保留中文
        return {s[i:i+2] for i in range(len(s) - 1)} if len(s) >= 2 else set()
    return len(bigrams(query) & bigrams(title))

def run_gap_check(sections: list[dict],
                  threshold: float = None,    # 若传入则覆盖 GAP_COVERED_THRESHOLD
                  use_alias: bool = True) -> str:
    """
    对一批章节进行缺口检测：
      每个章节调用 BM25 检索，用绝对分数（raw score）判定覆盖情况
        raw score >= 60（COVERED_THRESHOLD）→ 🟢 COVERED（已有对应页面）
        raw score >= 20（PARTIAL_THRESHOLD）→ 🟡 PARTIAL（疑似有关，需人工确认）
        raw score <  20                     → 🔴 GAP（无对应页面，需新建）

    ⚠️ 为何用绝对分数而非 norm_score：
      top_n=1 时 norm_score 永远是 1.0（只有1个结果，自除自己），无区分意义。
      绝对 raw score 反映查询词在 wiki 中的实际命中强度，可跨章节比较。

    sections 格式（list of dict）：
      [
        {"id": "§1.1", "name": "主播属性-物理视角", "keywords": "主播属性 粉段 营收分层"},
        {"id": "§1.5", "name": "直播间维度",       "keywords": "直播间 秀场 行业类型"},
        ...
      ]
      - "id"      : 章节编号（显示用，可选）
      - "name"    : 章节名称（必须）
      - "keywords": 额外补充关键词，提升检索准确率（可选）

    threshold：
      若传入，覆盖默认的 GAP_COVERED_THRESHOLD（60）
    """
    import time
    covered_thr = threshold if threshold is not None else GAP_COVERED_THRESHOLD
    covered, partial, gap = [], [], []
    details = []

    total = len(sections)
    for idx, sec in enumerate(sections, 1):
        sec_id   = sec.get("id", "")
        sec_name = sec.get("name", "")
        keywords = sec.get("keywords", "")

        # 构建查询：章节名 + 补充关键词
        query = f"{sec_name} {keywords}".strip()
        results, _, _ = search_multi([query], top_n=1, use_alias=use_alias)

        if results:
            top   = results[0]
            score = top.get("score", 0.0)      # ← 使用绝对 raw score（非 norm）
            path  = top["path"]
            title = top.get("title", path.split("/")[-1].replace(".md", ""))
        else:
            score, path, title = 0.0, "—", "—"

        # 分类（基于绝对分数 + 标题 bigram 重叠二次确认）
        overlap = _gap_title_overlap(query, title)
        if score >= covered_thr and overlap >= GAP_TITLE_OVERLAP_MIN:
            status = "🟢 COVERED"
            covered.append(sec_name)
        elif score >= GAP_PARTIAL_THRESHOLD:
            # score 够高但标题重叠不足，或 score 中等 → 需人工确认
            status = "🟡 PARTIAL"
            partial.append(sec_name)
        else:
            status = "🔴 GAP   "
            gap.append(sec_name)

        details.append({
            "idx": idx, "id": sec_id, "name": sec_name,
            "status": status, "score": round(score, 1),
            "overlap": overlap,
            "top_page": title, "top_path": path,
        })

    # ── 格式化输出 ──
    lines = [
        "── Gap Check 结果 ──────────────────────────────────────────",
        f"  判定规则：score≥{covered_thr} AND 标题重叠≥{GAP_TITLE_OVERLAP_MIN} → 🟢COVERED ｜ score≥{GAP_PARTIAL_THRESHOLD} → 🟡PARTIAL ｜ 其余 → 🔴GAP",
        f"  共检测 {total} 个章节：🟢 已覆盖 {len(covered)} ｜ 🟡 疑似 {len(partial)} ｜ 🔴 缺口 {len(gap)}",
        "",
        f"  {'编号':<8} {'状态':<12} {'分数':<7} {'重叠':<4} {'章节名':<28} 最佳命中",
        f"  {'─'*8} {'─'*12} {'─'*7} {'─'*4} {'─'*28} {'─'*30}",
    ]

    for d in details:
        sec_id_str = f"[{d['id']}]" if d["id"] else f"[{d['idx']:02d}]"
        overlap_str = f"★{d['overlap']}"
        lines.append(
            f"  {sec_id_str:<8} {d['status']:<12} {d['score']:<7} "
            f"{overlap_str:<4} {d['name'][:27]:<28} {d['top_page'][:40]}"
        )

    lines.append("")

    # 缺口清单
    if gap:
        lines.append(f"🔴 GAP 列表（{len(gap)} 个，建议新建 wiki 页面）：")
        for name in gap:
            lines.append(f"   - {name}")
        lines.append("")

    if partial:
        lines.append(f"🟡 PARTIAL 列表（{len(partial)} 个，建议人工确认是否已充分覆盖）：")
        for name in partial:
            lines.append(f"   - {name}")
        lines.append("")

    lines.append(
        f"✅ 操作建议：GAP 章节新建页面 → python3 search.py --rebuild 更新索引 → 重跑 --gap-check 验证"
    )

    return "\n".join(lines)


# ── Gap Check 输入解析（支持 JSON 文件 / 逗号分隔字符串）────────────────────
def _parse_gap_check_input(raw: str) -> list[dict]:
    """
    解析 --gap-check 参数：
      - 若以 .json 结尾 → 从文件读取 JSON 数组
      - 否则 → 按「;」或「,」分隔，每项作为章节名

    示例（逗号分隔，快速使用）：
      --gap-check "主播属性,直播间维度,营收过程指标,LTV关注关系"

    示例（JSON 文件，推荐，可附关键词）：
      --gap-check /tmp/sections.json
      JSON 格式: [{"id":"§1.1","name":"主播属性","keywords":"粉段 营收"}, ...]
    """
    raw = raw.strip()

    # JSON 文件
    if raw.endswith(".json"):
        import json as _json
        with open(raw, encoding="utf-8") as f:
            data = _json.load(f)
        if isinstance(data, list):
            # 兼容纯字符串列表
            return [{"id": "", "name": item, "keywords": ""} if isinstance(item, str) else item
                    for item in data]
        raise ValueError(f"JSON 文件格式应为数组，实际: {type(data)}")

    # 逗号/分号分隔的章节名字符串
    sep = ";" if ";" in raw else ","
    names = [n.strip() for n in raw.split(sep) if n.strip()]
    return [{"id": "", "name": n, "keywords": ""} for n in names]


# ── CLI 入口 ──────────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(
        description="uni-wiki 检索 v5.0（纯 BM25 + 别名扩展 + 字段加权 + 稳定性徽章）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("query", nargs="?", default="", help="单查询词（向后兼容）")
    parser.add_argument("--queries", nargs="+", help="多查询词，并行检索")
    parser.add_argument("--top",      type=int, default=TOP_N_DEFAULT)
    parser.add_argument("--list",     action="store_true", help="只列文件名+分数")
    parser.add_argument("--compact",  action="store_true", help="紧凑输出：只显示关键摘要，节省 token")
    parser.add_argument("--rebuild",  action="store_true", help="强制重建 BM25 索引")
    parser.add_argument("--checklist",action="store_true", help="输出充分性 checklist")
    parser.add_argument("--no-alias", action="store_true", help="禁用别名扩展")
    parser.add_argument("--show-aliases", action="store_true", help="打印别名字典")
    parser.add_argument("--pin-categories", nargs="*", default=[], metavar="PREFIX")
    parser.add_argument("--pin-min",  type=int, default=1)
    parser.add_argument("--pin-pages",nargs="*", default=[], metavar="PATH")
    # v5.1: 缺口检测
    parser.add_argument("--gap-check",  type=str, default="",
                        help="缺口检测：传入章节名（逗号分隔）或 JSON 文件路径。"
                             "示例: --gap-check \"主播属性,直播间维度,营收过程指标\""
                             "JSON: --gap-check /tmp/sections.json")
    parser.add_argument("--gap-threshold", type=float, default=100.0,
                        help="覆盖判定阈值（raw BM25 score，默认 100；PARTIAL >= 40）")
    args = parser.parse_args()

    # 显示别名字典
    if args.show_aliases:
        alias_map = build_alias_dict()
        print(f"[别名字典] 共 {len(alias_map)} 个条目：")
        for k, v in sorted(alias_map.items())[:30]:
            print(f"  {k} -> {v}")
        if len(alias_map) > 30:
            print(f"  ... 共 {len(alias_map)} 条")
        return

    # 重建 BM25 索引
    if args.rebuild:
        pages = load_pages()
        build_index(pages)
        print(f"[uni-wiki] v5 BM25 索引重建完成，共 {len(pages)} 个页面。")
        return

    # v5.1: 缺口检测
    if args.gap_check:
        sections = _parse_gap_check_input(args.gap_check)
        print(run_gap_check(sections,
                            threshold=args.gap_threshold,
                            use_alias=not args.no_alias))
        return

    # 决定查询
    queries: list[str] = []
    if args.queries:
        queries = args.queries
    elif args.query:
        queries = [args.query]
    else:
        parser.print_help()
        return

    # 执行检索
    use_alias = not args.no_alias
    pin_cats  = args.pin_categories or []
    pin_pages = args.pin_pages or []

    # 记录别名扩展信息
    expanded_info = ""
    if use_alias:
        alias_map = build_alias_dict()
        expansions = []
        for q in queries:
            eq = expand_query_with_aliases(q, alias_map)
            if eq != q:
                expansions.append(f"'{q}' -> '{eq}'")
        if expansions:
            expanded_info = "; ".join(expansions)

    results, all_scores, pages_cache = search_multi(
        queries, top_n=args.top, use_alias=use_alias
    )

    if pin_pages:
        results = apply_pin_pages(results, pages_cache, all_scores, pin_pages)
    if pin_cats:
        results = apply_pin_categories(results, pages_cache, all_scores, pin_cats, args.pin_min)

    print(format_output(
        results,
        list_only=args.list,
        show_checklist=args.checklist,
        compact=args.compact,
        queries=queries,
        expanded_info=expanded_info,
    ))


if __name__ == "__main__":
    main()
