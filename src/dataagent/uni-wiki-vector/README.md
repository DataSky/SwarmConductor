# uni-wiki-vector · DataSky统一知识库检索技能

> **版本**：v5.2 | **最后更新**：2026-06-05 | **作者**：wangteng06 via DataAgent  
> **状态**：生产可用 ✅ | **知识页面**：1,438 页 | **覆盖业务域**：17 个

---

## 一、是什么

`uni-wiki-vector` 是一个面向DataSky内部数据分析场景的**统一知识库检索技能（DataAgent User Skill）**。

它将DataSky主站 13 个业务域、电商（eco）、商业化广告（mp）、数据平台工具（platform）的核心数据知识，以 Markdown 页面方式存储在沙箱，并通过高效的 **BM25 + 别名扩展 + 字段加权**检索引擎，在 DataAgent 回答取数问题时**自动召回**相关口径、SQL 模板、业务规则和易错点。

**解决的核心问题：**
- 数据口径散落在多处文档，DataAgent 无法实时访问
- 大模型不了解DataSky内部业务术语和字段含义
- SQL 生成时容易踩坑（单位错误、字段混淆、载体区分错误等）
- 跨业务域口径冲突（eco 和 mp 对同一概念定义不同）

---

## 二、知识库规模

| 知识源 | 域 | 页数 |
|--------|-----|------|
| `ks-data-context` live 域 | 直播全域（Playbook×58/规则×77/易错点×80+/术语×93） | 315 页 |
| `ks-data-context` 其他 9 域 | 消费/生产/社交/运营/搜索/招聘/流量/增长/房产/快聘 | 864 页 |
| `c-datawiki`（原有） | 内容场电商（直播消费/短视频/GMV/UDF） | 15 页 |
| **DA 知识兼容扩展** | 直播供给/C端用户/视频（S1/S2/S3 稳定性分层） | 18 页 |
| **eco 域电商专属** | 达人/货架/支付/混排/XBR/算法方法论/SQL 模板 | 104 页 |
| **platform 域平台工具** | 天工/KwaiBI/ABtest/SQL规范/达芬奇/埋点分析 | 46 页 |
| **mp 域商业化广告** | 广告体系/消耗口径/ROI/品牌广告/DSP/生服/激励/合约 | 33 页 |
| **cross_domain 跨域治理** | mp vs eco 冲突注册表 + 时效性 review 机制 | 2 页 |
| **合计** | **17 域全覆盖** | **1,438 页** |

---

## 三、目录结构

```
uni-wiki-vector/
├── README.md              ← 本文件（项目说明）
├── GUIDE.md               ← 使用指南（含实际命令行序列）
├── INSTALL.md             ← 安装/部署指南
├── SKILL.md               ← DataAgent Skill 主声明文件
├── report.html            ← Skill 全景可视化报告
├── improvement_plan.md    ← 知识完备度改进计划
├── improvement_process.md ← 知识完备度改进过程记录
├── mp_plan.md             ← 商业化域建设计划
├── mp_process.md          ← 商业化域建设过程记录
└── uni-wiki/
    ├── search.py          ← BM25 检索引擎主脚本（v5.1，997行）
    ├── update_log.md      ← 完整变更日志
    ├── .bm25_index.json   ← 持久化 BM25 索引（~9.4MB，无需重建）
    └── wiki/              ← 知识页面目录（1,438 页 .md 文件）
        ├── concepts/      ← 核心概念（130页，含 eco/platform 子目录）
        ├── rules/         ← 口径规则（304页，含 eco/mp/platform 子目录）
        ├── sql/           ← SQL 模板（24页，含 eco/mp 子目录）
        ├── terms/         ← 术语定义（596页，含各域子目录）
        ├── playbooks/     ← 场景SOP（219页，含各域子目录）
        ├── gotchas/       ← 易错点（122页，含各域子目录）
        ├── da_explore/    ← DA探索性口径归档（S3/deprecated）
        ├── cross_domain/  ← 跨域治理（2页）
        ├── tables/        ← 核心数据表总览（1页）
        ├── udfs/          ← UDF清单（1页）
        └── entities/      ← 实体定义
```

