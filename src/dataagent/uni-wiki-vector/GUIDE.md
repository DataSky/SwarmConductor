# GUIDE · uni-wiki-vector 使用指南

> **版本**：v5.2 | **脚本路径**：`uni-wiki-vector/uni-wiki/search.py`

---

## 一、核心命令速查

### 脚本根目录（所有命令均从此目录执行）

```bash
WIKI_DIR="/data_agent/users/assets/user_skills/uni-wiki-vector/uni-wiki"
cd "$WIKI_DIR"
```

---

## 二、完整命令行序列——按场景分类

### 场景 A：标准取数查询（最常用）

```bash
# ===== 场景 A：4维查询词标准检索 =====
# 适用：查询指标口径、找 SQL 模板、确认字段含义

cd /data_agent/users/assets/user_skills/uni-wiki-vector/uni-wiki

python3 search.py \
  --queries \
    "直播间曝光 GPM 内容场电商" \
    "营收多口径SQL dwd_ks_csm_send_gift" \
    "is_field is_avator_live_1d" \
    "GMV单位 厘 ÷1000" \
  --top 5 \
  --compact \
  --checklist

# 输出示例：
# ── 检索结果 ──────────────────────────────────────
# [1] 直播消费流量SQL.md  score: 312.4  [🟢 S1-Stable]
# [2] 营收多口径SQL.md    score: 289.1  [🟢 S1-Stable]
# ...
# ── Checklist ────────────────────────────────────
# ✅ Hive表名已出现
# ✅ 关键过滤字段已出现
# ✅ SQL代码块已出现
# ✅ GMV单位说明已出现
# ⚠️ 载体区分逻辑未出现，建议 pin wiki/sql/直播消费流量SQL.md
```

---

### 场景 B：使用 --pin-pages 精准锁定页面

```bash
# ===== 场景 B：锁定 SQL 模板页面 =====

cd /data_agent/users/assets/user_skills/uni-wiki-vector/uni-wiki

python3 search.py \
  --queries \
    "主播营收 收礼 送礼 财务流水" \
    "末次归因打赏 送礼意愿次数" \
  --top 5 \
  --pin-pages "wiki/sql/营收多口径SQL.md" \
  --compact \
  --checklist
```

```bash
# ===== 场景 B2：锁定多个页面（空格分隔）=====

python3 search.py \
  --queries \
    "货架GMV支付漏斗" \
    "支付渗透率 默选 收银台" \
  --top 5 \
  --pin-pages "wiki/sql/eco/支付漏斗分析SQL.md" "wiki/sql/eco/货架场域分析SQL.md" \
  --compact \
  --checklist
```

---

### 场景 C：商业化广告（mp 域）查询

```bash
# ===== 场景 C1：查广告消耗口径 =====

cd /data_agent/users/assets/user_skills/uni-wiki-vector/uni-wiki

python3 search.py \
  --queries \
    "广告消耗口径 cost_total 厘" \
    "ROI计算 ROI ROAS CPA" \
    "有效供给率 账户诊断" \
    "FT视角 L5组织 内外循环" \
  --top 5 \
  --pin-pages "wiki/rules/mp/ad_cost_caliber.md" \
  --compact \
  --checklist
```

```bash
# ===== 场景 C2：商业化取数链路查询 =====

python3 search.py \
  --queries \
    "mp-dataset-routing 取数链路" \
    "商业化数据集 datasetId 114169 75372" \
    "BISQL YOY年同比 COMPARE_SAME_PERIOD" \
  --top 5 \
  --pin-pages "wiki/playbooks/mp/mp_data_query_sop.md" \
  --compact
```

```bash
# ===== 场景 C3：品牌广告 / DSP =====

python3 search.py \
  --queries \
    "品牌广告 GD合约 TopView 开屏" \
    "DSP RTB程序化广告" \
  --top 5 \
  --pin-pages "wiki/concepts/mp/brand_ad_concepts.md" "wiki/concepts/mp/dsp_rtb_concepts.md" \
  --compact
```

---

### 场景 D：电商（eco 域）查询

```bash
# ===== 场景 D1：达人经营分析 =====

cd /data_agent/users/assets/user_skills/uni-wiki-vector/uni-wiki

python3 search.py \
  --queries \
    "达人GMV L分层 货盘诊断" \
    "达人直播效率 拿量效率 粉丝召回" \
    "分位数基准 达人四象限" \
  --top 5 \
  --pin-pages "wiki/sql/eco/达人经营诊断SQL.md" "wiki/concepts/eco/daren_definition.md" \
  --compact \
  --checklist
```

