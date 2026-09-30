"use strict";

// 领域模型与内存存储：区域、设施、气象、诱捕、巡查、公众发现、
// 风险点位、工单与预防提示。可选 JSON 文件持久化（DATA_FILE）。

const { randomUUID } = require("node:crypto");
const fs = require("node:fs/promises");

function newId(prefix) {
  return prefix + "_" + randomUUID().replace(/-/g, "").slice(0, 12);
}

const COLLECTIONS = [
  "accounts",
  "areas",
  "traps",
  "lamps",
  "screens",
  "waterSites",
  "weatherReadings",
  "trapCounts",
  "patrolRecords",
  "publicReports",
  "reportClusters",
  "riskRuns",
  "riskPoints",
  "workOrders",
  "advisories",
];

class Store {
  constructor() {
    this.accounts = new Map();
    this.areas = new Map();
    this.traps = [];
    this.lamps = [];
    this.screens = [];
    this.waterSites = [];
    this.weatherReadings = [];
    this.trapCounts = [];
    this.patrolRecords = [];
    this.publicReports = [];
    this.reportClusters = [];
    this.riskRuns = [];
    this.riskPoints = [];
    this.workOrders = [];
    this.advisories = [];
  }

  // ---- 账号与辖区 ----
  addAccount(account) {
    const record = {
      id: account.id || newId("acct"),
      name: account.name,
      role: account.role, // district | inspector | school | property
      areaIds: account.areaIds || [],
      token: account.token,
      createdAt: account.createdAt || new Date().toISOString(),
    };
    this.accounts.set(record.token, record);
    return record;
  }

  accountByToken(token) {
    return token ? this.accounts.get(token) || null : null;
  }

  // ---- 区域 ----
  addArea(input) {
    const area = {
      id: input.id || newId("area"),
      name: input.name,
      kind: input.kind, // school | community | greenbelt | waterside
      district: input.district || "本区",
      lat: round(input.lat, 6),
      lng: round(input.lng, 6),
      createdAt: input.createdAt || new Date().toISOString(),
    };
    this.areas.set(area.id, area);
    return area;
  }

  getArea(id) {
    return this.areas.get(id) || null;
  }

  // ---- 设施 ----
  addTrap(input) {
    const trap = {
      id: input.id || newId("trap"),
      areaId: input.areaId,
      name: input.name,
      lat: round(input.lat, 6),
      lng: round(input.lng, 6),
      active: input.active !== false,
      createdAt: nowIso(input.createdAt),
    };
    this.traps.push(trap);
    return trap;
  }

  addLamp(input) {
    const lamp = {
      id: input.id || newId("lamp"),
      areaId: input.areaId,
      name: input.name,
      lat: round(input.lat, 6),
      lng: round(input.lng, 6),
      // uv_adhesive 诱虫灯 | white_strong 强白光 | warm_led 暖光 | sodium 钠灯
      lampType: input.lampType,
      wattage: input.wattage ?? null,
      nightHours: input.nightHours ?? null,
      // adjusted 表示已按建议调光（降功率/改暖色/加挡光/缩短时长）
      adjusted: input.adjusted === true,
      createdAt: nowIso(input.createdAt),
    };
    this.lamps.push(lamp);
    return lamp;
  }

  updateLamp(id, patch) {
    const lamp = this.lamps.find((item) => item.id === id);
    if (!lamp) return null;
    for (const key of ["lampType", "wattage", "nightHours", "adjusted"]) {
      if (patch[key] !== undefined) lamp[key] = patch[key];
    }
    return lamp;
  }

  addScreen(input) {
    const screen = {
      id: input.id || newId("screen"),
      areaId: input.areaId,
      name: input.name,
      facilityKind: input.facilityKind || "window", // window | door | vent
      lat: round(input.lat, 6),
      lng: round(input.lng, 6),
      intact: input.intact !== false,
      damageNote: input.damageNote || null,
      damagedSince: input.intact === false ? nowIso(input.damagedSince) : null,
      lastCheckedAt: nowIso(input.lastCheckedAt),
      createdAt: nowIso(input.createdAt),
    };
    this.screens.push(screen);
    return screen;
  }

  updateScreen(id, patch, at = new Date().toISOString()) {
    const screen = this.screens.find((item) => item.id === id);
    if (!screen) return null;
    if (patch.intact !== undefined) {
      if (patch.intact && !screen.intact) screen.damagedSince = null;
      if (!patch.intact && screen.intact) screen.damagedSince = at;
      screen.intact = patch.intact;
    }
    if (patch.damageNote !== undefined) screen.damageNote = patch.damageNote;
    screen.lastCheckedAt = at;
    return screen;
  }

  addWaterSite(input) {
    const site = {
      id: input.id || newId("water"),
      areaId: input.areaId,
      name: input.name,
      kind: input.kind || "greenbelt", // pond | flowerbed | drain | greenbelt
      lat: round(input.lat, 6),
      lng: round(input.lng, 6),
      standingWater: input.standingWater === true,
      tidy: input.tidy !== false,
      lastCheckedAt: nowIso(input.lastCheckedAt),
      createdAt: nowIso(input.createdAt),
    };
    this.waterSites.push(site);
    return site;
  }

