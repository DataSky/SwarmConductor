# uni-wiki-vector · 知识完备度改进计划

**文档类型**：静态规划（Plan），变更须升版本  
**版本**：v1.0  
**制定日期**：2026-06-05  
**制定依据**：完备度综合评估（B+评级），基于 gap-check 验收及各域对比分析  
**制定人**：DataAgent 磁力番薯 wangteng06  
**执行跟踪**：见 `improvement_process.md`

---

## 一、改进目标

| 维度 | 当前状态 | 目标状态 |
|------|---------|---------|
| 整体评分 | B+（良好）| **A（优秀）**|
| mp 域页数 | 23 页 | **~50 页** |
| mp 术语词典 | 2 页（eco 的 5%）| **8+ 页** |
| mp SQL 模板 | 1 页 Hive SQL | **3+ 页（Hive + BISQL）** |
| 商业化 BI 数据集索引 | 基本空白 | **核心数据集 ID 全部确认** |
| 生服广告域 | 无专属页面 | **5+ 页专属 SOP** |
| 海外业务域 | 1 页概念 | **3+ 页（口径+数据集）** |

---

## 二、Gap 分析摘要（基于完备度评估报告）

### 🔴 P0 级缺口（影响日常取数命中率）

| 缺口ID | 描述 | 严重程度 |
|-------|------|---------|
| **G-01** | 商业化 BI 数据集 ID 索引缺失：mp_data_query_sop 中多处「待 metadataSearch 确认」| 🔴 P0 |
| **G-02** | mp 术语词典严重不足：2 页 vs eco 的 40 页；FT视角/内外循环/业务中心/客户分层等核心术语缺失 | 🔴 P0 |
| **G-03** | mp SQL 模板只有 1 个 Hive SQL（大盘消耗），缺 BISQL 模板（BI 数据集取数）和账户/计划粒度 SQL | 🔴 P0 |

### 🟡 P1 级缺口（影响分析深度）

| 缺口ID | 描述 |
|-------|------|
| **G-04** | 生服广告域专属知识空白（生服消耗口径/本地生活数据集/到店到家分析 SOP）|
| **G-05** | 海外域知识过薄（仅 1 页概念，无 Kwai for Business 数据集/海外取数 SOP）|
| **G-06** | eco 内循环投流 × mp 商业化视角联动 SOP 缺失 |
| **G-07** | 激励广告/合约广告专项规则和数据口径缺失 |

### 🟢 P2 级（优化项）

| 缺口ID | 描述 |
|-------|------|
| **G-08** | mp 实时数据集 SOP 缺失 |
| **G-09** | B/C 类跨域冲突未专页记录 |
| **G-10** | 主站 13 域知识时效性定期 review 机制缺失 |

---

## 三、三阶段执行计划

### 第一阶段（P0）：核心缺口修复 · 用户跟踪

**目标**：解决日常取数命中率问题，补全最高频使用场景的知识  
**规模**：5 个新建/更新页面  
**执行人**：DataAgent（用户实时跟踪）

| 序号 | 任务 | 文件路径 | 说明 | 对应缺口 |
|-----|------|---------|------|---------|
| P0-A | 确认商业化核心 BI 数据集 ID | 更新 `playbooks/mp/mp_data_query_sop.md §四` | entitySearch 搜索商业化数据集，补充实际 datasetId | G-01 |
| P0-B | mp 商业化业务术语扩充（一）| 新建 `terms/mp/mp_business_terms.md` | FT视角/内外循环/L5组织/业务中心/客户分层/ARPU 等 20+ 术语 | G-02 |
| P0-C | mp 商业化业务术语扩充（二）| 新建 `terms/mp/mp_ad_product_terms.md` | 激励广告/合约广告/品牌广告/聚星/联盟 等产品术语 | G-02/G-07 |
| P0-D | mp BISQL 模板（BI 数据集取数）| 新建 `sql/mp/mp_bisql_templates.md` | 消耗+YOY、L5组织拆分、有效供给、账户维度 BISQL 模板 | G-03 |
| P0-E | mp Hive SQL 补充（账户/计划粒度）| 更新 `sql/mp/ad_exposure_cost_sql.md` | 新增计划粒度消耗、YOY 同比、代理商消耗排名等 SQL | G-03 |

