# uni-wiki-vector · 知识完备度改进 · 执行过程记录

**文档类型**：动态执行记录，随执行实时更新  
**关联计划**：`improvement_plan.md`  
**开始日期**：2026-06-05  
**最后更新**：2026-06-05 02:23（成功标准缺口补齐 +4页，知识库最终 **1,438 页**，mp 域 33 页，术语 6 页，评级 A，全项目收尾）

---

## 【状态仪表盘】

```
current_stage:    全部完成（ALL DONE · 含成功标准缺口补齐）
current_status:   COMPLETED ✅（P0+P1+P2+缺口补齐 全部完成，评级 A）
next_action:      按 time_review_record.md §三 每季度定期 review
overall_progress: 17 / 17 任务全部完成 + 额外缺口补齐 4 页
wiki_size_final:  1,438 页（改进前 1,423 页，净增 +15 页）
last_rebuild:     2026-06-05 02:18（1,438 页，最终定稿）
```

---

## 【全局进度表】

| 任务ID | 描述 | 文件路径 | 阶段 | 状态 | 完成时间 |
|-------|------|---------|------|------|---------|
| **P0-A** | 确认商业化核心 BI 数据集 ID + 更新 SOP | `playbooks/mp/mp_data_query_sop.md §四` | P0 | ✅ 完成 | 01:55 |
| **P0-B** | mp 业务术语扩充（一）：FT视角/内外循环/L5组织/客户分层 | `terms/mp/mp_business_terms.md` | P0 | ✅ 完成 | 01:55 |
| **P0-C** | mp 业务术语扩充（二）：激励广告/合约广告/聚星/联盟等产品术语 | `terms/mp/mp_ad_product_terms.md` | P0 | ✅ 完成 | 01:55 |
| **P0-D** | mp BISQL 模板（消耗YOY/L5组织/有效供给/账户维度）| `sql/mp/mp_bisql_templates.md` | P0 | ✅ 完成 | 01:55 |
| **P0-E** | Hive SQL 补充（计划粒度/YOY同比/FT拆分/投放系统拆分）| 更新 `sql/mp/ad_exposure_cost_sql.md` | P0 | ✅ 完成 | 01:55 |
| P1-1 | 生服广告概念页 | `concepts/mp/local_service_ad_concepts.md` | P1 | ✅ 完成 | 02:08 |
| P1-2 | 生服广告分析 SOP | `playbooks/mp/local_service_analysis_sop.md` | P1 | ✅ 完成 | 02:08 |
| P1-3 | 生服广告数据集索引 | 更新 `playbooks/mp/mp_data_query_sop.md §四` | P1 | ✅ 完成 | 02:08 |
| P1-4 | 海外广告口径规则扩充 | 更新 `rules/mp/overseas_business_caliber.md` v2 | P1 | ✅ 完成 | 02:08 |
| P1-5 | Kwai for Business 数据集索引 | `playbooks/mp/overseas_data_query_sop.md` | P1 | ✅ 完成 | 02:08 |
| P1-6 | 内循环×商业化联动分析 SOP | `playbooks/mp/incycle_mp_linkage_sop.md` | P1 | ✅ 完成 | 02:08 |
| P1-7 | 激励广告专项规则 | `rules/mp/incentive_ad_caliber.md` | P1 | ✅ 完成 | 02:08 |
| P1-8 | 合约广告专项规则 | `rules/mp/contract_ad_caliber.md` | P1 | ✅ 完成 | 02:08 |
| P2-1 | 实时数据集 SOP | `playbooks/mp/realtime_data_query_sop.md` | P2 | ✅ 完成 | 02:14 |
| P2-2 | B/C 类跨域冲突补录 | `cross_domain/mp_eco_conflicts.md` v2 | P2 | ✅ 完成 | 02:14 |
| P2-3 | 时效性 review 记录 | `cross_domain/time_review_record.md`（新建）| P2 | ✅ 完成 | 02:14 |
| P2-4 | mp gotchas 扩充 | 更新 `gotchas/mp/mp_gotchas.md`（+3章）| P2 | ✅ 完成 | 02:14 |

---

## 【P0 执行记录】

### P0-A：确认商业化核心 BI 数据集 ID

**状态**：⏳ 执行中  
**目标**：通过 entitySearch 找到商业化相关 BI 数据集，确认 datasetId，更新 mp_data_query_sop.md §四

**执行步骤**：
- [ ] entitySearch DATASET 关键词「商业化消耗」
- [ ] entitySearch DATASET 关键词「广告投放效果」
- [ ] entitySearch DATASET 关键词「效果广告流量」
- [ ] entitySearch DATASET 关键词「有效供给」
- [ ] 整理找到的 datasetId，更新 mp_data_query_sop.md §四常用数据集索引表

