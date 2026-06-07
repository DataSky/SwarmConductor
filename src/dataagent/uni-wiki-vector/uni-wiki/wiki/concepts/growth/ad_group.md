---
title: 广告组
domain: growth
tags: [entitie, growth]
---
# 广告组

广告组是管理一组广告的配置单元，包含出价策略、定向配置、预算等信息。

## primary_key
- - **name**: group_id
- **type**: string
- **description**: 广告组ID

## attributes
- - **name**: group_name
- **type**: string
- **description**: 广告组名称
- - **name**: campaign_id
- **type**: string
- **description**: 所属计划ID
- - **name**: campaign_name
- **type**: string
- **description**: 所属计划名称
- - **name**: account_id
- **type**: string
- **description**: 账号ID
- - **name**: api_source
- **type**: string
- **description**: 媒体平台
- - **name**: product
- **type**: string
- **description**: 产品线
- - **name**: bid_type
- **type**: string
- **description**: 出价类型（OCPC、OCPM等）
- - **name**: bid_amount
- **type**: bigint
- **description**: 出价金额（分）
- - **name**: optimization_goal
- **type**: string
- **description**: 优化目标
- - **name**: deep_conversion_type
- **type**: string
- **description**: 深度转化类型
- - **name**: deep_conversion_bid
- **type**: bigint
- **description**: 深度转化出价
- - **name**: budget_mode
- **type**: string
- **description**: 预算模式
- - **name**: daily_budget
- **type**: bigint
- **description**: 日预算（分）
- - **name**: site_set
- **type**: string
- **description**: 版位配置
- - **name**: delivery_range
- **type**: string
- **description**: 投放范围
- - **name**: schedule_start_time
- **type**: bigint
- **description**: 投放开始时间
- - **name**: schedule_end_time
- **type**: bigint
- **description**: 投放结束时间
- - **name**: time_range
- **type**: string
- **description**: 投放时段
- - **name**: targeting_id
- **type**: string
- **description**: 定向ID
- - **name**: targeting_name
- **type**: string
- **description**: 定向名称
- - **name**: age_range
- **type**: string
- **description**: 年龄定向
- - **name**: gender
- **type**: string
- **description**: 性别定向
- - **name**: region
- **type**: string
- **description**: 地域定向
- - **name**: status
- **type**: bigint
- **description**: 广告组状态
- - **name**: enabled
- **type**: bigint
- **description**: 是否启用

## relationships
- - **name**: campaign
- **target_entity**: campaign
- **type**: many_to_one
- **description**: 所属计划
- **join_key**: campaign_id
- - **name**: ads
- **target_entity**: ad
- **type**: one_to_many
- **description**: 包含的广告
- **join_key**: group_id
- - **name**: creatives
- **target_entity**: creative
- **type**: one_to_many
- **description**: 包含的创意
- **join_key**: group_id

## source_tables
- - **table_id**: kscdm.dim_ks_ug_ad_group_all
- **usage**: 广告组维度主表