**验收标准**：
- entitySearch 商业化相关数据集列表已更新到 SOP
- 新增术语词典 2 页，商业化核心术语覆盖 30+
- BISQL 模板可直接复用，含 YOY/L5 组织/时间范围示例

---

### 第二阶段（P1）：深度建设 · DataAgent 自主推进

**目标**：补全生服广告域、海外业务域、联动分析  
**规模**：8 个新建页面  
**触发条件**：P0 全部完成 + 向用户发送完成报告 → 自主启动  
**执行人**：DataAgent（用户不参与，完成后同步）

| 序号 | 任务 | 文件路径 | 对应缺口 |
|-----|------|---------|---------|
| P1-1 | 生服广告概念页 | `concepts/mp/local_service_ad_concepts.md` | G-04 |
| P1-2 | 生服广告分析 SOP | `playbooks/mp/local_service_analysis_sop.md` | G-04 |
| P1-3 | 生服广告数据集索引（entitySearch 确认）| 更新 `playbooks/mp/mp_data_query_sop.md` | G-04 |
| P1-4 | 海外广告口径规则（扩充）| 更新 `rules/mp/overseas_business_caliber.md` | G-05 |
| P1-5 | Kwai for Business 数据集索引 | 新建 `playbooks/mp/overseas_data_query_sop.md` | G-05 |
| P1-6 | 内循环投流 × 商业化联动分析 | 新建 `playbooks/mp/incycle_mp_linkage_sop.md` | G-06 |
| P1-7 | 激励广告专项规则 | 新建 `rules/mp/incentive_ad_caliber.md` | G-07 |
| P1-8 | 合约广告专项规则 | 新建 `rules/mp/contract_ad_caliber.md` | G-07 |

---

### 第三阶段（P2）：持续优化 · DataAgent 自主推进

**目标**：优化长尾场景，建立知识维护长效机制  
**规模**：4 个页面 + 机制建设  
**触发条件**：P1 完成后自主启动

| 序号 | 任务 | 说明 | 对应缺口 |
|-----|------|------|---------|
| P2-1 | 实时数据集 SOP | 商业化实时数据取数（分钟粒度）| G-08 |
| P2-2 | B/C 类跨域冲突补录 | 扩充 `cross_domain/mp_eco_conflicts.md` | G-09 |
| P2-3 | 主站 13 域时效性 review | 对比原始文档，标注过期口径 | G-10 |
| P2-4 | mp gotchas 扩充 | 补充行业/代理商分析易错点 | 综合 |

---

## 四、知识页面规格规范

所有新建页面遵循 mp 域 frontmatter 规范（参见 `mp_plan.md §五`）：
- `domain: mp`，`stability: S1/S2`，`see_also` 跨域引用
- P0-B/P0-C 术语页按 eco 术语格式（`terms_id / definition / synonyms / usage`）
- P0-D BISQL 模板按 `sql/eco/` 下格式，含 ⚠️ 注意事项和来源标注

---

## 五、成功标准

| 阶段 | 验收标准 |
|------|---------|
| P0 完成 | mp 域总页数 ≥ 28；核心 BI 数据集 ID 已确认；BISQL 模板可用 |
| P1 完成 | 生服广告/海外各有 ≥ 2 页专属知识；mp 域总页数 ≥ 36 |
| P2 完成 | mp 域总页数 ≥ 40；mp 术语页数 ≥ 6；维护机制建立 |

---

## 六、DataAgent 自主推进协议

跨 Session 推进时，**首先读取 `improvement_process.md`**，根据 `current_stage` 和 `next_action` 确定下一步操作，执行完毕后更新 process.md。

---

*计划文档到此结束，执行过程见 `improvement_process.md`。*
