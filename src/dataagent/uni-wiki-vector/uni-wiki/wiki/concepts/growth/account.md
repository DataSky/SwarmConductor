---
title: 账号
domain: growth
tags: [entitie, growth]
---
# 账号

投放账号，是广告投放的最高层级组织单元。

## primary_key
- - **name**: account_id
- **type**: string
- **description**: 账号ID

## attributes
- - **name**: account_name
- **type**: string
- **description**: 账号名称
- - **name**: api_source
- **type**: string
- **description**: 媒体平台
- - **name**: product
- **type**: string
- **description**: 产品线
- - **name**: status
- **type**: bigint
- **description**: 账号状态
- - **name**: create_time
- **type**: bigint
- **description**: 创建时间

## relationships
- - **name**: campaigns
- **target_entity**: campaign
- **type**: one_to_many
- **description**: 账号下的计划
- **join_key**: account_id
- - **name**: ad_groups
- **target_entity**: ad_group
- **type**: one_to_many
- **description**: 账号下的广告组
- **join_key**: account_id
- - **name**: ads
- **target_entity**: ad
- **type**: one_to_many
- **description**: 账号下的广告
- **join_key**: account_id

## source_tables
- - **table_id**: kscdm.dim_ks_ug_adid_all
- **usage**: 从广告维度表提取账号信息