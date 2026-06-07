---
title: 直播作者
domain: csm
tags: [entitie, csm, entity]
---
# 直播作者

直播作者实体，包含直播权限和作者类型信息

## primary_key
- - **name**: user_id
- **type**: bigint
- **description**: 直播作者唯一标识

## attributes
- - **name**: acu
- **type**: unknown
- **description**: ACU值
- **category**: metric
- **table_sources**:   -     - **table_id**: ks_dw_dim.party_ksprod_live_author_df
    - **description**: ACU值
- - **name**: author_acu_range
- **type**: unknown
- **description**: 作者ACU区间
- **category**: profile
- **table_sources**:   -     - **table_id**: ks_dw_dim.party_ksprod_live_author_df
    - **description**: 作者ACU区间
- - **name**: is_live_authority
- **type**: unknown
- **description**: 是否有直播权限
- **category**: status
- **table_sources**:   -     - **table_id**: ks_dw_dim.party_ksprod_live_author_df
    - **description**: 是否有直播权限
- - **name**: is_live_authority_now
- **type**: unknown
- **description**: 当前是否有直播权限
- **category**: status
- **table_sources**:   -     - **table_id**: ks_dw_dim.party_ksprod_live_author_df
    - **description**: 当前是否有直播权限
- - **name**: live_authority_status
- **type**: unknown
- **description**: 直播权限状态
- **category**: status
- **table_sources**:   -     - **table_id**: ks_dw_dim.party_ksprod_live_author_df
    - **description**: 直播权限状态
- - **name**: live_author_type
- **type**: unknown
- **description**: 直播作者类型
- **category**: type
- **table_sources**:   -     - **table_id**: ks_dw_dim.party_ksprod_live_author_df
    - **description**: 直播作者类型

## relationships
- - **target_entity**: user
- **join_key**: user_id
- **type**: one_to_one
- **description**: 直播作者对应用户

## source_tables
- - **table_id**: ks_dw_dim.party_ksprod_live_author_df
- **usage**: 直播作者维度表

## business_notes
- 通过left join方式关联
- author_id重命名为user_id
- 通过left join关联到主表
- 通过left join关联
- author_type重命名为live_author_type
- acu_range重命名为author_acu_range
- author_id重命名为user_id作为主键
- 按日期分区过滤: p_date = '{{ ds_nodash }}'
- 分区过滤条件: p_date = '{{ ds_nodash }}'