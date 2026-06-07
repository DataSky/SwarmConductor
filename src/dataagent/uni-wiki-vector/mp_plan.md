# uni-wiki-vector · 商业化（mp）域集成建设计划

**文档类型**：静态规划（Plan），不随执行修改，变更须升版本  
**版本**：v1.1（2026-06-05 新增§九跨域治理规范、P0-0、see_also字段规范）  
**制定日期**：2026-06-05  
**制定人**：wangteng06（DataAgent 磁力番薯）  
**执行跟踪**：见 `mp_process.md`  

---

## 一、项目背景与目标

### 1.1 背景

uni-wiki-vector（v5.2）当前覆盖 1,400 页知识，已建设完成主站 13 个业务域、eco 电商域（104页）、platform 平台工具域（43页）。

经 Gap Check 分析（2026-06-05），**商业化（Monetization Platform，mp）域在 uni-wiki 中几乎空白**。Gap Check 原始报告 17/24 COVERED 存在严重假阳性（BM25 关键词错位命中电商/平台内容），修正后**真实覆盖率仅 6/24（25%）**。

### 1.2 目标

在 uni-wiki 知识库中新建 **`mp` 商业化域**，系统覆盖以下四大知识领域：

| 知识领域 | 包含内容 |
|---------|---------|
| DataSky商业化业务体系 | 广告投放（磁力金牛/品牌广告/DSP/生服广告）、业务线架构、账户管理 |
| 商业化核心指标体系 | ROI/CPM/CTR/CVR/ROAS/消耗/曝光/有效供给率等，含口径与单位规范 |
| 商业化分析 SOP | 账户诊断、业绩达成、有效供给、流量场域、活动分析等操作手册 |
| 商业化 SQL 模板 | 广告曝光消耗取数、账户诊断等常用 SQL 模板 |

### 1.3 成功标准

| 阶段 | 验收标准 |
|------|---------|
| 阶段一（P0） | 新增 6 页核心知识，重跑 gap-check：§A1/§A2/§E3/§E4 从🔴→🟢 |
| 阶段二（P1） | 新增 9 页，gap-check：24 章节修正后覆盖率 ≥ 18/24 |
| 阶段三（P2） | 新增 6 页 + 增强 4 页，修正后覆盖率 24/24，总知识库规模 ~1,425 页 |

---

## 二、Gap 分析摘要（修正后）

> Gap Check 执行时间：2026-06-05 00:08  
> Gap Check 配置文件：`/data_agent/users/sessions/5928664/outputs/generated/mp_gap_check.json`  
> 注：BM25 在商业化领域假阳性率约 65%，以下为人工修正后判定结果。

