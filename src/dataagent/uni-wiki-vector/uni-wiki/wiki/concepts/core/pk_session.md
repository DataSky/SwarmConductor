---
title: PK 会话
tags: [entity, live, core]
---
# 实体: PK 会话

PK 会话是直播互动场景的核心实体，代表两个或多个主播的实时对战/连麦事件。
分为单挑 PK（2 人）和多人 PK（≥3 人，如大乱斗/团战）。
PK 与连线融合后统称"连屏"，包含：双人PK、多人PK、连线、礼物大作战、大舞台争霸、十二生肖、弹幕PK。

积分规则：普通送礼 1快币=3分，暴击时刻 1快币=6分（翻倍），点赞双人PK每人最多1分。
暴击在开始第60-65秒随机下发，持续30秒。偷塔为投票结束前10-30秒，不翻倍。
完成场定义：pk_vote_duration>=5分钟 AND is_finish=1。

## primary_key
-   - **field**: pk_id / multi_pk_id
  - **type**: string
  - **description**: PK 唯一标识
-   - **field**: session_id
  - **type**: string
  - **description**: PK 会话 ID（多人 PK 时使用）

## attributes
-   - **name**: play_type
  - **type**: int
  - **description**: PK类型：1=多人单挑(大乱斗), 2=多人团战, 3=双人PK
-   - **name**: pk_biz_type
  - **type**: string
  - **description**: PK业务类型（由pk_type加工，分析常用）：好友/随机/推荐/小时榜等
-   - **name**: score_change_type
  - **type**: int
  - **description**: 积分变化类型：2=点赞, 3=暴击点赞, 8=减分礼物
-   - **name**: pk_start_time / pk_end_time
  - **type**: timestamp
  - **description**: PK 开始/结束时间
-   - **name**: pk_duration
  - **type**: bigint
  - **description**: PK 持续时长
-   - **name**: winner_author_id
  - **type**: bigint
  - **description**: 获胜方主播
-   - **name**: pk_punishment
  - **type**: string
  - **description**: 惩罚类型（输方接受的"惩罚"，影响内容质量）

## related_tables
- kscdm.dim_ks_live_pk_daily
- kscdm.dim_ks_live_pk_rela_daily
- kscdm.dim_ks_live_multi_author_pk_daily
- kscdm.dim_ks_live_multi_line_chat_daily
- kscdm.dim_ks_live_score_line_chat_daily
- kscdm.dim_ks_live_arena_line_chat_daily
- kscdm.dim_ks_live_puzzle_line_chat_daily
- kscdm.dim_ks_live_mp_interact_line_chat_daily
- kscdm.dwd_ks_csm_pk_start_info_di
- kscdm.dws_ks_csm_prod_live_pk_behav_1d
- kscdm.dws_ks_csm_prod_user_live_pk_behav_1d
- kscdm.dws_ks_csm_prod_user_device_ssid_pca_multi_author_pk_behav_1d
- ksapp.ads_ks_live_pk_author_aggr_1d
- ksapp.ads_ks_live_multi_author_pk_aggr_1d
- ksapp.ads_ks_live_pk_score_detail_1d
- ks_origin_ksods_log.live_multi_pk_score_change_log

## relationships
-   - **target**: live_room
  - **cardinality**: N:1
  - **via**: live_id
  - **description**: PK 发生在直播间内
-   - **target**: author
  - **cardinality**: N:M
  - **via**: dim_ks_live_multi_author_pk_daily
  - **description**: PK 涉及的主播双方/多方
-   - **target**: audience
  - **cardinality**: N:M
  - **via**: dws_ks_csm_prod_user_live_pk_behav_1d
  - **description**: 观众观看 PK 直播

## business_value
- PK 是直播间留客和涨粉的关键机制
- 多人 PK / 团播是新兴互动业态
- PK 期间送礼集中，是营收高峰窗口

## created_at
2026-05-09

## updated_at
2026-05-13

## freshness_status
current

## quality_tier
L3_inferred