---
title: 直播间
tags: [entity, live, core]
---
# 实体: 直播间

直播间是直播业务的核心实体，代表主播在某个时间窗口开启的一场直播。
每个直播间有唯一 live_id，绑定一个主播（author_id），可能跨天（split_start_timestamp / split_end_timestamp）。

## primary_key
  - **field**: live_id
  - **type**: bigint
  - **description**: 直播间唯一标识（同一主播的不同场次不同 live_id）

## attributes
-   - **name**: author_id
  - **type**: bigint
  - **description**: 主播 ID
-   - **name**: live_type
  - **type**: bigint
  - **description**: 直播类型（见 enums/live_type）
-   - **name**: live_status
  - **type**: bigint
  - **description**: 直播状态（1=进行中, 2=正常结束, 3=被管理员结束）
-   - **name**: live_duration
  - **type**: bigint
  - **description**: 推流时长（注意单位差异，见 live_duration_unit 规则）
-   - **name**: start_timestamp
  - **type**: timestamp
  - **description**: 开始时间戳（毫秒精度）
-   - **name**: end_timestamp
  - **type**: timestamp
  - **description**: 结束时间戳（NULL 表示未结束）
-   - **name**: is_replay_live
  - **type**: bigint
  - **description**: 是否回放直播（1=是）

## related_tables
- kscdm.dim_ks_live_daily
- kscdm.dim_ks_live_all
- kscdm.dim_ks_live_extend_daily
- kscdm.dws_ks_csm_live_behav_1d
- ksapp.ads_ks_live_aggr_1d

## relationships
-   - **target**: author
  - **cardinality**: N:1
  - **via**: author_id
  - **description**: 一个直播间属于一个主播；一个主播可有多个直播间
-   - **target**: gift
  - **cardinality**: N:M
  - **via**: dwd_ks_csm_send_gift_live_di
  - **description**: 直播间内发生送礼事件
-   - **target**: pk_session
  - **cardinality**: 1:N
  - **via**: dim_ks_live_pk_daily
  - **description**: 一场直播可能包含多次 PK 会话

## cross_day_handling
跨天直播的时长拆分使用 split_start_timestamp / split_end_timestamp 字段，
其中 live_duration 已是拆分后当日内的时长，不需再处理。

## related_rules
- live_validity_filter
- live_duration_unit

## created_at
2026-05-09

## updated_at
2026-05-09

## freshness_status
current

## quality_tier
L3_inferred