| 章节ID | 章节名 | 原始结果 | 修正判定 | 根因说明 |
|--------|--------|---------|---------|---------|
| §A1 | 商业化广告投放体系 | 🟢 | **🔴 GAP** | 命中「广告组」是电商广告术语，无磁力金牛/投放SOP |
| §A2 | 广告消耗分析 | 🟢 | **🟡 浅覆盖** | 命中「电商政策预算消耗ROI」，商业化消耗口径缺失 |
| §A3 | ROI/CPM/CTR指标 | 🟢 | **🟡 浅覆盖** | 有点击率术语，但商业化指标口径体系缺失 |
| §A4 | 广告曝光VV流量 | 🟢 | **🔴 GAP** | 命中「零曝光/零播放」是内容场，广告曝光分析缺失 |
| §A5 | DSP程序化广告 | 🟡 | **🔴 GAP** | 仅命中泛「广告」词，无DSP/RTB专属内容 |
| §A6 | 品牌广告分析 | 🟡 | **🔴 GAP** | 仅命中泛「广告」词，无品牌广告/GD内容 |
| §A7 | 商业化活动分析 | 🟢 | **🔴 GAP** | 命中「电商活动ROI」，商业化大促活动分析缺失 |
| §B1 | DataSky五大业务线体系 | 🟢 | **✅ 真实覆盖** | 已有专页「DataSky一级业务线与主App产品线体系」 |
| §B2 | 海外业务Kwai/nebula | 🟡 | **🟡 浅覆盖** | 仅业务线概述，无海外数据口径/SQL |
| §B3 | 生活服务本地生活 | 🟡 | **🟡 浅覆盖** | 仅业务线概述，无本地生活分析体系 |
| §C1 | 全量/增量表分区策略 | 🟢 | **✅ 真实覆盖** | 已有完整「数仓分区规范」页面 |
| §C2 | 宏变量SQL规范 | 🟢 | **✅ 真实覆盖** | 已有「宏变量规范」与「SQL强制规则」页面 |
| §C3 | 数据血缘关系 | 🟢 | **✅ 真实覆盖** | 已有「数据血缘（Lineage）」概念页 |
| §D1 | 天工平台开发运维 | 🟢 | **✅ 真实覆盖** | 已有「天工平台功能模块详解」 |
| §D2 | KwaiBI看板分析 | 🟡 | **🟡 浅覆盖** | 有结构概念页，缺看板分析SOP与数据集路由详解 |
| §D3 | 达芬奇用户画像 | 🟢 | **🟡 浅覆盖** | 命中用户标签体系，达芬奇平台操作SOP缺失 |
| §D4 | ABtest实验平台 | 🟢 | **✅ 真实覆盖** | 已有「AB实验平台核心概念」完整页面 |
| §D5 | 埋点分析平台 | 🟡 | **🔴 GAP** | 仅命中「大事件」一词，无埋点平台专属内容 |
| §E1 | CUPED/DiD方法论 | 🟢 | **✅ 真实覆盖** | 已有「CUPED方差缩减方法论」完整页面 |
| §E2 | 广告流量场域拆解 | 🟢 | **🔴 GAP** | 命中「内容场XBR私域/公域」，商业化27场域定义缺失 |
| §E3 | 商业化业绩达成分析 | 🟢 | **🔴 GAP** | 命中「DataAgent路由规则」，业绩达成分析SOP完全缺失 |
| §E4 | 有效供给分析 | 🟡 | **🔴 GAP** | 命中「直播供给SQL」，有效供给是商业化专属概念，缺失 |
| §E5 | 广告账户粒度诊断 | 🟢 | **🟡 浅覆盖** | 命中「TOP2000品牌准入规则」，账户诊断SOP不完整 |
| §E6 | 小贷借钱页分析 | 🟢 | **🔴 GAP** | 命中「stid流量链路」，完全偏差命中 |

**修正后统计：✅ 真实覆盖 6 ｜ 🟡 浅覆盖 6 ｜ 🔴 真实GAP 12**

---

## 三、mp 域目录结构设计

```
uni-wiki/wiki/
├── concepts/mp/              ← 商业化核心概念（新建）
│   ├── ad_system_overview.md
│   ├── mp_business_overview.md
│   ├── ad_traffic_fields.md
│   ├── brand_ad_concepts.md
│   ├── dsp_rtb_concepts.md
│   └── credit_analysis_overview.md
├── rules/mp/                 ← 商业化口径规则（新建）
│   ├── ad_cost_caliber.md
│   ├── effective_supply_caliber.md
│   ├── brand_ad_rules.md
│   ├── dsp_rtb_rules.md
│   └── overseas_business_caliber.md
├── sql/mp/                   ← 商业化SQL模板（新建）
│   └── ad_exposure_cost_sql.md
├── terms/mp/                 ← 商业化术语词典（新建）
│   ├── mp_metrics_glossary.md
│   └── mp_ad_terms.md
├── playbooks/mp/             ← 商业化分析SOP（新建）
│   ├── account_diagnosis_sop.md
│   ├── business_performance_sop.md
│   ├── effective_supply_analysis_sop.md
│   ├── ad_traffic_analysis_sop.md
│   └── activity_analysis_sop.md
└── gotchas/mp/               ← 商业化易错点（新建）
    └── mp_gotchas.md

# 同步增强现有 platform 域页面
concepts/platform/
│   ├── kwaibi_structure.md           ← 补充：OLAP数据集路由详解
│   └── davinci_platform.md           ← 新增：达芬奇平台SOP
playbooks/platform/
│   ├── davinci_usage_sop.md          ← 新增：达芬奇使用操作手册
│   └── buried_point_analysis_sop.md  ← 新增：埋点分析平台SOP
```

**规模预测**：新增约 21 页 + 增强 4 页 → 总规模 1,400 → **~1,425 页**

---

## 四、分阶段执行计划

### 阶段一（P0）：核心缺口 · 用户跟踪阶段

