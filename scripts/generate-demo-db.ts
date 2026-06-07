#!/usr/bin/env bun
/**
 * generate-demo-db.ts
 *
 * 生成 DataSky 风格测试数据库，模拟短视频平台核心业务场景：
 *   - authors         主播/创作者（500人）
 *   - live_rooms      直播间记录（~8000场，2024全年）
 *   - gifts           打赏/送礼事件（~50000条）
 *   - videos          短视频（~3000条）
 *   - orders          电商订单（~15000条）
 *   - ads_campaigns   广告投放（~2000条）
 *   - dau_daily       每日活跃用户统计（365天）
 *
 * 用法: bun run scripts/generate-demo-db.ts [output-path]
 * 默认输出: ./datasky-demo.duckdb
 */

import { DuckDBInstance } from "@duckdb/node-api"
import { rmSync } from "fs"

const OUT = process.argv[2] ?? "./datasky-demo.duckdb"
rmSync(OUT, { force: true })

console.log(`[gen] 创建数据库: ${OUT}`)
const db = await DuckDBInstance.create(OUT)
const c = await db.connect()

// ─── Helper utilities ─────────────────────────────────────────────────────────

const rng = (() => {
  let seed = 42
  return () => {
    seed = (seed * 1664525 + 1013904223) & 0xffffffff
    return Math.abs(seed) / 0xffffffff
  }
})()

function ri(min: number, max: number) { return Math.floor(rng() * (max - min + 1)) + min }
function rf(min: number, max: number, dp = 2) { return parseFloat((rng() * (max - min) + min).toFixed(dp)) }
function pick<T>(arr: T[]): T { return arr[ri(0, arr.length - 1)]! }

// Generate dates throughout 2024
function randomDate(start = "2024-01-01", end = "2024-12-31"): string {
  const s = new Date(start).getTime()
  const e = new Date(end).getTime()
  return new Date(s + rng() * (e - s)).toISOString().slice(0, 10)
}

function addDays(date: string, days: number): string {
  const d = new Date(date)
  d.setDate(d.getDate() + days)
  return d.toISOString().slice(0, 10)
}

// ─── Reference data ────────────────────────────────────────────────────────────

const REGIONS = ["华北", "华东", "华南", "华中", "西南", "西北", "东北"]
const TIERS = ["S", "A", "B", "C", "D"]           // 主播等级（S最高）
const LIVE_TYPES = ["秀场", "电商", "游戏", "本地生活", "才艺"]
const PRODUCT_CATS = ["服装", "美妆", "食品", "电子", "家居", "运动", "母婴"]
const AD_TYPES = ["信息流", "开屏", "品牌曝光", "搜索竞价", "直播推广"]
const GIFT_NAMES = ["玫瑰", "火箭", "嘉年华", "城堡", "超跑", "宇宙飞船", "荧光棒", "小心心"]
const GIFT_VALUES = [1, 5, 10, 52, 100, 520, 1000, 5000]  // 单位：分

// ─── 1. Authors (主播/创作者) ──────────────────────────────────────────────────

console.log("[gen] authors (500) ...")
await c.run(`
  CREATE TABLE authors (
    author_id    BIGINT PRIMARY KEY,
    author_name  VARCHAR,
    region       VARCHAR,
    tier         VARCHAR,
    fans_count   BIGINT,
    joined_date  DATE,
    is_signed    BOOLEAN,    -- 是否签约达人
    is_active    BOOLEAN,    -- 近30日活跃
    monthly_gmv  DECIMAL(14,2),  -- 近30日电商GMV（分）
    content_type VARCHAR     -- 主要内容方向
  )
`)

const authorRows: string[] = []
for (let i = 1; i <= 500; i++) {
  const tier = rng() < 0.05 ? "S" : rng() < 0.15 ? "A" : rng() < 0.35 ? "B" : rng() < 0.65 ? "C" : "D"
  const fansMult = { S: ri(500000, 5000000), A: ri(100000, 500000), B: ri(10000, 100000), C: ri(1000, 10000), D: ri(100, 1000) }
  const fans = fansMult[tier as keyof typeof fansMult] ?? ri(100, 1000)
  const gmv = tier === "S" ? rf(100000, 1000000) : tier === "A" ? rf(10000, 100000) : tier === "B" ? rf(1000, 10000) : rf(0, 1000)
  authorRows.push(`(${i}, '主播${i.toString().padStart(4,"0")}', '${pick(REGIONS)}', '${tier}', ${fans}, '${randomDate("2020-01-01","2024-06-01")}', ${rng() < 0.3}, ${rng() < 0.7}, ${gmv.toFixed(2)}, '${pick(LIVE_TYPES)}')`)
}
await c.run(`INSERT INTO authors VALUES ${authorRows.join(",")}`)

