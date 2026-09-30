"use strict";

// 风险规则引擎：把气象、诱捕、去重后的公众目击、巡查观测与设施状态
// 汇总成“需要人工核查的风险点位”和环境性建议措施。
// 引擎只产出建议与证据链；不创建处置工单，更不会自动下达消杀。

const { newId } = require("./store");

const SEASON_MONTHS = [5, 6, 7, 8, 9, 10]; // 初夏至深秋（5-10 月）
const RAIN_WINDOW_MS = 48 * 60 * 60 * 1000;
const OBS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const CLUSTER_WINDOW_MS = 72 * 60 * 60 * 1000;

const RAIN_MM_THRESHOLD = 2;
const HUMIDITY_THRESHOLD = 70;
const TEMP_MIN = 18;
const TEMP_MAX = 33;

const MEASURES = Object.freeze({
  inspect_confirm: {
    code: "inspect_confirm",
    label: "现场核查虫种与孳生环境，确认前不实施处置",
  },
  dim_lamp: {
    code: "dim_lamp",
    label: "调整夜间趋光灯具：降功率、改暖色、缩短时长或加挡光",
  },
  seal_screen: {
    code: "seal_screen",
    label: "修补封堵破损纱窗、门缝与通风口",
  },
  clean_environment: {
    code: "clean_environment",
    label: "清理落叶腐殖与积水，整理临水绿化带",
  },
  // targeted_treatment 只能由区级人工授权后加入，规则引擎永不产出
});

function isActiveSeason(at) {
  return SEASON_MONTHS.includes(new Date(at).getMonth() + 1);
}

function within(atMs, value, windowMs) {
  return atMs - Date.parse(value) <= windowMs && Date.parse(value) <= atMs;
}

function weatherContext(store, areaId, atMs) {
  const readings = store.weatherReadings.filter(
    (r) => r.areaId === areaId && Date.parse(r.observedAt) <= atMs,
  );
  const recent48 = readings.filter((r) => atMs - Date.parse(r.observedAt) <= RAIN_WINDOW_MS);
  const latest = readings[readings.length - 1] || null;
  const rainTotal = recent48.reduce((sum, r) => sum + (r.rainfallMm || 0), 0);
  const rainedRecently = rainTotal >= RAIN_MM_THRESHOLD;
  const warmHumid = Boolean(
    latest &&
      latest.tempC !== null &&
      latest.humidityPct !== null &&
      latest.tempC >= TEMP_MIN &&
      latest.tempC <= TEMP_MAX &&
      latest.humidityPct >= HUMIDITY_THRESHOLD,
  );
  return {
    readings,
    recentIds: recent48.map((r) => r.id),
    latest,
    rainedRecently,
    warmHumid,
    rainTotal: round1(rainTotal),
  };
}

function trapTrend(store, areaId, atMs) {
  const counts = store.trapCounts.filter(
    (c) => c.areaId === areaId && Date.parse(c.capturedAt) <= atMs,
  );
  const byTrap = new Map();
  for (const c of counts) {
    if (!byTrap.has(c.trapId)) byTrap.set(c.trapId, []);
    byTrap.get(c.trapId).push(c);
  }
  const perTrap = [];
  let recentTotal = 0;
  let previousTotal = 0;
  for (const [trapId, list] of byTrap) {
    const recent = list.filter((c) => within(atMs, c.capturedAt, OBS_WINDOW_MS));
    const previous = list.filter(
      (c) =>
        atMs - Date.parse(c.capturedAt) > OBS_WINDOW_MS &&
        atMs - Date.parse(c.capturedAt) <= 2 * OBS_WINDOW_MS,
    );
    const recentSum = recent.reduce((s, c) => s + c.count, 0);
    const previousSum = previous.reduce((s, c) => s + c.count, 0);
    recentTotal += recentSum;
    previousTotal += previousSum;
    const rising = previousSum > 0 && recentSum >= previousSum * 1.5 && recentSum - previousSum >= 3;
    if (recent.length > 0) {
      perTrap.push({
        trapId,
        recentSum,
        previousSum,
        rising,
        recentIds: recent.map((c) => c.id),
      });
    }
  }
  const areaRising = previousTotal > 0 && recentTotal >= previousTotal * 1.5 && recentTotal - previousTotal >= 3;
  return { perTrap, recentTotal, previousTotal, areaRising };
}