```bash
# ===== 场景 D2：结算率归因 =====

python3 search.py \
  --queries \
    "结算率归因 10维度 BHB 综合贡献度" \
    "结算率 支付GMV 结算GMV" \
  --top 5 \
  --pin-pages "wiki/sql/eco/结算率归因SQL.md" "wiki/concepts/eco/comprehensive_contribution_concepts.md" \
  --compact
```

```bash
# ===== 场景 D3：货架场域分析 =====

python3 search.py \
  --queries \
    "泛货架 商城 川流 大链接" \
    "货架GMV 日均销售额 营销活动" \
  --top 5 \
  --pin-pages "wiki/sql/eco/货架场域分析SQL.md" "wiki/concepts/eco/shelf_field_concepts.md" \
  --compact
```

---

### 场景 E：平台工具知识查询

```bash
# ===== 场景 E1：KwaiBI / 数据集路由 =====

cd /data_agent/users/assets/user_skills/uni-wiki-vector/uni-wiki

python3 search.py \
  --queries \
    "KwaiBI看板 OLAP链接格式 shareId" \
    "数据集路由 BISQL datasetId" \
  --top 5 \
  --pin-pages "wiki/concepts/platform/kwaibi_structure.md" \
  --compact
```

```bash
# ===== 场景 E2：AB实验 CUPED =====

python3 search.py \
  --queries \
    "AB实验 CUPED preAA期 DiD" \
    "实验分流 桶 世界 BucketId" \
  --top 5 \
  --pin-pages "wiki/concepts/platform/cuped_methodology.md" \
  --compact
```

```bash
# ===== 场景 E3：天工平台任务诊断 =====

python3 search.py \
  --queries \
    "天工平台 dagId tiId 实例" \
    "数仓规范 p_date 分区" \
  --top 5 \
  --pin-pages "wiki/concepts/platform/tiangong_platform.md" \
  --compact
```

---

### 场景 F：直播域深度查询

```bash
# ===== 场景 F1：主播属性/画像 =====

cd /data_agent/users/assets/user_skills/uni-wiki-vector/uni-wiki

python3 search.py \
  --queries \
    "主播画像 签框状态 五大聚类 大区" \
    "治理判罚 execute_punish_code" \
    "主播身份 新存联 好主播等级 R1 R5" \
  --top 5 \
  --pin-pages "wiki/sql/主播属性分析SQL.md" "wiki/rules/主播身份分层体系.md" \
  --compact \
  --checklist
```

```bash
# ===== 场景 F2：营收多口径 =====

python3 search.py \
  --queries \
    "营收 收礼金额 送礼金额 财务流水" \
    "投资情怀 末次归因打赏" \
    "送礼意愿次数 LEAD函数" \
  --top 5 \
  --pin-pages "wiki/sql/营收多口径SQL.md" \
  --compact \
  --checklist
```

```bash
# ===== 场景 F3：付费漏斗 =====

python3 search.py \
  --queries \
    "付费用户漏斗 纯新付费 主动被动付费" \
    "千一极值 首次打赏渠道" \
    "ads_ks_live_user_dim_td" \
  --top 5 \
  --pin-pages "wiki/sql/付费用户漏斗口径SQL.md" \
  --compact
```

```bash
# ===== 场景 F4：宫格/团播/语音厅 =====

python3 search.py \
  --queries \
    "宫格团播 语音厅 KTV放映厅" \
    "厅类型 团播团员 嘉宾成员" \
  --top 5 \
  --pin-pages "wiki/sql/宫格团播细分SQL.md" \
  --compact
```

---

### 场景 G：跨域口径冲突查询

```bash
# ===== 场景 G：mp vs eco 口径冲突确认 =====

cd /data_agent/users/assets/user_skills/uni-wiki-vector/uni-wiki

python3 search.py \
  --queries \
    "mp eco 口径冲突 ROI定义差异" \
    "消耗单位 厘 公域私域 投流" \
  --top 5 \
  --pin-pages "wiki/cross_domain/mp_eco_conflicts.md" \
  --compact
```

---

### 场景 H：只查文件列表（快速确认召回范围）

```bash
# ===== 场景 H：--list 模式，只返回文件路径 =====

cd /data_agent/users/assets/user_skills/uni-wiki-vector/uni-wiki

python3 search.py \
  --queries "直播间GMV" "is_field" \
  --top 5 \
  --list

# 输出示例（只有文件路径，适合快速确认命中范围）：
# wiki/sql/直播消费流量SQL.md
# wiki/rules/...
```

---

### 场景 I：gap-check 缺口检测（知识生产专用）