// ─── 2. Live Rooms (直播间) ────────────────────────────────────────────────────

console.log("[gen] live_rooms (~8000) ...")
await c.run(`
  CREATE TABLE live_rooms (
    live_id        BIGINT PRIMARY KEY,
    author_id      BIGINT,
    live_date      DATE,
    start_hour     INTEGER,
    duration_min   INTEGER,    -- 时长（分钟）
    live_type      VARCHAR,
    peak_viewers   BIGINT,     -- 峰值在线人数
    total_viewers  BIGINT,     -- 累计观看人数
    gift_revenue   DECIMAL(14,2),  -- 打赏收入（分）
    gmv            DECIMAL(14,2),  -- 电商GMV（分）
    is_field       BOOLEAN,    -- 是否内容场（非电商）
    region         VARCHAR
  )
`)

let liveId = 1
const liveRoomRows: string[] = []

// Generate ~8000 live sessions distributed across 2024
// More active authors stream more often
for (let authorId = 1; authorId <= 500; authorId++) {
  // Determine stream frequency based on tier
  const tier = authorRows[authorId - 1]!.match(/'([SABCD])'/)![1]!
  const streamsPerMonth = tier === "S" ? ri(15, 25) : tier === "A" ? ri(8, 15) : tier === "B" ? ri(4, 8) : tier === "C" ? ri(1, 4) : ri(0, 2)
  const totalStreams = Math.floor(streamsPerMonth * 12 * (0.7 + rng() * 0.6))

  for (let s = 0; s < totalStreams; s++) {
    const date = randomDate()
    const liveType = pick(LIVE_TYPES)
    const isEco = liveType === "电商"
    const viewers = tier === "S" ? ri(5000, 50000) : tier === "A" ? ri(500, 5000) : ri(50, 500)
    const giftRev = rf(viewers * 0.1, viewers * 2)
    const gmv = isEco ? rf(viewers * 0.5, viewers * 10) : 0

    liveRoomRows.push(
      `(${liveId++}, ${authorId}, '${date}', ${ri(8,23)}, ${ri(30, 240)}, '${liveType}', ` +
      `${viewers}, ${Math.floor(viewers * rf(1.5, 5))}, ` +
      `${giftRev.toFixed(2)}, ${gmv.toFixed(2)}, ${!isEco}, '${pick(REGIONS)}')`
    )

    if (liveRoomRows.length >= 500) {
      await c.run(`INSERT INTO live_rooms VALUES ${liveRoomRows.join(",")}`)
      liveRoomRows.length = 0
    }
  }
}
if (liveRoomRows.length > 0) {
  await c.run(`INSERT INTO live_rooms VALUES ${liveRoomRows.join(",")}`)
}
const { live_count } = (await c.runAndReadAll("SELECT COUNT(*) as live_count FROM live_rooms")).getRowObjects()[0] as { live_count: bigint }
console.log(`  → ${Number(live_count)} 条直播记录`)

// ─── 3. Gifts (打赏事件) ────────────────────────────────────────────────────────

console.log("[gen] gifts (~30000) ...")
await c.run(`
  CREATE TABLE gifts (
    gift_id      BIGINT PRIMARY KEY,
    live_id      BIGINT,
    author_id    BIGINT,
    user_id      BIGINT,
    gift_name    VARCHAR,
    gift_value   INTEGER,    -- 单价（分）
    quantity     INTEGER,
    total_value  INTEGER,    -- 总价值（分）
    gift_date    DATE,
    gift_hour    INTEGER
  )
`)

// Sample 30% of live rooms to generate gift events
const liveIdMax = Number(live_count)
const giftRows: string[] = []
let giftId = 1

for (let i = 0; i < 30000; i++) {
  const liveRef = ri(1, liveIdMax)
  const giftIdx = ri(0, GIFT_NAMES.length - 1)
  const qty = ri(1, 50)
  const val = GIFT_VALUES[giftIdx]!
  giftRows.push(
    `(${giftId++}, ${liveRef}, ${ri(1,500)}, ${ri(10001,50000)}, '${GIFT_NAMES[giftIdx]}', ${val}, ${qty}, ${val * qty}, '${randomDate()}', ${ri(8,23)})`
  )
  if (giftRows.length >= 1000) {
    await c.run(`INSERT INTO gifts VALUES ${giftRows.join(",")}`)
    giftRows.length = 0
  }
}
if (giftRows.length > 0) await c.run(`INSERT INTO gifts VALUES ${giftRows.join(",")}`)

