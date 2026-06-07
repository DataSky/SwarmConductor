---
name: uni-wiki-vector
description: DataSky统一知识库检索技能（uni-wiki-vector）。融合内容场电商（c-datawiki）与DataSky主站 13 个业务域（ks-data-context 全量）知识体系，并已扩展直播供给方向 DA 知识（主播属性/营收/流量/付费/视频/用户标签等），同时新增电商（eco）、平台（platform）和商业化（mp）三大专属知识域，支持 BM25 精确匹配 + 别名扩展 + 字段加权。覆盖：直播/消费/生产/社交/运营/搜索/招聘/流量/增长/房产/快聘等 13 个域，以及电商全业务域（达人经营/货架场域/支付分析/混排频控/XBR周报/算法方法论）、平台工具域（天工/KwaiBI/ABtest/SQL规范/Skill创建/达芬奇/埋点分析）和商业化广告域（广告体系/消耗口径/有效供给/账户诊断/ROI指标/活动分析/取数链路SOP/生服广告/激励合约广告/实时数据/品牌广告规则/DSP规则），共 **1,438 页**。当用户需要取数 SQL、口径查询、业务术语解释、易错点排查时触发。
---

# uni-wiki-vector

DataSky统一知识库 **BM25 检索**技能（v5.2），融合多套知识体系：

| 知识源 | 域 | 规模 |
|--------|-----|------|
| `c-datawiki`（原有）| 内容场电商（直播消费流量/短视频/GMV/场域/UDF）| 15 页 |
| `ks-data-context` live 域 | 直播全域（Playbook×58/规则×77/易错点×80+/术语×93）| 315 页 |
| `ks-data-context` 其他9域 | 消费/生产/社交/运营/搜索/招聘/流量/增长/房产/快聘 | 864 页 |
| **DA 知识兼容扩展**（2026-06-03 新增）| 直播供给/流量/C端用户/视频（含 S1/S2/S3 稳定性分层）| 18 页 |
| **eco 域电商专属知识**（2026-06-04 新增）| 达人/货架/支付/混排/XBR周报/算法方法论/SQL模板（7个）| 104 页 |
| **platform 域平台知识**（2026-06-04 新增，v2增强）| 天工/KwaiBI/ABtest/SQL规范/达芬奇/埋点分析/商业化数仓规范 | 46 页 |
| **mp 域商业化广告知识**（2026-06-05 新增）| 广告体系/消耗口径(厘÷1000=元)/有效供给/账户诊断/ROI/品牌广告/DSP/生服广告/激励合约/取数链路SOP/术语6页/BISQL模板/15个datasetId | **33 页** |
| **cross_domain 跨域治理**（2026-06-05 新增）| mp vs eco 口径冲突注册表（A类4+B类3+C类3）+ 时效性review机制 | **2 页** |
| **uni-wiki 合计** | **13 域全覆盖 + DA 知识 + eco 域 + platform 域 + mp 域 + cross_domain** | **1,438 页** |

> 脚本版本：**v5.1** | 上次重建：**2026-06-05 02:18**（最终定稿）
> 工具调用目标：**2次**（read_skill + 1次 shell）

---

## 检索模式

**只有一种模式：纯 BM25**（v5.0 已移除 Milvus Hybrid 向量检索，零外部依赖）

| 特性 | v5.0 |
|------|------|
| 检索引擎 | BM25 + 别名扩展 + 字段加权（标题3x / 标签2x） |
| 首次调用 | ~5s（无需安装任何依赖） |
| 外部依赖 | **无**（纯 Python 标准库） |
| 索引大小 | 7.7MB（持久化） |

---

## DA 知识稳定性体系（v4.1+ 新增）

DA 同学的探索性口径按稳定性分为三层，检索结果自动附加徽章：