```bash
# ===== 场景 I1：快速扫描（逗号分隔） =====

cd /data_agent/users/assets/user_skills/uni-wiki-vector/uni-wiki

python3 search.py \
  --gap-check "主播属性粉段,直播间行业类型,营收过程指标,LTV关注关系,付费漏斗" \
  --gap-threshold 100

# 输出示例：
# ── Gap Check 结果 ──────────────────────────────
# 共检测 5 个章节：🟢 5 | 🟡 0 | 🔴 0
# [主播属性粉段]   🟢 COVERED  score 201.2  ★2  → 主播属性分析SQL
# [直播间行业类型] 🟢 COVERED  score 258.7  ★4  → 直播间类型识别SQL
```

```bash
# ===== 场景 I2：JSON 格式（附 keywords，推荐） =====

# 先写 sections.json 到临时目录
python3 -c "
import json
sections = [
  {'id': '§1.1', 'name': '主播基本属性粉段营收分层', 'keywords': 'clear_before_azuan_30d fans_range first_live_days'},
  {'id': '§1.5', 'name': '直播间行业类型秀场识别', 'keywords': 'is_shop_car_live is_detect_game_live'},
  {'id': '§2.1', 'name': '广告消耗口径厘元换算', 'keywords': 'cost_total 厘 ÷1000'},
]
with open('/tmp/sections.json', 'w') as f:
    json.dump(sections, f, ensure_ascii=False, indent=2)
print('sections.json 已写入 /tmp/sections.json')
"

# 执行 gap-check
python3 /data_agent/users/assets/user_skills/uni-wiki-vector/uni-wiki/search.py \
  --gap-check /tmp/sections.json \
  --gap-threshold 100
```

---

### 场景 J：重建 BM25 索引

```bash
# ===== 场景 J：wiki 内容更新后重建索引（~1s）=====

cd /data_agent/users/assets/user_skills/uni-wiki-vector/uni-wiki

python3 search.py --rebuild

# 输出示例：
# [INFO] 重建 BM25 索引...
# [INFO] 加载 1438 个页面
# [INFO] 索引写入 .bm25_index.json (9.4MB)
# [INFO] 完成，耗时 1.2s
```

---

## 三、参数速查表

| 参数 | 类型 | 说明 | 示例 |
|------|------|------|------|
| `--queries` | 多值字符串 | 检索词列表（1-4个推荐） | `--queries "GPM" "is_field"` |
| `--top` | 整数 | 每个查询词返回的结果数 | `--top 5` |
| `--pin-pages` | 多值路径 | 强制置顶的页面（空格分隔） | `--pin-pages "wiki/sql/xxx.md"` |
| `--compact` | 开关 | 压缩输出（不显示正文摘要） | `--compact` |
| `--checklist` | 开关 | 自动执行 6 项质量校验 | `--checklist` |
| `--list` | 开关 | 只输出文件路径列表 | `--list` |
| `--gap-check` | 字符串/文件路径 | 缺口检测模式 | `--gap-check "概念A,概念B"` |
| `--gap-threshold` | 浮点数 | COVERED 判定阈值（默认 0.30） | `--gap-threshold 0.55` |
| `--rebuild` | 开关 | 重建 BM25 索引 | `--rebuild` |

---

## 四、--pin-pages 完整速查表