// ─── 4. Videos (短视频) ────────────────────────────────────────────────────────

console.log("[gen] videos (~3000) ...")
await c.run(`
  CREATE TABLE videos (
    video_id       BIGINT PRIMARY KEY,
    author_id      BIGINT,
    publish_date   DATE,
    duration_sec   INTEGER,
    category       VARCHAR,
    vv_count       BIGINT,   -- 播放量
    like_count     BIGINT,
    share_count    BIGINT,
    comment_count  BIGINT,
    has_product    BOOLEAN,  -- 是否挂车（电商短视频）
    gmv            DECIMAL(14,2)
  )
`)

const videoRows: string[] = []
for (let i = 1; i <= 3000; i++) {
  const authorId = ri(1, 500)
  const vv = ri(1000, 5000000)
  const hasProduct = rng() < 0.3
  videoRows.push(
    `(${i}, ${authorId}, '${randomDate()}', ${ri(15,300)}, '${pick(PRODUCT_CATS)}', ` +
    `${vv}, ${Math.floor(vv * rf(0.05, 0.2))}, ${Math.floor(vv * rf(0.01, 0.05))}, ` +
    `${Math.floor(vv * rf(0.005, 0.03))}, ${hasProduct}, ${hasProduct ? rf(0, vv * 0.5).toFixed(2) : 0})`
  )
  if (videoRows.length >= 500) {
    await c.run(`INSERT INTO videos VALUES ${videoRows.join(",")}`)
    videoRows.length = 0
  }
}
if (videoRows.length > 0) await c.run(`INSERT INTO videos VALUES ${videoRows.join(",")}`)

// ─── 5. Orders (电商订单) ──────────────────────────────────────────────────────

console.log("[gen] orders (~15000) ...")
await c.run(`
  CREATE TABLE orders (
    order_id      BIGINT PRIMARY KEY,
    author_id     BIGINT,
    user_id       BIGINT,
    product_name  VARCHAR,
    category      VARCHAR,
    region        VARCHAR,
    order_date    DATE,
    quantity      INTEGER,
    unit_price    DECIMAL(10,2),
    gmv           DECIMAL(12,2),
    payment_gmv   DECIMAL(12,2),
    is_paid       BOOLEAN,
    source        VARCHAR
  )
`)

const productsByCat: Record<string, string[]> = {
  "服装": ["连衣裙", "T恤", "羽绒服", "牛仔裤", "卫衣"],
  "美妆": ["口红", "粉底液", "眼影盘", "防晒霜", "精华液"],
  "食品": ["零食大礼包", "坚果礼盒", "冲泡咖啡", "茶叶", "牛肉干"],
  "电子": ["耳机", "充电宝", "手机壳", "智能手表", "蓝牙音箱"],
  "家居": ["收纳盒", "床上四件套", "香薰蜡烛", "抱枕", "置物架"],
  "运动": ["瑜伽垫", "运动水壶", "跑步鞋", "健身手套", "泡沫轴"],
  "母婴": ["纸尿裤", "婴儿辅食", "玩具积木", "婴儿湿巾", "安抚奶嘴"],
}

const orderRows: string[] = []
for (let i = 1; i <= 15000; i++) {
  const cat = pick(PRODUCT_CATS)
  const products = productsByCat[cat]!
  const product = pick(products)
  const price = rf(9.9, 999, 2)
  const qty = ri(1, 5)
  const gmv = parseFloat((price * qty).toFixed(2))
  const isPaid = rng() < 0.75
  const paymentGmv = isPaid ? parseFloat((gmv * rf(0.9, 1.0)).toFixed(2)) : 0
  const source = rng() < 0.6 ? "live" : rng() < 0.8 ? "video" : "search"

  orderRows.push(
    `(${i}, ${ri(1,500)}, ${ri(10001,100000)}, '${product}', '${cat}', '${pick(REGIONS)}', '${randomDate()}', ` +
    `${qty}, ${price}, ${gmv}, ${paymentGmv}, ${isPaid}, '${source}')`
  )
  if (orderRows.length >= 500) {
    await c.run(`INSERT INTO orders VALUES ${orderRows.join(",")}`)
    orderRows.length = 0
  }
}
if (orderRows.length > 0) await c.run(`INSERT INTO orders VALUES ${orderRows.join(",")}`)

// ─── 6. Ads Campaigns (广告投放) ──────────────────────────────────────────────