**目标**：建设商业化知识基础骨架，解决最高频分析场景的知识空白  
**规模**：6 个新建页面  
**执行人**：DataAgent（用户实时跟踪）  
**验收条件**：gap-check §A1/§A2/§A4/§E3/§E4 翻绿 + 索引重建验证

| 序号 | 文件路径 | 稳定性 | 核心内容 | 对应章节 |
|-----|---------|-------|---------|---------|
| **P0-0** | `cross_domain/mp_eco_conflicts.md` | 🟢 S1 | 【优先建设】跨域冲突注册表：ROI/消耗/公域私域/投流 等 A 类高危同名词的 eco vs mp 精确口径对比，作为所有 A 类冲突页面的底层锚点 | 全域 |
| P0-1 | `concepts/mp/ad_system_overview.md` | 🟢 S1 | 广告体系层级（账户→计划→广告组）、推广类型分类（竞价/合约）、产品线（磁力金牛/品牌广告/DPA/生服广告） | §A1 |
| P0-2 | `concepts/mp/mp_business_overview.md` | 🟢 S1 | 商业化业务架构（广告主/代理商/广告平台）、DataSky商业化产品矩阵概览、业务流程全链路 | §A1/§B1 |
| P0-3 | `terms/mp/mp_metrics_glossary.md` | 🟢 S1 | ROI/CPM/CPC/CTR/CVR/ROAS/消耗/曝光/点击/转化 共10+核心指标，含口径定义、单位、计算公式、易混淆辨析 | §A3/§A4 |
| P0-4 | `rules/mp/ad_cost_caliber.md` | 🟢 S1 | 广告消耗定义、消耗口径（账户/计划/广告组粒度差异）、单位规范（分→元）、预算消耗率计算、与电商消耗的区别 | §A2 |
| P0-5 | `rules/mp/effective_supply_caliber.md` | 🟢 S1 | 有效供给定义与背景、有效供给率计算公式、账户层级有效供给诊断规则、影响有效供给的核心因素 | §E4 |
| P0-6 | `playbooks/mp/account_diagnosis_sop.md` | 🟢 S1 | 五阶段诊断SOP：①准入检查→②场景定位→③排查环节（素材/定向/出价/竞争）→④诊断点→⑤优化建议；附诊断决策树 | §E5/§E3 |

---

### 阶段二（P1）：重要场景 · DataAgent 自主推进

**目标**：覆盖专项分析场景、补充术语/规则体系  
**规模**：9 个新建页面  
**触发条件**：阶段一所有页面创建完成 + gap-check 验证通过后，DataAgent 自主启动  
**执行人**：DataAgent（用户不参与，完成后主动同步）

| 序号 | 文件路径 | 稳定性 | 核心内容 | 对应章节 |
|-----|---------|-------|---------|---------|
| P1-1 | `concepts/mp/ad_traffic_fields.md` | 🟢 S1 | 广告流量27个场域体系：公域（单列/双列/精选页/搜索/开屏）、私域（关注页/主播私域）、场域标识字段与过滤口径 | §E2 |
| P1-2 | `terms/mp/mp_ad_terms.md` | 🟢 S1 | 广告术语词典：磁力金牛/DPA/OCPX/Reachmax/智能出价/OCPC/广告附加组件/素材/创意 等30+术语 | §A1/§A5/§A6 |
| P1-3 | `playbooks/mp/business_performance_sop.md` | 🟢 S1 | 商业化业绩达成分析SOP：大盘→L5组织→业务中心→行业→客户层级逐层分析框架；消耗目标进度计算方式 | §E3 |
| P1-4 | `playbooks/mp/effective_supply_analysis_sop.md` | 🟢 S1 | 有效供给大盘分析SOP：大盘→代理商→账户三层分析；有效供给提升策略；素材/定向/出价对有效供给的影响 | §E4 |
| P1-5 | `playbooks/mp/ad_traffic_analysis_sop.md` | 🟡 S2 | 广告流量场域拆解分析SOP：ad_load拆解方法、VV×ad_load×CPM归因框架、27场域趋势异常判断 | §E2 |
| P1-6 | `concepts/mp/brand_ad_concepts.md` | 🟢 S1 | 品牌广告体系：GD合约/TopView/开屏/品牌曝光投放；品效一体化；品牌广告与效果广告的口径差异 | §A6 |
| P1-7 | `concepts/mp/dsp_rtb_concepts.md` | 🟡 S2 | DSP/RTB概念：程序化广告链路（SSP/DSP/ADX）、实时竞价流程、外部流量变现、DataSkyDSP接入方式 | §A5 |
| P1-8 | `gotchas/mp/mp_gotchas.md` | 🟢 S1 | 商业化易错点：消耗单位（分/元）混淆、ROI口径差异（电商ROI vs 广告ROI）、CPM vs eCPM区别、有效供给率 vs 有效供给量、广告消耗 vs 投放金额 | §A2/§A3 |
| P1-9 | `sql/mp/ad_exposure_cost_sql.md` | 🟡 S2 | 广告曝光/消耗SQL模板（⚠️表名须执行阶段确认）：按账户/计划/广告组维度聚合曝光量/点击量/消耗；含宏变量分区写法 | §A2/§A4 |

