---
title: 主播
tags: [entity, live, core]
---
# 实体: 主播

主播是直播业务的供给侧核心实体。一个主播可能在多个产品（KUAISHOU/极速版/...）下开播，
也可能加入公会/MCN，并按算法/运营标准被打上分层标签（R1-R5+ / K1-K6 / 业务类型）。

## primary_key
  - **field**: author_id
  - **type**: bigint
  - **description**: 主播 ID（即用户 ID 的子集，主播是一类有开播能力的用户）

## attributes
-   - **name**: user_name
  - **type**: string
  - **description**: 主播昵称（用于业务黑名单匹配，如魔盒）
-   - **name**: live_content_type
  - **type**: string
  - **description**: 直播内容类型（电商/游戏/招聘/本地生活/其他，见 multi-author-type-schemes gotcha）
-   - **name**: author_total_range
  - **type**: string
  - **description**: 好主播分层（R1/R2/R3/R4/R5+），见 ue-score-threshold gotcha
-   - **name**: corp_id / guild_id
  - **type**: bigint
  - **description**: 公会 ID
-   - **name**: is_investment_user
  - **type**: bigint
  - **description**: 投资型/感性型分类（仅大 R 维度有此字段）

## related_tables
- ksapp.ads_ks_live_author_dim_td
- ksapp.dim_ks_live_author_daily
- ksapp.ads_ks_live_author_aggr_1d
- ksapp.ads_ks_live_author_info_td
- ksapp.ads_ks_live_author_feature_nd

## relationships
-   - **target**: live_room
  - **cardinality**: 1:N
  - **via**: author_id
  - **description**: 一个主播多场直播
-   - **target**: corp（公会/MCN）
  - **cardinality**: N:1
  - **via**: corp_id
  - **description**: 主播加入公会
-   - **target**: audience
  - **cardinality**: N:M
  - **via**: dws_ks_csm_page_user_device_author_live_behav_1d
  - **description**: 主播-观众观看关系

## type_schemes_warning
供给域存在 3 套主播类型枚举，含义重叠但口径不同：
- aggr_1d.live_content_type（直播间粒度）
- author_dim_td.active_author_type_daily（MTD 口径）
- actv_author_behav.new_author_type（30d 口径）
分析时必须明确口径选择，详见 gotcha: multi-author-type-schemes

## related_rules
- active_anchor_definition

## related_gotchas
- multi-author-type-schemes
- k-layer-two-schemes
- ue-score-threshold
- file02-serial-backfill-extra-json

## created_at
2026-05-09

## updated_at
2026-05-09

## freshness_status
current

## quality_tier
L3_inferred