function activeClusters(store, areaId, atMs) {
  return store.reportClusters.filter(
    (c) =>
      c.areaId === areaId &&
      atMs - Date.parse(c.lastSeenAt) <= CLUSTER_WINDOW_MS &&
      c.independentCount >= 2,
  );
}

// 巡查目击按网格聚合（记录进入时已做批次/照片去重）。
function patrolSightingCells(store, areaId, atMs) {
  const cells = new Map();
  for (const rec of store.patrolRecords) {
    if (rec.areaId !== areaId || rec.kind !== "sighting" || !rec.gridCell) continue;
    if (!within(atMs, rec.observedAt, OBS_WINDOW_MS)) continue;
    if (!cells.has(rec.gridCell)) {
      cells.set(rec.gridCell, { count: 0, ids: [] });
    }
    const cell = cells.get(rec.gridCell);
    cell.count += 1;
    cell.ids.push(rec.id);
  }
  return cells;
}

function levelForScore(score) {
  if (score >= 8) return "high";
  if (score >= 5) return "warning";
  if (score >= 2) return "watch";
  return null;
}

function evaluateRisk(store, options = {}) {
  const at = options.at ? new Date(options.at).toISOString() : new Date().toISOString();
  const atMs = Date.parse(at);
  const areas = [...store.areas.values()].filter(
    (area) => !options.areaId || area.id === options.areaId,
  );
  const run = {
    id: newId("run"),
    generatedAt: at,
    generatedBy: options.generatedBy || null,
    scopeAreaIds: areas.map((a) => a.id),
    seasonActive: isActiveSeason(at),
    thresholds: {
      seasonMonths: SEASON_MONTHS,
      rainWindowHours: RAIN_WINDOW_MS / 3600000,
      rainMm: RAIN_MM_THRESHOLD,
      humidityPct: HUMIDITY_THRESHOLD,
      tempRangeC: [TEMP_MIN, TEMP_MAX],
      observationWindowDays: OBS_WINDOW_MS / 86400000,
      clusterWindowHours: CLUSTER_WINDOW_MS / 3600000,
    },
    areaSummaries: [],
    pointIds: [],
    alert: false,
  };
  store.addRiskRun(run);
  if (!run.seasonActive) return run;

  for (const area of areas) {
    const wx = weatherContext(store, area.id, atMs);
    const trend = trapTrend(store, area.id, atMs);
    const clusters = activeClusters(store, area.id, atMs);
    const sightingCells = patrolSightingCells(store, area.id, atMs);
    const waterside =
      area.kind === "waterside" || store.waterSites.some((w) => w.areaId === area.id);

    const summary = {
      areaId: area.id,
      rainedRecently: wx.rainedRecently,
      rainTotalMm: wx.rainTotal,
      warmHumid: wx.warmHumid,
      latestWeather: wx.latest
        ? {
            id: wx.latest.id,
            observedAt: wx.latest.observedAt,
            tempC: wx.latest.tempC,
            humidityPct: wx.latest.humidityPct,
          }
        : null,
      trapRecent7d: trend.recentTotal,
      trapPrevious7d: trend.previousTotal,
      trapRising: trend.areaRising,
      activeClusters: clusters.length,
      patrolSightingCells: sightingCells.size,
      pointIds: [],
    };
    run.areaSummaries.push(summary);

    const emit = (candidate) => {
      const level = levelForScore(candidate.score);
      if (!level) return;
      const point = store.upsertRiskPoint({
        id: newId("rpt"),
        runId: run.id,
        areaId: area.id,
        dedupKey: candidate.dedupKey,
        kind: candidate.kind,
        title: candidate.title,
        lat: candidate.lat ?? null,
        lng: candidate.lng ?? null,
        level,
        score: candidate.score,
        reasons: candidate.reasons,
        suggestedMeasures: candidate.measures.map((m) => ({ ...m })),
        evidence: candidate.evidence,
        status: "pending_verification",
        verification: null,
        orderId: null,
        generatedAt: at,
        updatedAt: at,
      });
      if (!run.pointIds.includes(point.id)) run.pointIds.push(point.id);
      if (!summary.pointIds.includes(point.id)) summary.pointIds.push(point.id);
    };

    const envScore = (wx.rainedRecently ? 2 : 0) + (wx.warmHumid ? 2 : 0);
    const envReasons = [];
    if (wx.rainedRecently) {
      envReasons.push({
        code: "post_rain",
        text: `近 48 小时累计降雨 ${wx.rainTotal}mm，雨后虫体易向灯光建筑扩散`,
      });
    }
    if (wx.warmHumid) {
      envReasons.push({
        code: "warm_humid",
        text: `当前温度 ${wx.latest.tempC}℃、湿度 ${wx.latest.humidityPct}%，适宜隐翅虫活动`,
      });
    }

    // 趋光灯具（强光/紫外诱虫灯且未调整）
    for (const lamp of store.lamps.filter((l) => l.areaId === area.id)) {
      const riskyType = lamp.lampType === "white_strong" || lamp.lampType === "uv_adhesive";
      if (!riskyType || lamp.adjusted) continue;
      const score = 2 + (waterside ? 1 : 0) + envScore;
      const reasons = [
        {
          code: "phototactic_lamp",
          text: `${lamp.name}为${lampTypeLabel(lamp.lampType)}且未完成调光，夜间趋光风险高`,
        },
        ...envReasons,
      ];
      emit({
        dedupKey: "lamp:" + lamp.id,
        kind: "lamp",
        title: "趋光灯具待调光：" + lamp.name,
        lat: lamp.lat,
        lng: lamp.lng,
        score,
        reasons,
        measures: [MEASURES.inspect_confirm, MEASURES.dim_lamp],
        evidence: {
          facilityIds: [lamp.id],
          weatherReadingIds: wx.recentIds,
          trapCountIds: [],
          clusterIds: [],
          patrolRecordIds: [],
        },
      });
    }

    // 破损纱窗/封堵设施
    for (const screen of store.screens.filter((s) => s.areaId === area.id)) {
      if (screen.intact) continue;
      const score = 3 + envScore;
      emit({
        dedupKey: "screen:" + screen.id,
        kind: "screen",
        title: "纱窗封堵设施破损：" + screen.name,
        lat: screen.lat,
        lng: screen.lng,
        score,
        reasons: [
          {
            code: "broken_screen",
            text: `${screen.name}纱窗/封堵破损（${screen.damageNote || "情况待核"}），虫体可入室`,
          },
          ...envReasons,
        ],
        measures: [MEASURES.inspect_confirm, MEASURES.seal_screen],
        evidence: {
          facilityIds: [screen.id],
          weatherReadingIds: wx.recentIds,
          trapCountIds: [],
          clusterIds: [],
          patrolRecordIds: [],
        },
      });
    }

    // 积水/绿化环境
    for (const site of store.waterSites.filter((w) => w.areaId === area.id)) {
      if (!site.standingWater && site.tidy) continue;
      const score = 2 + (site.standingWater ? 1 : 0) + envScore;
      const reasons = [];
      if (site.standingWater) reasons.push({ code: "standing_water", text: `${site.name}存在积水与潮湿腐殖环境` });
      if (!site.tidy) reasons.push({ code: "untidy_greenbelt", text: `${site.name}临水绿化/落叶堆积未清理` });
      emit({
        dedupKey: "water:" + site.id,
        kind: "water",
        title: "绿化水体环境待清理：" + site.name,
        lat: site.lat,
        lng: site.lng,
        score,
        reasons: [...reasons, ...envReasons],
        measures: [MEASURES.inspect_confirm, MEASURES.clean_environment],
        evidence: {
          facilityIds: [site.id],
          weatherReadingIds: wx.recentIds,
          trapCountIds: [],
          clusterIds: [],
          patrolRecordIds: [],
        },
      });
    }

    // 去重后的公众目击聚类（独立目击数才计分）
    for (const cluster of clusters) {
      const centroid = clusterCentroid(store, cluster);
      const score = (cluster.independentCount >= 4 ? 5 : 3) + envScore + (trend.areaRising ? 1 : 0);
      emit({
        dedupKey: "cluster:" + cluster.id,
        kind: "hotspot",
        title: "公众目击集中点（去重后独立目击 " + cluster.independentCount + " 起）",
        lat: centroid.lat,
        lng: centroid.lng,
        score,
        reasons: [
          {
            code: "report_cluster",
            text: `72 小时网格内去重后独立目击 ${cluster.independentCount} 起，重复照片 ${cluster.duplicateCount || 0} 起未计入`,
          },
          ...envReasons,
          ...(trend.areaRising
            ? [{ code: "trap_rising_area", text: `区域诱捕量由 ${trend.previousTotal} 升至 ${trend.recentTotal}` }]
            : []),
        ],
        measures: [MEASURES.inspect_confirm, MEASURES.clean_environment, MEASURES.dim_lamp],
        evidence: {
          facilityIds: [],
          weatherReadingIds: wx.recentIds,
          trapCountIds: trend.perTrap.flatMap((t) => t.recentIds),
          clusterIds: [cluster.id],
          patrolRecordIds: [],
        },
      });
    }

    // 巡查目击网格（同样基于已去重记录）
    for (const [cell, agg] of sightingCells) {
      if (agg.count < 2) continue;
      if (clusters.some((c) => c.cell === cell)) continue;
      emit({
        dedupKey: "patrolcell:" + cell,
        kind: "hotspot",
        title: "巡查目击集中网格（" + agg.count + " 条独立观测）",
        lat: null,
        lng: null,
        score: 2 + envScore,
        reasons: [
          { code: "patrol_sightings", text: `近 7 天巡查在同一网格记录 ${agg.count} 条目击观测` },
          ...envReasons,
        ],
        measures: [MEASURES.inspect_confirm, MEASURES.clean_environment],
        evidence: {
          facilityIds: [],
          weatherReadingIds: wx.recentIds,
          trapCountIds: [],
          clusterIds: [],
          patrolRecordIds: agg.ids,
        },
      });
    }

    // 诱捕量上升的单点
    for (const trap of trend.perTrap.filter((t) => t.rising)) {
      const facility = store.traps.find((x) => x.id === trap.trapId);
      emit({
        dedupKey: "trap:" + trap.trapId,
        kind: "trap",
        title: "诱捕量异常上升：" + (facility ? facility.name : trap.trapId),
        lat: facility ? facility.lat : null,
        lng: facility ? facility.lng : null,
        score: 3 + envScore,
        reasons: [
          {
            code: "trap_rising",
            text: `近 7 天诱捕 ${trap.recentSum} 只，前 7 天 ${trap.previousSum} 只，升幅超过 1.5 倍`,
          },
          ...envReasons,
        ],
        measures: [MEASURES.inspect_confirm, MEASURES.clean_environment, MEASURES.dim_lamp],
        evidence: {
          facilityIds: [trap.trapId],
          weatherReadingIds: wx.recentIds,
          trapCountIds: trap.recentIds,
          clusterIds: [],
          patrolRecordIds: [],
        },
      });
    }
  }

  // 本次未被重新触发的待核查点位置为“已解除”，保留历史但不再派单
  for (const point of store.riskPoints) {
    if (point.status === "pending_verification" && point.updatedAt < at) {
      point.status = "cleared";
      point.updatedAt = at;
      point.clearReason = "规则复算时证据已消失或超出观测窗口";
      point.runClearedId = run.id;
    }
  }

  const points = run.pointIds
    .map((id) => store.getRiskPoint(id))
    .filter((p) => p && p.status === "pending_verification");
  run.alert = points.some((p) => p.level === "high") ||
    points.filter((p) => p.level === "warning").length >= 3;
  run.pointLevels = levelsOf(points);
  return run;
}