> ⚠️ **P1-9 前置步骤**：执行前须先通过 `entitySearch` 确认商业化广告数据的实际 Hive 表名，SQL 内容应基于真实表名编写，不使用占位符。

---

### 阶段三（P2）：补充完善 · DataAgent 自主推进

**目标**：覆盖长尾场景，补充 platform 域弱覆盖项，达到全面验收标准  
**规模**：6 个新建页面 + 4 个增强现有页面  
**触发条件**：阶段二完成后，DataAgent 自主启动  
**执行人**：DataAgent（用户不参与，完成后主动同步）

**新建页面：**

| 序号 | 文件路径 | 稳定性 | 核心内容 | 对应章节 |
|-----|---------|-------|---------|---------|
| P2-1 | `playbooks/mp/activity_analysis_sop.md` | 🟡 S2 | 商业化活动分析SOP：618/双11等大促活动ROI分析框架、活动消耗归因方法、营销活动效果评估指标体系 | §A7 |
| P2-2 | `concepts/mp/credit_analysis_overview.md` | 🟡 S2 | 小贷借钱页分析体系：用信金额定义与口径、漏斗转化环节（曝光→点击→申请→授信→放款）、流量入口分类 | §E6 |
| P2-3 | `rules/mp/overseas_business_caliber.md` | 🟡 S2 | 海外业务数据口径差异：Kwai/nebula与国内口径对比、海外专属指标（ARPU/LTV/DAU海外定义）、新加坡环境数据隔离说明 | §B2 |
| P2-4 | `concepts/platform/davinci_platform.md` | 🟢 S1 | 达芬奇画像平台功能介绍：标签体系/人群圈选/分群包管理/画像分析；与DataAgent davinci-crowd-pack skill的联动方式 | §D3 |
| P2-5 | `playbooks/platform/davinci_usage_sop.md` | 🟢 S1 | 达芬奇平台操作SOP：标签规则圈包流程、SQL圈包流程、分群包创建与管理、常见问题处理 | §D3 |
| P2-6 | `playbooks/platform/buried_point_analysis_sop.md` | 🟢 S1 | 埋点分析平台SOP：事件类型（page_show/element_show/click）、参数字典（entry_source/search_session_id）、行为链路串联方法 | §D5 |

**增强现有页面：**

| 序号 | 文件路径 | 增强内容 |
|-----|---------|---------|
| P2-E1 | `concepts/platform/kwaibi_structure.md` | 补充：数据集路由详解、shareId/insightConfigId格式示例、OLAP分析场景vs普通看板区别 |
| P2-E2 | `concepts/platform/ks_business_lines.md` | 补充：生活服务本地生活数据体系、到店/到家业务逻辑；海外业务Kwai/nebula与国内差异 |
| P2-E3 | `rules/platform/` 数仓规范页面 | 补充：商业化库名前缀规范（mp_/ads_/ks_mp_等）、商业化表分区命名惯例 |
| P2-E4 | `terms/platform/data_agent.md` | 补充：商业化DataAgent（磁力番薯）特有能力说明；mp域路由规则 |

---

## 五、知识页面内容规格

### 5.1 Frontmatter 规范（强制）

每个新建页面必须包含完整 frontmatter，参照以下标准：

```yaml
---
title: "<页面标题>"
domain: mp                    # 固定为 mp（商业化域）
category: concepts|rules|sql|terms|playbooks|gotchas
tags: ["<主标签>", "<次标签>"]
aliases: ["<检索别名1>", "<检索别名2>"]   # 至少2个，提升BM25命中率
stability: S1|S2|S3
last_verified: "2026-06-05"
source_skill: <来源skill名称，如 账户粒度诊断工具 / mp-ad-exposure-analysis-v5>
version: 1
see_also:                     # 可选，跨域引用时必填
  - path: "wiki/<相对路径>"
    note: "【区别/参考/补充】<说明本页与该页的关系>"
---
```