| 层级 | 徽章 | 含义 | 使用场景 |
|------|------|------|---------|
| **S1** | `[🟢 S1-Stable]` | 官方入仓，长期稳定 | 生产报表、调度任务均可用 |
| **S2** | `[🟡 S2-Semi-stable]` | 算法/业务产出，随模型迭代可能变化 | 探索分析可用，生产使用需定期验证 |
| **S3** | `[🔴 S3-Volatile]` | DA 探索性，未正式入仓 | 仅供一次性探索，禁止生产依赖 |
| **deprecated** | `[❌deprecated]` | 已明确下线 | 禁止使用，仅作历史档案 |

**Checklist 第 6 项**：结果中出现 S3/deprecated 页面时，自动触发 `[WARN]` 并给出 fallback 降级路径。

---

## 沙箱环境持久化说明

| 组件 | 存储位置 | 是否持久 | 说明 |
|------|---------|---------|------|
| Wiki 内容文件（1,400 页 .md） | `uni-wiki/wiki/` | ✅ 持久 | 无需重建 |
| BM25 索引（~9MB .json） | `uni-wiki/.bm25_index.json` | ✅ 持久 | 无需重建 |

**无需安装任何 pip 包，直接调用即可。**

---

## 知识库目录结构

```
uni-wiki/wiki/              （1,400 页，覆盖DataSky主站 13 个业务域 + DA 扩展 + eco 电商域 + platform 平台域）
├── concepts/    130 页   ← 核心实体（直播间/主播/达人/支付概念/货架场域/混排/算法/ABtest/KwaiBI/天工...）
│   ├── eco/      11 页   ← 电商专属：达人/货架/支付/T2K/混排/综合贡献度/维度影响指数
│   └── platform/  7 页   ← 平台专属：天工/KwaiBI结构/AB实验世界/CUPED/DiD/业务线体系
├── rules/       304 页   ← 口径规则（各域 GMV/付费/活跃/主播身份分层/用户标签/LTV/内容品类...）
│   ├── eco/      18 页   ← 电商规则：GMV口径/SQL规范/结算率归因/支付渗透率/银行卡/运费险/频控/混排
│   └── platform/  8 页   ← 平台规则：数仓规范/宏变量/SQL强制规则/BISQL/BI路由/路由规则
├── sql/          24 页   ← SQL 模板（直播消费/供给/主播属性/营收多口径/宫格团播/...）
│   └── eco/       7 页   ← 电商SQL：货架分析/达人诊断/支付漏斗/结算率归因/混排/直播/短视频
├── tables/        1 页   ← 核心数据表总览
├── terms/       596 页   ← 术语定义（各域指标/概念/业务词汇/别名映射）
│   ├── eco/      40 页   ← 电商术语：GMV体系/达人指标/货架场域/支付/混排/AB实验（共40个）
│   └── platform/ 14 页   ← 平台术语：DataAgent/BI数据集/数据专题/DAG/p_date/BISQL/Bucket等
├── udfs/          1 页   ← UDF 清单与用法
├── playbooks/   219 页   ← 场景 SOP（各域分析操作手册）
│   ├── eco/      24 页   ← 电商SOP：达人诊断/货架/支付/混排/XBR/WBR/算法方法论
│   └── platform/ 13 页   ← 平台SOP：Text2SQL/看板分析/AB实验/任务诊断/浏览器自动化/Skill创建
├── gotchas/     122 页   ← 易错点（口径陷阱/单位错误/字段混淆/已下线口径警告）
│   ├── eco/       4 页   ← 电商易错点：达人/货架/支付/混排
│   └── platform/  1 页   ← 平台易错点：AB实验
└── da_explore/    3 页   ← DA 探索性口径归档（S3/deprecated，含历史 SQL 存档）

覆盖域：live 直播 | csm 消费 | produce 生产 | social 社交 | op 运营
        search 搜索 | recruit 招聘 | traffic 流量 | growth 增长
        house 房产 | imv IMV | ky 快映 | kq 快聘
        da_live 直播供给方向 DA 扩展
        eco  电商全业务域（达人/货架/支付/混排/XBR/算法）← 2026-06-04 新增
        platform 平台工具域（天工/KwaiBI/ABtest/SQL规范）← 2026-06-04 新增
```

---

## 执行流程

### Step 1：构建查询词 + 执行检索