| 查询场景 | 必须 pin 的页面 |
|----------|----------------|
| 挂车短视频指标 | `wiki/sql/短视频SQL.md` |
| 直播消费流量（曝光/进间/GPM） | `wiki/sql/直播消费流量SQL.md` |
| 直播供给/开播主播数 | `wiki/sql/直播供给SQL.md` |
| 主播画像/属性/聚类 | `wiki/sql/主播属性分析SQL.md` |
| 主播身份（新存联/好主播等级） | `wiki/rules/主播身份分层体系.md` |
| 营收/流水/打赏口径 | `wiki/sql/营收多口径SQL.md` |
| 宫格/团播/语音厅 | `wiki/sql/宫格团播细分SQL.md` |
| stid/扶持流量/bonus | `wiki/sql/流量链路stid分析SQL.md` |
| LTV/关注关系 | `wiki/rules/LTV关注关系口径.md` |
| B端AB实验分流 | `wiki/sql/B端实验分流SQL.md` |
| 用户DAU/UA/LT | `wiki/sql/用户活跃DAU口径SQL.md` |
| 付费/千一极值/首次打赏 | `wiki/sql/付费用户漏斗口径SQL.md` |
| 用户标签/生命周期/打开理由 | `wiki/rules/用户标签分层体系.md` |
| 视频生产/分发/VV来源 | `wiki/sql/视频相关口径SQL.md` |
| 视频查重/标题词/二创识别 | `wiki/sql/视频质量治理SQL.md` |
| 直播间行业类型（秀场/电商/游戏） | `wiki/sql/直播间类型识别SQL.md` |
| UDF 函数 | `wiki/udfs/UDF清单与用法.md` |
| 货架场域GMV/日均/营销活动 | `wiki/sql/eco/货架场域分析SQL.md` |
| 达人直播效率/拿量效率 | `wiki/sql/eco/内容场直播分析SQL.md` |
| 短视频GMV漏斗/UV渗透率 | `wiki/sql/eco/短视频挂车SQL.md` |
| 支付漏斗/收银台/默选 | `wiki/sql/eco/支付漏斗分析SQL.md` |
| 结算率归因/10维度/BHB | `wiki/sql/eco/结算率归因SQL.md` |
| 达人GMV/货盘/分位数基准 | `wiki/sql/eco/达人经营诊断SQL.md` |
| 混排LOAD/竞胜/频控规则 | `wiki/sql/eco/混排竞争分析SQL.md` |
| AB实验CUPED/preAA期 | `wiki/concepts/platform/cuped_methodology.md` |
| 天工平台/dagId/tiId | `wiki/concepts/platform/tiangong_platform.md` |
| KwaiBI看板/OLAP链接格式 | `wiki/concepts/platform/kwaibi_structure.md` |
| 广告消耗/ROI/CPM/CPC/CTR指标 | `wiki/terms/mp/mp_metrics_glossary.md` |
| 有效供给率/账户有效供给诊断 | `wiki/rules/mp/effective_supply_caliber.md` |
| 广告账户诊断/投放问题排查 | `wiki/playbooks/mp/account_diagnosis_sop.md` |
| 广告消耗口径/消耗单位（厘÷1000=元） | `wiki/rules/mp/ad_cost_caliber.md` |
| 商业化取数链路/mp-dataset-routing | `wiki/playbooks/mp/mp_data_query_sop.md` |
| mp vs eco 口径冲突 | `wiki/cross_domain/mp_eco_conflicts.md` |
| 达芬奇/用户画像/人群圈选 | `wiki/concepts/platform/davinci_platform.md` |
| 埋点分析/page_show/click/stid | `wiki/playbooks/platform/buried_point_analysis_sop.md` |

---

## 五、6项 Checklist 说明

执行 `--checklist` 时，脚本自动校验以下 6 项：

| # | 校验内容 | 未通过行为 |
|---|---------|-----------|
| 1 | Hive 表名已出现（ks_plateco / dws_eco 等） | 加 ⚠️ 注释 |
| 2 | 关键过滤字段已出现（is_avator / is_field 等） | 加 ⚠️ 注释 |
| 3 | 至少存在一个 SQL 代码块（```sql）| 加 ⚠️ 注释 |
| 4 | GMV 单位说明已出现（分/元/厘换算） | 加 ⚠️ 注释 |
| 5 | 载体区分逻辑已出现（直播/短视频/短引） | 加 ⚠️ 注释 |
| **6** | **结果中不含 S3/deprecated 页面** | 触发 `[WARN]` + fallback 路径（不阻断生成） |

前 5 项全通过 → 可直接生成 SQL；第 6 项仅警告，提醒人工确认。

---

## 六、输出格式规范

### SQL 类输出

```
## [指标名] SQL
**口径**：[引用 wiki 内容]
**使用表**：`库名.表名`
```sql
SELECT ...
```
⚠️ 注意事项：[单位/过滤条件/载体区分]
📚 来源：uni-wiki / wiki/sql/xxx.md（score: 312.4）[🟢 S1-Stable]
```

### Playbook 类输出
直接按 SOP 步骤输出，引用 `playbooks/` 对应页面。

### 易错点类输出
直接输出 gotcha 警告，引用 `gotchas/` 对应页面，S2/S3 附加稳定性警告。

---

## 七、常见问题 FAQ

**Q：运行 search.py 提示找不到文件？**  
A：请先 `cd /data_agent/users/assets/user_skills/uni-wiki-vector/uni-wiki`，然后再执行 `python3 search.py`。

**Q：检索结果不准确？**  
A：参考 4 维查询词规则，尝试：(1) 加表名片段；(2) 加精确字段名（含 `_1d` 后缀）；(3) 使用 `--pin-pages` 强制锁定目标页面。

**Q：gap-check 结果有大量假阳性？**  
A：在 JSON 格式的 `keywords` 字段填入核心表名/字段名，可大幅降低假阳性率。

**Q：新增 wiki 页面后检索不到？**  
A：执行 `python3 search.py --rebuild` 重建索引（~1s）。

**Q：遇到 S3/deprecated 警告怎么办？**  
A：查看 `fallback_to` 字段给出的降级替代路径，优先使用降级页面。如果没有降级路径，需要人工确认是否有 S1 稳定版可用。

---

*最后更新：2026-06-05 10:04 | DataAgent wangteng06*