**`see_also` 填写规则**：
- A 类冲突页面（同名词不同含义）：**必填**，note 必须标注「【区别】」前缀，明确说明差异
- B 类引用页面（eco已有，mp不重建）：**必填**，note 标注「【参考】」前缀
- C 类交叉页面：**建议填**，note 标注「【补充】」前缀
- 普通页面无跨域引用时：可省略 `see_also` 字段

**稳定性标注规则**：
- 🟢 S1：内容来自官方文档/稳定业务规范，可用于生产报表
- 🟡 S2：内容基于 DataAgent 系统知识推断，随业务迭代可能变化，探索分析可用，生产使用须定期验证
- 🔴 S3：探索性口径，禁止生产依赖（本批次建设不产生S3页面）

### 5.2 内容质量规范

| 类型 | 必含内容 | 参考模板 |
|------|---------|---------|
| concepts | 概念定义、体系结构表格、与相关概念的区别 | `concepts/eco/daren_definition.md` |
| rules | 口径定义、计算公式/字段映射、单位说明、与相似指标的辨析 | `rules/eco/daren_gmv_caliber.md` |
| sql | 表名、SQL代码块（```sql）、字段说明、分区写法、注意事项 | `sql/eco/货架场域分析SQL.md` |
| terms | 术语名、同义词、定义、计算方式、单位、易混淆辨析 | `terms/eco/` 下任意文件 |
| playbooks | 分步SOP（有序列表）、决策树/流程图（文字）、常见问题 | `playbooks/eco/daren_diagnosis_overview.md` |
| gotchas | 错误示例（❌）、正确示例（✅）、根因说明、影响范围 | `gotchas/eco/` 下任意文件 |

---

## 六、SKILL.md 更新清单

阶段一完成后，更新 `SKILL.md` 以下位置：

1. **知识源表格** 新增一行：
   ```
   | mp 商业化域（新增） | 广告体系/消耗口径/有效供给/账户诊断/ROI指标 | ~21 页 |
   ```

2. **目录结构** 新增 `mp/` 子目录说明

3. **pin-pages 表** 新增以下条目（阶段一完成时补充）：
   - 广告消耗/ROI/CPM → `wiki/terms/mp/mp_metrics_glossary.md`
   - 有效供给率/账户有效供给 → `wiki/rules/mp/effective_supply_caliber.md`
   - 广告账户诊断/投放问题排查 → `wiki/playbooks/mp/account_diagnosis_sop.md`
   - 商业化广告投放体系/磁力金牛 → `wiki/concepts/mp/ad_system_overview.md`
   - 广告消耗口径/消耗分析 → `wiki/rules/mp/ad_cost_caliber.md`

4. **规模描述** 更新：`1,400 页` → `~1,425 页`（阶段三完成后）

5. **上次重建时间** 更新为最新重建日期

---

## 七、DataAgent 自主推进协议

### 7.1 阶段二自主启动条件（AND 逻辑）

- [ ] 阶段一全部 6 个页面已创建
- [ ] 执行 `python3 search.py --rebuild` 索引重建完成
- [ ] 重跑 `--gap-check` 验证：§A1/§E4 状态变为🟢
- [ ] 向用户发送阶段一完成确认报告（含 gap-check 结果截图/文本）

满足上述条件后，DataAgent 无需等待用户指令，**自主启动阶段二**。

### 7.2 阶段三自主启动条件（AND 逻辑）

- [ ] 阶段二全部 9 个页面已创建（P1-9 表名已确认）
- [ ] 执行索引重建 + gap-check 验证：修正后覆盖率 ≥ 18/24
- [ ] 向用户发送阶段二完成确认报告

满足上述条件后，DataAgent **自主启动阶段三**。

### 7.3 跨 Session 推进协议

由于 DataAgent 执行存在 Session 边界，跨 Session 自主推进时：

1. 新 Session 开始时，**首先读取 `mp_process.md`** 了解当前进度
2. 根据 process.md 中的状态 `current_stage` 和 `next_action` 确定下一步操作
3. 执行完毕后更新 `mp_process.md` 的执行记录和状态

---

## 八、风险与约束

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| SQL 模板（P1-9）表名不确定 | 内容准确性风险 | 执行前先 entitySearch 确认，稳定性标注 S2 |
| 商业化业务口径随策略迭代 | 内容过期 | 页面标注 last_verified 日期，定期 review |
| 假阳性导致重复建设 | 浪费资源 | 每次建页前先执行 `--gap-check` 二次确认 |
| 跨 Session 上下文丢失 | 推进中断 | process.md 实时记录状态，保证可恢复 |

---

*计划文档到此结束。执行过程请见 `mp_process.md`。*

---

## 九、跨域知识治理规范（v1.1 新增）

### 9.1 三原则

| 原则 | 说明 |
|------|------|
| **SSOT（唯一来源）** | 同一概念只在最归属的域建一次，其他域通过 `see_also` 引用，不重建 |
| **冲突显式化** | A 类同名词冲突必须在两域各自页面 + `cross_domain/mp_eco_conflicts.md` + `gotchas/mp/mp_gotchas.md` 中同时标注，禁止让用户自己发现歧义 |
| **边界锚定** | 所有有歧义的页面都须在 `see_also` 中引用 `wiki/rules/platform/agent_routing_rules.md`（eco/mp 边界权威页） |

### 9.2 三类重叠处理策略

| 类型 | 特征 | 处理方式 |
|------|------|---------|
| **A 类：同名词，不同含义** | ROI / 消耗 / 公域私域 / 投流 | 两域各建，页面内设「与 eco 域的口径区别」章节，`see_also` 互引，`cross_domain/mp_eco_conflicts.md` 登记 |
| **B 类：eco 已有完整内容，mp 需用** | 混排竞价体系、达人商业化分型、TOP2000 准入 | mp 域**不重建**，直接在相关页面 `see_also` 引用 eco 域页面 |
| **C 类：有交叉但业务逻辑不同** | 广告带货 GMV、电商广告场域 | 两域各建，明确适用范围声明，互相 `see_also` |

### 9.3 A 类冲突清单（当前已识别）

| 术语 | eco 域精确含义 | mp 域精确含义 | 冲突级别 | 注册页面 |
|------|-------------|-------------|---------|---------|
| **ROI** | 政策带动GMV / 政策补贴消耗（分子为GMV增量） | 广告转化总价值 / 广告账户消耗 | 🔴 高危 | `cross_domain/mp_eco_conflicts.md §1` |
| **消耗** | 平台补贴（B补+C补）实际花出去的金额，单位：**元** | 广告账户实际计费扣款，原始单位：**分**，÷100 = 元 | 🔴 高危 | `cross_domain/mp_eco_conflicts.md §2` |
| **公域 / 私域** | 流量来源（非关注用户流量 / 粉丝关注流量） | 广告投放位置类型（信息流公域坑位 / 关注页私域坑位） | 🟡 中危 | `cross_domain/mp_eco_conflicts.md §3` |
| **投流** | 达人/商家购买广告为自身内容引流（eco 视角：成本项） | 广告主购买广告位触达目标用户（mp 视角：收入来源） | 🟡 中危 | `cross_domain/mp_eco_conflicts.md §4` |

### 9.4 B 类引用清单（mp 域禁止重建）

| eco 域已有页面 | mp 域使用场景 | 引用方式 |
|-------------|------------|---------|
| `concepts/eco/mixrank_concepts.md` | 广告流量与混排竞争 | P1-1 广告流量页 `see_also` |
| `concepts/eco/daren_definition.md` 商业化分型章节 | 达人广告主角色分析 | P0-2 商业化业务概述 `see_also` |
| `rules/eco/top2000_admission_rules.md` | 品牌广告账户准入 | P0-6 账户诊断 SOP 内文引用 |
| `rules/platform/agent_routing_rules.md` | 所有有边界歧义的页面 | 所有 A 类冲突页面 `see_also` |

### 9.5 跨域目录结构补充

```
uni-wiki/wiki/
└── cross_domain/               ← 新增（v1.1）
    └── mp_eco_conflicts.md     ← P0-0，跨域冲突注册表 SSOT
```

### 9.6 建设顺序约束

> **P0-0 必须在 P0-1 之前完成**。P0-3（指标词典）和 P0-4（消耗口径）中的 A 类冲突章节内容，必须与 P0-0 的冲突注册表内容保持一致。