```bash
# 标准调用（BM25 + 别名扩展，推荐）
python3 /data_agent/users/assets/user_skills/uni-wiki-vector/uni-wiki/search.py \
  --queries \
    "<Q1: 业务概念 + 指标名 + 核心术语>" \
    "<Q2: SQL模板页标题 + 表名片段 + 主字段名>" \
    "<Q3: 精确字段名（含 _1d 后缀）+ 载体标识>" \
    "<Q4: 过滤条件 + 单位 + 口径限定词>" \
  --top 5 \
  --pin-pages "wiki/sql/<已知页>" \
  --compact --checklist

# 只输出文件列表（快速确认召回范围）
python3 .../search.py --queries "is_field" --top 3 --list
```

#### 4 维查询词构建规则

| 维度 | 内容 | 原则 |
|------|------|------|
| Q1 业务概念 | 载体名 + 指标名 + 核心术语 | 口语词汇也可，自动扩展别名 |
| Q2 SQL模板 | SQL 页标题关键词 + 表名片段 | 带表名可大幅提升命中 |
| Q3 专有字段 | 精确完整字段名（含 `_1d`）| BM25 把下划线字段当整体 token |
| Q4 口径规则 | 过滤字段 + 单位 + 限定词 | 覆盖 rules/gotchas/da_explore 目录 |

#### `--pin-pages` 规则

