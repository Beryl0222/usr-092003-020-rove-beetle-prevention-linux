"use strict";

// 隐翅虫环境防控巡查 —— 数据模型与存储层
// 仅使用 Node 内置模块；数据保存在内存中，可选落盘为 JSON，便于演练与测试重置。

const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");

// 隐翅虫活跃期：初夏到深秋（按月判定，4-10 月覆盖初夏至深秋，核心活跃 5-9 月）
const ACTIVE_MONTHS = [4, 5, 6, 7, 8, 9, 10];

const SITE_TYPES = ["school", "community_garden", "waterside_greenbelt"];
const MEASURE_TYPES = ["light_adjust", "cleanup", "seal", "disinfest"];
// 调光、清理、封堵属于环境防控；消杀可能伤害其他生物，须区级额外人工审批
const DISINFEST = "disinfest";

const WORK_ORDER_STATUS = [
  "pending_confirm", // 风险点等待现场核查
  "confirmed",       // 已人工确认，措施待安排
  "scheduled",       // 已排期
  "implemented",     // 已实施，待复查
  "verified",        // 复查通过，闭环
  "failed",          // 复查失效
  "cancelled",       // 核查后排除，取消
];

function nowIso() {
  return new Date().toISOString();
}

function genId(prefix) {
  return prefix + "_" + crypto.randomBytes(6).toString("hex");
}

function monthOf(iso) {
  return Number(iso.slice(5, 7));
}

function hoursBetween(aIso, bIso) {
  return Math.abs(new Date(bIso).getTime() - new Date(aIso).getTime()) / 36e5;
}

function isActiveSeason(iso) {
  return ACTIVE_MONTHS.includes(monthOf(iso));
}

// 简易 SHA-256，用于照片内容去重；未上传照片时返回 null
function photoSha(bytesB64OrText) {
  if (!bytesB64OrText) return null;
  return crypto.createHash("sha256").update(String(bytesB64OrText)).digest("hex");
}

function createStore(options = {}) {
  const data = {
    meta: { createdAt: nowIso() },
    // 辖区
    jurisdictions: [], // {id, name, kind: district|school|property, districtId?}
    // 用户（演示用令牌映射；真实系统应走认证服务）
    users: [], // {id, name, role: district|field|school|property, jurisdictionId}
    // 点位（学校/社区花园/临水绿化带）
    sites: [], // {id, jurisdictionId, name, type, lat, lng, addressDetail}
    // 灯具
    lights: [], // {id, siteId, lampType: uv|white_strong|warm_shielded|sodium, wattage, phototaxisRisk, status}
    // 纱窗设施
    screens: [], // {id, siteId, location, intact: bool, lastCheckedAt}
    // 绿化与水体
    environments: [], // {id, siteId, hasWaterbody, waterbodyType, vegetationDensity, mulchAccumulation, notes}
    // 气象观测（按辖区、时段）
    weather: [], // {id, jurisdictionId, at, tempC, humidityPct, rainfallMm, rainEndedAt?}
    // 诱捕点计数
    trapCounts: [], // {id, siteId, at, trapCount, observer, createdAt}
    // 公众匿名发现记录（不含住址细节，仅区域级位置）
    publicReports: [], // {id, jurisdictionId, siteId?, at, photoSha?, contact?, status, mergedInto?, createdAt}
    // 巡查记录（现场人员）
    inspections: [], // {id, routeId, siteId, jurisdictionId, inspectorId, at, findings, photoSha?, supersedes?, createdAt}
    // 风险预警（规则引擎产生，全部为"待核查"）
    alerts: [],
    // 现场核查确认
    confirmations: [],
    // 工单
    workOrders: [],
    // 工单措施流转留痕
    workOrderEvents: [],
    // 预防提示（公众可见，区级编制）
    advisories: [],
    // 去重索引：照片 sha -> 首次出现的记录定位
    photoIndex: {}, // sha -> {kind, id}
  };

  const store = {
    data,
    constants: {
      ACTIVE_MONTHS,
      SITE_TYPES,
      MEASURE_TYPES,
      DISINFEST,
      WORK_ORDER_STATUS,
    },
    genId,
    nowIso,
    monthOf,
    hoursBetween,
    isActiveSeason,
    photoSha,

    reset() {
      for (const key of Object.keys(data)) {
        if (Array.isArray(data[key])) data[key].length = 0;
        else if (key === "photoIndex") for (const k of Object.keys(data[key])) delete data[key][k];
        else if (key === "meta") data[key].createdAt = nowIso();
      }
    },

    // ---- 基础增查 ----
    add(kind, record) {
      const coll = data[kind];
      coll.push(record);
      return record;
    },
    find(kind, predicate) {
      return data[kind].filter(predicate);
    },
    one(kind, predicate) {
      return data[kind].find(predicate) || null;
    },
    byId(kind, id) {
      return data[kind].find((r) => r.id === id) || null;
    },

    // ---- 照片去重登记 ----
    // 返回 {duplicate: bool, of?: {kind,id}}；同一 sha 只登记一次
    registerPhoto(sha, kind, id) {
      if (!sha) return { duplicate: false };
      if (data.photoIndex[sha]) return { duplicate: true, of: data.photoIndex[sha] };
      data.photoIndex[sha] = { kind, id };
      return { duplicate: false };
    },
    photoFirstSeen(sha) {
      return (sha && data.photoIndex[sha]) || null;
    },

    // ---- 工单事件留痕 ----
    logWorkOrderEvent(workOrderId, type, payload = {}, actorId) {
      const event = {
        id: genId("evt"),
        workOrderId,
        type, // created|confirmed|scheduled|implemented|verified|failed|disinfest_approved|disinfest_rejected|cancelled
        at: nowIso(),
        actorId: actorId || null,
        payload,
      };
      data.workOrderEvents.push(event);
      return event;
    },

    // ---- 持久化（可选）----
    snapshot() {
      return JSON.stringify(data, null, 2);
    },
    loadSnapshot(text) {
      const parsed = JSON.parse(text);
      store.reset();
      Object.assign(data, parsed);
    },
    saveToFile(file) {
      fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
      fs.writeFileSync(file, store.snapshot());
    },
    loadFromFile(file) {
      store.loadSnapshot(fs.readFileSync(file, "utf8"));
    },
  };

  return store;
}