---

## 四、知识分类说明

| 目录 | 内容 | 页数 |
|------|------|------|
| `terms/` | 术语定义、指标口径、别名映射 | 596 页 |
| `rules/` | 计算规则、过滤条件、单位换算 | 304 页 |
| `playbooks/` | 场景 SOP、操作手册、分析流程 | 219 页 |
| `concepts/` | 核心概念、业务架构、平台说明 | 130 页 |
| `gotchas/` | 易错点、口径陷阱、已下线警告 | 122 页 |
| `sql/` | SQL 模板（可直接参考使用） | 24 页 |
| `da_explore/` | DA 探索性口径（S3，生产禁用） | 3 页 |
| `cross_domain/` | 跨域冲突注册 + 时效性 review | 2 页 |

---

## 五、稳定性分层

所有知识页面按数据稳定性分为四层，检索结果自动附加徽章：

| 层级 | 徽章 | 含义 | 典型表前缀 | 使用建议 |
|------|------|------|-----------|---------|
| S1 | `[🟢 S1-Stable]` | 官方入仓，长期稳定 | `ksapp.*` `kscdm.*` | 生产报表、调度任务均可用 |
| S2 | `[🟡 S2-Semi-stable]` | 算法/业务产出，可能随模型迭代变化 | `ks_ytech.*` `ks_mmu.*` | 探索分析可用，生产使用需定期验证 |
| S3 | `[🔴 S3-Volatile]` | DA 探索性，未正式入仓 | `da_live.*` | 仅供一次性探索，禁止生产依赖 |
| deprecated | `[❌deprecated]` | 已明确下线 | — | 禁止使用，仅作历史档案 |

---

## 六、版本历史摘要

| 版本 | 日期 | 核心变更 | 页数 |
|------|------|---------|------|
| v3.0 | 2026-05-28 | 别名扩展 + 字段加权 | ~1,200 |
| v4.0 | 2026-05-31 | Hybrid 向量检索（BM25 + Milvus） | ~1,220 |
| v4.1 | 2026-06-03 | 稳定性徽章体系（S1/S2/S3） | 1,220 |
| v5.0 | 2026-06-03 | 移除 Milvus，纯 BM25，首次调用 30s→5s | 1,239 |
| v5.1 | 2026-06-04 | eco 域（104页）+ platform 域（46页）+ 搜索踩坑（13页） | 1,400 |
| **v5.2** | **2026-06-05** | **mp 域（33页）+ cross_domain + 15个datasetId实测** | **1,438** |

---

## 七、快速入门

```bash
# 1. 进入检索目录
cd /data_agent/users/assets/user_skills/uni-wiki-vector/uni-wiki

# 2. 标准检索（无需任何安装，直接运行）
python3 search.py \
  --queries "直播间GMV曝光" "营收口径" "is_field" \
  --top 5 --compact --checklist

# 3. 查看完整使用指南
cat ../GUIDE.md
```

> 详细命令行序列请参阅 [GUIDE.md](./GUIDE.md)  
> 部署/迁移说明请参阅 [INSTALL.md](./INSTALL.md)

---

## 八、维护规范

1. **新增知识**：在对应目录新建 `.md` 文件，填写 `frontmatter`（title/tags/stability/dw_status/last_verified/fallback_to）
2. **修改知识**：`edit_file` 修改对应页面，`version` +1，`last_updated` 更新为当日
3. **重建索引**：`python3 search.py --rebuild`（仅 wiki 内容变更后需要执行）
4. **记录变更**：在 `uni-wiki/update_log.md` 追加变更记录
5. **时效性 review**：参考 `wiki/cross_domain/time_review_record.md`，建议每季度执行一次

---

*最后更新：2026-06-05 10:04 | DataAgent wangteng06*
