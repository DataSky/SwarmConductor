---
title: 礼物
tags: [entity, live, core]
---
# 实体: 礼物

礼物是直播营收的载体，每个礼物有唯一 gift_id、价格、特效等属性。
送礼事件构成直播间营收的核心来源。

## primary_key
  - **field**: gift_id
  - **type**: bigint
  - **description**: 礼物唯一标识

## attributes
-   - **name**: gift_name
  - **type**: string
  - **description**: 礼物名称
-   - **name**: price
  - **type**: bigint
  - **description**: 礼物价格（单位需根据具体表确认，参考 gift_amount_unit）
-   - **name**: gift_category
  - **type**: string
  - **description**: 礼物分类（见 enums/gift_category）
-   - **name**: is_combo
  - **type**: boolean
  - **description**: 是否连击礼物
-   - **name**: special_effect
  - **type**: string
  - **description**: 特效类型

## related_tables
- kscdm.dim_ks_live_gift_all
- kscdm.dwd_ks_csm_send_gift_live_di
- kscdm.dwd_ks_csm_send_gift_live_extend_di
- ksapp.ads_ks_live_user_send_gift_1d
- ksapp.ads_ks_live_backpack_user_item_aggr_1d

## relationships
-   - **target**: audience
  - **cardinality**: N:M
  - **via**: dwd_ks_csm_send_gift_live_di
  - **description**: 用户送礼事件（观众粒度）
-   - **target**: live_room
  - **cardinality**: N:M
  - **via**: dwd_ks_csm_send_gift_live_di
  - **description**: 直播间收礼事件
-   - **target**: author
  - **cardinality**: N:M
  - **via**: 送礼明细 + author_id
  - **description**: 主播收礼

## amount_unit_warning
送礼金额字段使用三套单位：fen（分）、kuaibi（快币）、zuan（钻）
详见 rules/gift_amount_unit。

## related_rules
- gift_amount_unit

## related_gotchas
- gift-amount-unit-mismatch
- receive-zuan-dual-source

## created_at
2026-05-09

## updated_at
2026-05-09

## freshness_status
current

## quality_tier
L3_inferred