  updateWaterSite(id, patch, at = new Date().toISOString()) {
    const site = this.waterSites.find((item) => item.id === id);
    if (!site) return null;
    for (const key of ["standingWater", "tidy", "kind"]) {
      if (patch[key] !== undefined) site[key] = patch[key];
    }
    site.lastCheckedAt = at;
    return site;
  }

  // ---- 气象 ----
  addWeather(input) {
    const reading = {
      id: input.id || newId("wx"),
      areaId: input.areaId,
      observedAt: canonicalTime(input.observedAt),
      rainfallMm: numberOrNull(input.rainfallMm),
      tempC: numberOrNull(input.tempC),
      humidityPct: numberOrNull(input.humidityPct),
      source: input.source || "manual",
    };
    this.weatherReadings.push(reading);
    this.weatherReadings.sort((a, b) => a.observedAt.localeCompare(b.observedAt));
    return reading;
  }

  // ---- 诱捕计数 ----
  addTrapCount(input) {
    const count = {
      id: input.id || newId("tc"),
      trapId: input.trapId,
      areaId: input.areaId,
      capturedAt: canonicalTime(input.capturedAt),
      count: Number(input.count),
      note: input.note || null,
    };
    this.trapCounts.push(count);
    this.trapCounts.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
    return count;
  }

  // ---- 巡查记录（同一巡查路线补传按批次合并）----
  addPatrolRecord(record) {
    this.patrolRecords.push(record);
    return record;
  }

  // ---- 公众发现 ----
  addPublicReport(report) {
    this.publicReports.push(report);
    return report;
  }

  addReportCluster(cluster) {
    this.reportClusters.push(cluster);
    return cluster;
  }

  findReportCluster(id) {
    return this.reportClusters.find((item) => item.id === id) || null;
  }

  // ---- 风险运行与点位 ----
  addRiskRun(run) {
    this.riskRuns.push(run);
    return run;
  }

  upsertRiskPoint(point) {
    const existing = this.riskPoints.find(
      (item) => item.dedupKey === point.dedupKey && item.areaId === point.areaId,
    );
    if (existing) {
      if (existing.status !== "pending_verification") return existing;
      existing.level = point.level;
      existing.score = point.score;
      existing.reasons = point.reasons;
      existing.evidence = point.evidence;
      existing.suggestedMeasures = point.suggestedMeasures;
      existing.updatedAt = point.generatedAt;
      existing.runId = point.runId;
      return existing;
    }
    this.riskPoints.push(point);
    return point;
  }

  getRiskPoint(id) {
    return this.riskPoints.find((item) => item.id === id) || null;
  }

  // ---- 工单 ----
  addWorkOrder(order) {
    this.workOrders.push(order);
    return order;
  }

  getWorkOrder(id) {
    return this.workOrders.find((item) => item.id === id) || null;
  }

  // ---- 预防提示 ----
  addAdvisory(advisory) {
    this.advisories.push(advisory);
    return advisory;
  }

  // ---- 持久化 ----
  toJSON() {
    const data = { version: 1 };
    for (const name of COLLECTIONS) {
      if (name === "accounts") {
        data.accounts = [...this.accounts.values()];
      } else if (name === "areas") {
        data.areas = [...this.areas.values()];
      } else {
        data[name] = this[name];
      }
    }
    return data;
  }

  static fromJSON(data) {
    const store = new Store();
    for (const account of data.accounts || []) store.accounts.set(account.token, account);
    for (const area of data.areas || []) store.areas.set(area.id, area);
    for (const name of COLLECTIONS.slice(2)) {
      store[name] = Array.isArray(data[name]) ? data[name] : [];
    }
    return store;
  }

  async saveToFile(path) {
    const tmp = path + ".tmp";
    await fs.writeFile(tmp, JSON.stringify(this.toJSON(), null, 2), "utf8");
    await fs.rename(tmp, path);
  }

  static async loadOrCreate(path, seed) {
    if (path) {
      try {
        const raw = await fs.readFile(path, "utf8");
        return Store.fromJSON(JSON.parse(raw));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    const store = new Store();
    if (seed) seed(store);
    return store;
  }
}

function round(value, digits) {
  if (value === undefined || value === null || Number.isNaN(Number(value))) return null;
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
}

function numberOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function nowIso(value) {
  return value || new Date().toISOString();
}

function canonicalTime(value) {
  const ms = value === undefined ? Date.now() : Date.parse(value);
  if (Number.isNaN(ms)) {
    const error = new Error("时间格式无法解析: " + value);
    error.code = "BAD_TIME";
    throw error;
  }
  return new Date(ms).toISOString();
}

module.exports = { Store, newId, round, canonicalTime };