| 问题涉及 | 必须 pin 的页面 |
|----------|----------------|
| 挂车短视频指标 | `wiki/sql/短视频SQL.md` |
| 直播消费流量（曝光/进间/GPM） | `wiki/sql/直播消费流量SQL.md` |
| 直播供给/开播主播数 | `wiki/sql/直播供给SQL.md` |
| **主播画像/属性/聚类** | `wiki/sql/主播属性分析SQL.md` |
| **主播身份（新存联/好主播等级）** | `wiki/rules/主播身份分层体系.md` |
| **营收/流水/打赏口径** | `wiki/sql/营收多口径SQL.md` |
| **宫格/团播/语音厅** | `wiki/sql/宫格团播细分SQL.md` |
| **stid/扶持流量/bonus** | `wiki/sql/流量链路stid分析SQL.md` |
| **LTV/关注关系** | `wiki/rules/LTV关注关系口径.md` |
| **B端AB实验分流** | `wiki/sql/B端实验分流SQL.md` |
| **用户DAU/UA/LT** | `wiki/sql/用户活跃DAU口径SQL.md` |
| **付费/千一极值/首次打赏** | `wiki/sql/付费用户漏斗口径SQL.md` |
| **用户标签/生命周期/打开理由** | `wiki/rules/用户标签分层体系.md` |
| **视频生产/分发/VV来源** | `wiki/sql/视频相关口径SQL.md` |
| **视频查重/标题词/二创识别** | `wiki/sql/视频质量治理SQL.md` |
| **KPA颜值分** | `wiki/concepts/kpa_score.md` |
| **直播间行业类型（秀场/电商/游戏/本地生活/房产）** | `wiki/sql/直播间类型识别SQL.md` |
| **送礼意愿次数/过程指标** | `wiki/sql/营收多口径SQL.md`（§5.7 送礼意愿次数） |
| **团播团员/嘉宾成员** | `wiki/sql/宫格团播细分SQL.md`（§6.5 团播团员） |
| UDF 函数 | `wiki/udfs/UDF清单与用法.md` |
| 主播 GMV 归因 | `wiki/playbooks/anchor-gmv-attribution.md` |
| 付费漏斗 | `wiki/playbooks/query-charge-pay-funnel.md` |
| **货架场域 GMV/日均/营销活动** | `wiki/sql/eco/货架场域分析SQL.md` |
| **达人直播效率/拿量效率/粉丝召回** | `wiki/sql/eco/内容场直播分析SQL.md` |
| **短视频GMV漏斗/UV渗透率/MAC&DAC** | `wiki/sql/eco/短视频挂车SQL.md` |
| **支付漏斗/收银台/默选/渗透率** | `wiki/sql/eco/支付漏斗分析SQL.md` |
| **结算率归因/10维度/BHB** | `wiki/sql/eco/结算率归因SQL.md` |
| **达人GMV/货盘/分位数基准** | `wiki/sql/eco/达人经营诊断SQL.md` |
| **混排LOAD/竞胜/频控规则** | `wiki/sql/eco/混排竞争分析SQL.md` |
| **电商达人分析体系（L分层/GMV四子项）** | `wiki/concepts/eco/daren_definition.md` |
| **泛货架/商城/川流/大链接** | `wiki/concepts/eco/shelf_field_concepts.md` |
| **支付链路/默选/漏斗字母标注** | `wiki/concepts/eco/payment_funnel_concepts.md` |
| **综合贡献度BHB/辛普森悖论** | `wiki/concepts/eco/comprehensive_contribution_concepts.md` |
| **维度影响指数/根因维度** | `wiki/concepts/eco/dimension_influence_index_concepts.md` |
| **AB实验CUPED/preAA期** | `wiki/concepts/platform/cuped_methodology.md` |
| **天工平台/dagId/tiId** | `wiki/concepts/platform/tiangong_platform.md` |
| **KwaiBI看板/OLAP链接格式/数据集路由** | `wiki/concepts/platform/kwaibi_structure.md` |
| **广告消耗/ROI/CPM/CPC/CTR指标口径** | `wiki/terms/mp/mp_metrics_glossary.md` |
| **有效供给率/账户有效供给诊断** | `wiki/rules/mp/effective_supply_caliber.md` |
| **广告账户诊断/投放问题排查** | `wiki/playbooks/mp/account_diagnosis_sop.md` |
| **商业化广告投放体系/磁力金牛** | `wiki/concepts/mp/ad_system_overview.md` |
| **广告消耗口径/消耗单位规范（厘÷1000=元）** | `wiki/rules/mp/ad_cost_caliber.md` |
| **mp vs eco 口径冲突/跨域区别** | `wiki/cross_domain/mp_eco_conflicts.md` |
| **商业化业绩达成/L5组织分析** | `wiki/playbooks/mp/business_performance_sop.md` |
| **广告流量场域/ad_load归因/VV×ad_load×CPM** | `wiki/playbooks/mp/ad_traffic_analysis_sop.md` |
| **品牌广告/GD合约/TopView/开屏** | `wiki/concepts/mp/brand_ad_concepts.md` |
| **DSP/RTB程序化广告** | `wiki/concepts/mp/dsp_rtb_concepts.md` |
| **达芬奇/用户画像/人群圈选/分群包** | `wiki/concepts/platform/davinci_platform.md` |
| **埋点分析/page_show/click/stid** | `wiki/playbooks/platform/buried_point_analysis_sop.md` |
| **海外业务/Kwai/nebula/海外口径差异** | `wiki/rules/mp/overseas_business_caliber.md` |
| **商业化活动分析/618/双11/活动ROI** | `wiki/playbooks/mp/activity_analysis_sop.md` |
| **小贷借钱/用信金额/信贷漏斗** | `wiki/concepts/mp/credit_analysis_overview.md` |
| **商业化取数链路/mp-dataset-routing/mp-bi-data-query/YOY年同比BISQL/路由边界** | `wiki/playbooks/mp/mp_data_query_sop.md` |

### Step 2：Checklist 驱动的充分性判断

`--checklist` 自动校验 **6 项**：

