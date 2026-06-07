---
title: 观众
tags: [entity, live, core]
---
# 实体: 观众

观众是直播业务的消费侧核心实体，即"看直播的人"。
观众既有 user_id（账号身份）也有 device_id（设备身份），且**大小号现象普遍**——
同一自然人可能拥有多个 user_id，须用 main_user_id 去重（仅大 R 表有该字段）。

## primary_key
-   - **field**: user_id
  - **type**: bigint
  - **description**: 用户账号 ID（注意大小号问题）
-   - **field**: device_id
  - **type**: string
  - **description**: 设备 ID

## attributes
-   - **name**: main_user_id
  - **type**: bigint
  - **description**: 主账号 ID（去大小号重；仅 ads_ks_live_starship_cost_user_nd 等大R表有）
-   - **name**: pay_amt
  - **type**: bigint
  - **description**: 累计付费金额（单位见 gift_amount_unit 规则）
-   - **name**: top1_author_id
  - **type**: bigint
  - **description**: 用户付费最多的主播（仅大 R 表）
-   - **name**: top1_author_amt_ratio_7d
  - **type**: double
  - **description**: 单主播付费占比（>0.7 = 高集中风险）

## related_tables
- ksapp.ads_ks_live_user_dim_td
- kscdm.dws_ks_csm_prod_user_live_behav_1d
- kscdm.dws_ks_csm_prod_user_live_cost_income_1d
- ksapp.ads_ks_live_bigr_nd
- ksapp.ksapp_ads_ks_live_pay_user_contact_detail_1d

## relationships
-   - **target**: author
  - **cardinality**: N:M
  - **via**: dws_ks_csm_page_user_device_author_live_behav_1d
  - **description**: 观看关系
-   - **target**: live_room
  - **cardinality**: N:M
  - **via**: dwd_ks_csm_play_live_di
  - **description**: 进入直播间观看事件
-   - **target**: gift
  - **cardinality**: N:M
  - **via**: dwd_ks_csm_send_gift_live_di
  - **description**: 送礼行为

## bigr_subset
大 R = 高付费用户，按近 N 日付费阈值划分（业务侧定义，参考 ksapp.ads_ks_live_bigr_nd）
关键标识：is_investment_user（投资型/感性型）、main_user_id（去大小号重）

## related_gotchas
- alt-account-detection
- investment-vs-sentiment-bigr
- top1-author-concentration-risk

## created_at
2026-05-09

## updated_at
2026-05-09

## freshness_status
current

## quality_tier
L3_inferred