// 演练种子数据：一个区级辖区，下辖学校与物业辖区，各有点位
function seed(store, now = nowIso()) {
  const district = { id: "j_district", name: "滨江区爱国卫生办公室", kind: "district" };
  const schoolJ = { id: "j_school", name: "滨江第一中学", kind: "school", districtId: "j_district" };
  const propJ = { id: "j_property", name: "临江花园物业", kind: "property", districtId: "j_district" };
  store.add("jurisdictions", district);
  store.add("jurisdictions", schoolJ);
  store.add("jurisdictions", propJ);

  store.add("users", { id: "u_district", name: "区管理员", role: "district", jurisdictionId: "j_district" });
  store.add("users", { id: "u_field1", name: "巡查员小李", role: "field", jurisdictionId: "j_district" });
  store.add("users", { id: "u_school", name: "校方联络员", role: "school", jurisdictionId: "j_school" });
  store.add("users", { id: "u_property", name: "物业王经理", role: "property", jurisdictionId: "j_property" });

  const schoolSite = {
    id: "s_school_lamp", jurisdictionId: "j_school", name: "一中操场路灯带",
    type: "school", lat: 30.21, lng: 120.12, addressDetail: "（内部点位明细，不对外公开）",
  };
  const gardenSite = {
    id: "s_garden", jurisdictionId: "j_property", name: "临江社区花园",
    type: "community_garden", lat: 30.20, lng: 120.13, addressDetail: "（内部点位明细，不对外公开）",
  };
  const waterSite = {
    id: "s_waterside", jurisdictionId: "j_property", name: "临河绿化带北段",
    type: "waterside_greenbelt", lat: 30.19, lng: 120.11, addressDetail: "（内部点位明细，不对外公开）",
  };
  for (const s of [schoolSite, gardenSite, waterSite]) store.add("sites", s);

  store.add("lights", { id: "l1", siteId: "s_school_lamp", lampType: "white_strong", wattage: 200, phototaxisRisk: "high", status: "on" });
  store.add("lights", { id: "l2", siteId: "s_garden", lampType: "uv", wattage: 40, phototaxisRisk: "high", status: "on" });
  store.add("lights", { id: "l3", siteId: "s_waterside", lampType: "warm_shielded", wattage: 60, phototaxisRisk: "low", status: "on" });

  store.add("screens", { id: "sc1", siteId: "s_school_lamp", location: "教学楼一层连廊", intact: false, lastCheckedAt: null });
  store.add("screens", { id: "sc2", siteId: "s_garden", location: "物业用房窗", intact: true, lastCheckedAt: now });

  store.add("environments", { id: "e1", siteId: "s_school_lamp", hasWaterbody: false, waterbodyType: null, vegetationDensity: "medium", mulchAccumulation: true, notes: "落叶堆积" });
  store.add("environments", { id: "e2", siteId: "s_garden", hasWaterbody: true, waterbodyType: "pond", vegetationDensity: "high", mulchAccumulation: true, notes: "景观水池" });
  store.add("environments", { id: "e3", siteId: "s_waterside", hasWaterbody: true, waterbodyType: "river", vegetationDensity: "high", mulchAccumulation: false, notes: null });

  store.add("advisories", {
    id: "a_default",
    title: "隐翅虫防范提示",
    body: "隐翅虫活跃于夏秋季节且具趋光性，夜间请减少强光直射、关好纱窗；如虫体落于皮肤，勿拍打，应吹离并用清水冲洗。",
    publishedAt: now,
  });

  return store;
}

module.exports = {
  createStore,
  seed,
  ACTIVE_MONTHS,
  SITE_TYPES,
  MEASURE_TYPES,
  DISINFEST,
  WORK_ORDER_STATUS,
  isActiveSeason,
  photoSha,
  genId,
  nowIso,
};