| # | 校验项 | 未通过时行为 |
|---|--------|------------|
| 1 | Hive 表名已出现（ks_plateco_core / dws_eco 系列） | 加 ⚠️ 注释 |
| 2 | 关键过滤字段已出现（is_avator / is_field 等） | 加 ⚠️ 注释 |
| 3 | 至少存在一个 SQL 代码块（\`\`\`sql） | 加 ⚠️ 注释 |
| 4 | GMV 单位说明已出现（分/元换算） | 加 ⚠️ 注释 |
| 5 | 载体区分逻辑已出现（直播/短视频/短引识别方式） | 加 ⚠️ 注释 |
| **6** | **结果中不含 S3/deprecated 页面（生产可用）** | 触发 `[WARN]` + 输出 fallback 路径 |

前5项全通过 → 直接生成 SQL；第6项 WARN 不阻断生成，但提醒人工确认。

### Step 3：声明知识来源

```
📚 来源：uni-wiki / <页面路径>（score: N）[🟢 S1-Stable]
```

---

### Step 4（知识生产）：缺口自动检测 --gap-check

> **适用场景**：拿到一份新的 DA 文档，想快速知道哪些章节已经有对应 wiki 页面、哪些还是空白缺口。

#### 基础用法

```bash
# 方式1：逗号分隔字符串（快速扫描）
python3 /data_agent/users/assets/user_skills/uni-wiki-vector/uni-wiki/search.py \
  --gap-check "主播属性,直播间维度,营收过程指标,LTV关注关系"

# 方式2：JSON 文件（推荐，可附关键词大幅提升准确率）
python3 .../search.py --gap-check /tmp/sections.json

# 调整覆盖阈值（默认 100，越高越严格）
python3 .../search.py --gap-check "..." --gap-threshold 120
```

#### JSON 文件格式

```json
[
  {
    "id": "§1.1",
    "name": "主播基本属性粉段营收分层",
    "keywords": "clear_before_azuan_30d fans_range first_live_days"
  },
  {
    "id": "§1.5",
    "name": "直播间行业类型秀场识别",
    "keywords": "is_shop_car_live is_detect_game_live dim_ks_local_life_live_daily"
  }
]
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `id` | 否 | 章节编号，显示用（如 `§1.1`） |
| `name` | ✅ 必须 | 章节名称（越具体准确率越高） |
| `keywords` | 建议填 | 关键表名/字段名，显著提升识别准确率 |

> **提升准确率的关键**：在 `keywords` 中填入章节涉及的 Hive 表名、核心字段名。例如 `keywords: "ads_ks_live_actv_author_behav_aggr_1d execute_punish_code"` 能让 §1.4 治理判罚的命中率从 PARTIAL 升为 COVERED。

#### 输出解读

```
── Gap Check 结果 ──────────────────────────────────────────
  判定规则：score≥100 AND 标题重叠≥2 → 🟢COVERED ｜ score≥40 → 🟡PARTIAL ｜ 其余 → 🔴GAP
  共检测 16 个章节：🟢 已覆盖 12 ｜ 🟡 疑似 4 ｜ 🔴 缺口 0

  编号     状态         分数    重叠  章节名               最佳命中
  [§1.1]  🟢 COVERED  201.2  ★2   主播基本属性粉段营收分层  主播属性分析SQL
  [§1.5]  🟢 COVERED  258.7  ★4   直播间行业类型秀场识别    直播间类型识别SQL
  [§2.5]  🟡 PARTIAL   89.6  ★0   送礼意愿次数过程指标     营收多口径SQL    ← 建议补 keywords
```

| 字段 | 含义 |
|------|------|
| `分数` | raw BM25 score（≥100 才有资格 COVERED） |
| `重叠 ★N` | 章节名与命中页面标题的中文 bigram 重叠数（≥2 才最终确认 COVERED）|
| 🟢 COVERED | 已有对应页面，生产可用 |
| 🟡 PARTIAL | score 中等或重叠不足，建议人工确认 → 补充 keywords 后重试 |
| 🔴 GAP | 无对应页面，需新建 wiki 页 |

#### 标准知识生产工作流

```
1. 准备 sections.json（章节名 + keywords）
2. python3 search.py --gap-check sections.json    # 扫描缺口
3. 对每个 🔴 GAP / 🟡 PARTIAL 章节：
   a. 阅读原始文档对应章节
   b. 按 frontmatter 规范新建 wiki 页面（填稳定性字段）
   c. S3 页面加稳定性警告块
4. python3 search.py --rebuild                    # 重建索引
5. python3 search.py --gap-check sections.json    # 重跑验证，缺口应归零
```

---

## 输出格式

