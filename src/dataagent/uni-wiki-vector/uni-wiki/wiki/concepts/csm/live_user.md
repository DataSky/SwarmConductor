---
title: 直播观众
domain: csm
tags: [entitie, csm, entity]
---
# 直播观众

直播观众属性实体，标识新直播观众

## primary_key
- - **name**: user_id
- **type**: bigint
- **description**: 直播观众唯一标识

## attributes
- - **name**: is_new_live_audience
- **type**: int
- **description**: 是否新直播观众
- **category**: status
- **table_sources**:   -     - **table_id**: ks_dws.party_ksprod_live_user_play_df
    - **description**: 是否新直播观众

## source_tables
- - **table_id**: ks_dws.party_ksprod_live_user_play_df
- **usage**: 直播用户播放数据主表

## business_notes
- 新直播观众定义：首次观看直播日期等于当天日期（substr(first_play_live_datetime,1,10) = '{{ ds }}'）
- 必须过滤 user_id > 0
- 新直播观众定义：首次播放直播日期等于当天日期 substr(first_play_live_datetime,1,10) = '{{ ds }}'
- 新直播观众定义：首次观看直播日期等于当天（substr(first_play_live_datetime,1,10) = ds）

## relationships