console.log("[gen] ads_campaigns (~2000) ...")
await c.run(`
  CREATE TABLE ads_campaigns (
    campaign_id   BIGINT PRIMARY KEY,
    advertiser_id BIGINT,
    campaign_name VARCHAR,
    ad_type       VARCHAR,
    start_date    DATE,
    end_date      DATE,
    budget        DECIMAL(12,2),  -- 预算（分）
    spend         DECIMAL(12,2),  -- 实际消耗（分）
    impressions   BIGINT,
    clicks        BIGINT,
    conversions   BIGINT,
    region        VARCHAR
  )
`)

const adsRows: string[] = []
for (let i = 1; i <= 2000; i++) {
  const start = randomDate("2024-01-01", "2024-11-01")
  const end = addDays(start, ri(3, 30))
  const budget = rf(1000, 500000, 2)
  const spend = parseFloat((budget * rf(0.5, 0.99)).toFixed(2))
  const impressions = ri(10000, 10000000)
  const clicks = Math.floor(impressions * rf(0.005, 0.05))
  const conversions = Math.floor(clicks * rf(0.02, 0.15))

  adsRows.push(
    `(${i}, ${ri(1,200)}, '投放计划${i}', '${pick(AD_TYPES)}', '${start}', '${end}', ` +
    `${budget}, ${spend}, ${impressions}, ${clicks}, ${conversions}, '${pick(REGIONS)}')`
  )
  if (adsRows.length >= 500) {
    await c.run(`INSERT INTO ads_campaigns VALUES ${adsRows.join(",")}`)
    adsRows.length = 0
  }
}
if (adsRows.length > 0) await c.run(`INSERT INTO ads_campaigns VALUES ${adsRows.join(",")}`)

// ─── 7. DAU Daily (每日活跃用户) ─────────────────────────────────────────────

console.log("[gen] dau_daily (365 days) ...")
await c.run(`
  CREATE TABLE dau_daily (
    stat_date      DATE PRIMARY KEY,
    dau            BIGINT,    -- 日活用户数
    new_users      BIGINT,    -- 新增用户
    live_dau       BIGINT,    -- 观看直播的日活
    video_dau      BIGINT,    -- 看短视频的日活
    paying_users   BIGINT,    -- 付费用户数
    total_revenue  DECIMAL(14,2),  -- 总营收（分）
    live_revenue   DECIMAL(14,2),  -- 直播营收（打赏+电商）
    ad_revenue     DECIMAL(14,2)   -- 广告营收
  )
`)

const dauRows: string[] = []
const baseDAU = 5000000  // 500万基础日活
for (let day = 0; day < 365; day++) {
  const date = addDays("2024-01-01", day)
  const weekday = new Date(date).getDay()
  const isWeekend = weekday === 0 || weekday === 6

  // Seasonal trends: spring festival spike, summer dip, double-11 spike
  const month = parseInt(date.slice(5, 7))
  const seasonMult = month === 2 ? 1.3 : month === 7 ? 0.9 : month === 8 ? 0.85 : month === 11 ? 1.25 : 1.0
  const weekendMult = isWeekend ? 1.15 : 1.0
  const noise = 0.95 + rng() * 0.1

  const dau = Math.floor(baseDAU * seasonMult * weekendMult * noise)
  const newUsers = Math.floor(dau * rf(0.02, 0.05))
  const liveDau = Math.floor(dau * rf(0.15, 0.25))
  const videoDau = Math.floor(dau * rf(0.60, 0.80))
  const payingUsers = Math.floor(dau * rf(0.005, 0.02))
  const liveRev = parseFloat((liveDau * rf(0.5, 2.0)).toFixed(2))
  const adRev = parseFloat((dau * rf(0.1, 0.3)).toFixed(2))
  const totalRev = parseFloat((liveRev + adRev).toFixed(2))

  dauRows.push(`('${date}', ${dau}, ${newUsers}, ${liveDau}, ${videoDau}, ${payingUsers}, ${totalRev}, ${liveRev}, ${adRev})`)
}
await c.run(`INSERT INTO dau_daily VALUES ${dauRows.join(",")}`)

// ─── Done — print summary ──────────────────────────────────────────────────────

await c.run("VACUUM ANALYZE")

console.log("\n[gen] ✅ 完成！数据库摘要：")
const tables = ["authors", "live_rooms", "gifts", "videos", "orders", "ads_campaigns", "dau_daily"]
for (const t of tables) {
  const r = (await c.runAndReadAll(`SELECT COUNT(*) as n FROM ${t}`)).getRowObjects()[0] as { n: bigint }
  console.log(`  ${t.padEnd(15)} ${Number(r.n).toLocaleString()} 行`)
}

console.log(`\n  输出路径: ${OUT}`)
c.closeSync()
db.closeSync()