**SQL 类**：
```
## [指标名] SQL
**口径**：[引用 wiki 内容]
**使用表**：`库名.表名`
[SQL 代码块]
⚠️ 注意事项：[关键过滤/单位/陷阱]
📚 来源：uni-wiki / wiki/sql/xxx.md [🟢 S1-Stable]
```

**Playbook 类**：直接按 SOP 步骤输出，引用 playbooks/ 对应页面。

**易错点类**：直接输出 gotcha 警告，引用 gotchas/ 对应页面。

**S2/S3 口径类**：在输出前附加稳定性警告，说明最后验证日期和 fallback 路径。

---

## 索引维护

**正常使用时无需任何操作**，BM25 索引持久化存储。仅在 wiki 内容有新增/修改时执行重建：

```bash
# wiki 内容更新后，重建 BM25 索引（~1s）
cd /data_agent/users/assets/user_skills/uni-wiki-vector/uni-wiki
python3 search.py --rebuild
```

---

## 自更新规范

用户纠错 / 知识页面更新时：
1. `edit_file` 修改对应 wiki 页面，`version` +1，`last_updated` 改为当日
2. 若新增页面涉及 DA 知识，**必须填写** frontmatter 稳定性字段（`stability` / `dw_status` / `last_verified` / `fallback_to`）
3. S3 页面正文开头必须添加「稳定性警告块」
4. `python3 search.py --rebuild`
5. 在 `update_log.md` 追加变更记录

---

## DA 知识新增页面速查（2026-06-03）

| 层级 | 页面路径 | 关键内容 |
|------|---------|---------|
| 🟢 S1 | `wiki/sql/主播属性分析SQL.md` | 全量画像/签框/五大聚类/大区/治理判罚 |
| 🟢 S1 | `wiki/rules/主播身份分层体系.md` | 新存联/大V/钻石/好主播等级 |
| 🟢 S1 | `wiki/sql/营收多口径SQL.md` | 收礼/送礼/财务/投资情怀/末次归因打赏 |
| 🟢 S1 | `wiki/sql/宫格团播细分SQL.md` | 厅类型/语音场景/KTV/放映厅 |
| 🟢 S1 | `wiki/sql/流量链路stid分析SQL.md` | stid解码/扶持流量/bonus |
| 🟢 S1 | `wiki/rules/LTV关注关系口径.md` | LTV漏斗/关注日龄分层 |
| 🟢 S1 | `wiki/sql/B端实验分流SQL.md` | 主播uid分流/UDF速查 |
| 🟢 S1 | `wiki/sql/用户活跃DAU口径SQL.md` | DAU/分产品分页面/UA同时在线/LT |
| 🟢 S1 | `wiki/sql/付费用户漏斗口径SQL.md` | 纯新付费/主被动付费/千一极值/首次打赏渠道 |
| 🟢 S1 | `wiki/rules/用户标签分层体系.md` | 十大人群/生命周期T0-T5/打开理由 |
| 🟢 S1 | `wiki/sql/视频相关口径SQL.md` | 视频生产/消费/分发链路/VV来源分类 |
| 🟡 S2 | `wiki/concepts/kpa_score.md` | KPA颜值分/ks_ytech表 |
| 🟡 S2 | `wiki/rules/anchor_content_category.md` | LLM品类标签/tagnex |
| 🔴 S3 | `wiki/da_explore/品类标签_DA版.md` | DA自建宫/弹/团品类白名单 |
| ❌ dep | `wiki/da_explore/曝光位置分析_22年口径.md` | 历史中间表存档 |
| 🔴 S3 | `wiki/da_explore/秀场低质主播口径.md` | is_low_quality_author说明 |
| ⚠️ | `wiki/gotchas/kpa_history_deprecated.md` | KPA历史月更版已下线 |
| ⚠️ | `wiki/gotchas/exposure_rank_22yr_deprecated.md` | 22年曝光位置DA临时表失效 |

---

## 故障恢复

脚本报错时，降级为 read_file 多步流程：
```
read_file: uni-wiki/wiki/concepts/ or playbooks/ or gotchas/ or sql/
→ 定位目标页面
→ 基于内容生成答案
```
