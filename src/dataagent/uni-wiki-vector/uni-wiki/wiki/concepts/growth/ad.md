---
title: 广告
domain: growth
tags: [entitie, growth]
---
# 广告

广告是投放的基本单元，包含广告的基础配置和投放信息。

## primary_key
- - **name**: ad_id
- **type**: string
- **description**: 广告ID

## attributes
- - **name**: ad_name
- **type**: string
- **description**: 广告名称
- - **name**: group_id
- **type**: string
- **description**: 所属广告组ID
- - **name**: campaign_id
- **type**: string
- **description**: 所属计划ID
- - **name**: account_id
- **type**: string
- **description**: 账号ID
- - **name**: api_source
- **type**: string
- **description**: 媒体平台
- - **name**: channel
- **type**: string
- **description**: 渠道号
- - **name**: bid_type
- **type**: string
- **description**: 出价类型
- - **name**: bid_amount
- **type**: bigint
- **description**: 出价金额（分）
- - **name**: optimization_goal
- **type**: string
- **description**: 优化目标
- - **name**: promotion_rule_id
- **type**: string
- **description**: RTA推广规则ID
- - **name**: promotion_rule_name
- **type**: string
- **description**: RTA推广规则名称
- - **name**: is_promotion_rule_white
- **type**: bigint
- **description**: 是否RTA规则白名单（2025-01-11生效）
- - **name**: status
- **type**: bigint
- **description**: 广告状态
- - **name**: enabled
- **type**: bigint
- **description**: 是否启用
- - **name**: create_time
- **type**: bigint
- **description**: 创建时间
- - **name**: update_time
- **type**: bigint
- **description**: 更新时间

## relationships
- - **name**: ad_group
- **target_entity**: ad_group
- **type**: many_to_one
- **description**: 所属广告组
- **join_key**: group_id
- - **name**: campaign
- **target_entity**: campaign
- **type**: many_to_one
- **description**: 所属计划
- **join_key**: campaign_id
- - **name**: creatives
- **target_entity**: creative
- **type**: one_to_many
- **description**: 包含的创意
- **join_key**: ad_id
- - **name**: channel
- **target_entity**: channel
- **type**: many_to_one
- **description**: 投放渠道
- **join_key**: channel

## source_tables
- - **table_id**: kscdm.dim_ks_ug_adid_all
- **usage**: 广告ID维度主表
- - **table_id**: kscdm.dim_ks_ug_account_rta_promotion_rule_all
- **usage**: RTA推广规则