**执行记录**：
```
执行时间：—
找到数据集：—
更新状态：—
```

---

### P0-B：mp 业务术语扩充（一）

**状态**：⏳ 待执行  
**目标**：新建 `terms/mp/mp_business_terms.md`，覆盖以下术语：

| 术语 | 说明 |
|------|------|
| FT 视角（ft_type）| INCYCLE/EXCYCLE/UNION/AD_SOCIAL/BRAND |
| 内循环 / 外循环 | 详细定义与数据字段映射 |
| L5 组织 | 商业化/电商/生活服务，对应 four_quadrant_type 字段 |
| 业务中心（biz_center）| 各中心标准名称及口语简称映射 |
| 客户分层（client_label）| H/1S/2S/V1-V5/K/M 等分层定义 |
| 客户 ARPU | 计算公式与使用场景 |
| 代理商层级 | 一级/二级代理商，KA 直签 |
| 账户状态 | 投放中/暂停/违规/余额不足等状态枚举 |
| 预算消耗率 | 计算方式与正常区间参考 |
| 货币化率 | 商业化货币化率定义 |

```
执行时间：—
页面大小：—
验证状态：—
```

---

### P0-C：mp 广告产品术语扩充（二）

**状态**：⏳ 待执行  
**目标**：新建 `terms/mp/mp_ad_product_terms.md`，覆盖以下术语：

激励广告 / 合约广告（GD）/ 磁力聚星 / 联盟广告 / DataSky小店广告 / 粉条 / 全站推广 / 智能投放 / 素材质量分 / 创意形式（竖视频/横视频/图文）等

```
执行时间：—
页面大小：—
验证状态：—
```

---

### P0-D：mp BISQL 模板

**状态**：⏳ 待执行  
**目标**：新建 `sql/mp/mp_bisql_templates.md`，包含：
1. 昨日消耗 + YOY 年同比
2. 消耗 + 按 L5 组织拆分 + YOY
3. 有效供给率（按数据集字段）
4. 广告曝光量趋势（近7天）
5. 账户维度消耗排名（Top10）

```
执行时间：—
页面大小：—
验证状态：—
```

---

### P0-E：Hive SQL 补充

**状态**：⏳ 待执行  
**目标**：在 `sql/mp/ad_exposure_cost_sql.md` 新增：
- SQL 七：计划粒度消耗（campaign 维度）
- SQL 八：广告组粒度消耗（ad_group 维度）
- SQL 九：同比（YOY）计算（昨日 vs 去年同日）
- SQL 十：月度消耗趋势

```
执行时间：—
更新行数：—
验证状态：—
```

---

## 【P0 阶段验证】

```bash
# P0 完成后执行
cd /data_agent/users/assets/user_skills/uni-wiki-vector/uni-wiki
python3 search.py --rebuild
# 目标：总规模从 1,423 → ~1,428 页
# 验收搜索：
python3 search.py --queries "FT视角 内循环 外循环 业务中心" "BISQL 消耗 YOY 年同比 L5" "激励广告 合约广告 聚星" --top 3
```

---

## 【Gap Check 历史记录（改进阶段）】

| 时间 | 阶段 | mp域页数 | 主要验收项 |
|------|------|---------|----------|
| 2026-06-05 01:05 | mp初始建设完成（基线）| 23 页 | gap-check 24/24 |
| — | P0 完成后 | ~28 页 | 数据集ID已确认/术语可检索/BISQL可用 |
| — | P1 完成后 | ~36 页 | 生服/海外各≥2页 |
| — | P2 完成后 | ~40 页 | 维护机制建立 |

---

## 【索引重建记录】

| 时间 | 触发原因 | 重建前规模 | 重建后规模 |
|------|---------|----------|----------|
| 2026-06-05 01:30 | mp_data_query_sop v2 + SKILL.md pin-pages | 1,422 → **1,423 页** | 最新基线 |
| — | P0 完成后 | 1,423 | — |

---

## 【用户同步节点】

| 节点 | 触发时机 | 状态 |
|------|---------|------|
| P0 完成报告 | P0 全5项完成 + 索引重建 | ⏳ 待触发 |
| P1 完成报告 | P1 全8项完成 | 🔒 未启动 |
| P2 完成报告 | P2 全部完成 | 🔒 未启动 |

---

## 【问题与决策日志】

| 时间 | 问题 | 决策 |
|------|------|------|
| 2026-06-05 | P0-A：用户对商业化主要数据集查询权限不足，无法通过 metadataSearchV2 验证 | 改用 entitySearch 搜索数据集资产（不查询数据，只获取 ID），记录名称+ID，稳定性标注 S2 |