function levelsOf(points) {
  return points.reduce(
    (acc, p) => {
      acc[p.level] = (acc[p.level] || 0) + 1;
      return acc;
    },
    { high: 0, warning: 0, watch: 0 },
  );
}

function clusterCentroid(store, cluster) {
  // 以聚类内独立目击的均值坐标作为内部核查参考，不对公众输出
  const ids = cluster.reportIds || [];
  const reports = store.publicReports.filter((r) => ids.includes(r.id) && r.status === "unique");
  if (reports.length === 0) return { lat: null, lng: null };
  const lat = reports.reduce((s, r) => s + r.lat, 0) / reports.length;
  const lng = reports.reduce((s, r) => s + r.lng, 0) / reports.length;
  return { lat: round6(lat), lng: round6(lng) };
}

function lampTypeLabel(type) {
  return {
    uv_adhesive: "紫外诱虫灯",
    white_strong: "强白光灯具",
    warm_led: "暖光 LED",
    sodium: "钠灯",
  }[type] || type;
}

function round1(v) {
  return Math.round(v * 10) / 10;
}

function round6(v) {
  return Math.round(v * 1e6) / 1e6;
}

module.exports = {
  MEASURES,
  SEASON_MONTHS,
  isActiveSeason,
  evaluateRisk,
  clusterCentroid,
  lampTypeLabel,
};
