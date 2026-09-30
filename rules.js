"use strict";

// 风险规则引擎：把降雨、温湿度、诱捕计数、公众发现（去重后）、灯具、纱窗、
// 绿化水体等观测按区域与时段汇总，产出"需要人工核查"的点位与建议措施。
// 引擎只产生建议，不直接下达任何处置；消杀类措施始终需要区级人工审批。

const { genId, nowIso } = require("./store");

// ---- 阈值（集中管理，便于校准与测试）----
const THRESHOLDS = {
  RAIN_LOOKBACK_HOURS: 48,      // 雨后窗口
  TEMP_MIN: 20,
  TEMP_MAX: 35,
  HUMIDITY_MIN: 65,
  TRAP_WINDOW_HOURS: 72,        // 诱捕同比窗口
  TRAP_SURGE_RATIO: 1.5,        // 当前窗口相对上一窗口上升 50%
  TRAP_SURGE_MIN_CURRENT: 2,    // 且当前窗口至少 2 只，避免 0→1 噪声
  REPORT_WINDOW_HOURS: 24,
  REPORT_CLUSTER_MIN: 3,        // 去重后 24 小时内 3 条独立发现
  ALERT_REUSE_HOURS: 48,        // 开放预警复用窗口，避免反复评估制造重复点位
  SCORE_LOW: 15,
  SCORE_MEDIUM: 35,
  SCORE_HIGH: 55,
};

const RULE_LABELS = {
  active_season: "活跃季节（初夏至深秋）",
  post_rain_warm_humid: "雨后温暖潮湿",
  trap_surge: "诱捕数量明显上升",
  report_cluster: "公众发现聚集",
  phototaxis_lighting: "强趋光灯具",
  screen_damaged: "纱窗设施破损",
  habitat: "临水或腐殖质生境",
};

const RULE_WEIGHTS = {
  active_season: 5,
  post_rain_warm_humid: 25,
  trap_surge: 25,
  report_cluster: 20,
  phototaxis_lighting: 12,
  screen_damaged: 10,
  habitat: 8,
};

function ts(iso) {
  return new Date(iso).getTime();
}

function within(referenceIso, eventIso, hours) {
  return (ts(referenceIso) - ts(eventIso)) / 36e5 <= hours;
}

// 取辖区（含其上级区级辖区）在评估时刻之前最近的气象观测
function weatherJurisdictionIds(store, jurisdictionId) {
  const ids = [jurisdictionId];
  const j = store.byId("jurisdictions", jurisdictionId);
  if (j && j.districtId) ids.push(j.districtId);
  return ids;
}

function latestWeatherBefore(store, jurisdictionId, at) {
  const ids = new Set(weatherJurisdictionIds(store, jurisdictionId));
  return store
    .find("weather", (w) => ids.has(w.jurisdictionId) && ts(w.at) <= ts(at))
    .sort((a, b) => ts(b.at) - ts(a.at))[0] || null;
}

function sumCounts(store, siteId, fromTs, toTs) {
  return store
    .find("trapCounts", (t) => t.siteId === siteId)
    .filter((t) => {
      const x = ts(t.at);
      return x > fromTs && x <= toTs;
    })
    .reduce((sum, t) => sum + Number(t.trapCount || 0), 0);
}

// 去重后的独立公众发现：status=new 的才是独立信号；重复照片/时间桶合并记录不计入
function independentReports(store, siteId, jurisdictionId, at, hours) {
  const from = ts(at) - hours * 36e5;
  return store.find("publicReports", (r) => {
    if (r.status !== "new") return false;
    if (siteId) return r.siteId === siteId && ts(r.at) >= from && ts(r.at) <= ts(at);
    return (
      r.jurisdictionId === jurisdictionId &&
      !r.siteId &&
      ts(r.at) >= from &&
      ts(r.at) <= ts(at)
    );
  });
}

// 站点级规则评估
function evaluateSite(store, site, at = nowIso()) {
  const rules = [];
  const weather = latestWeatherBefore(store, site.jurisdictionId, at);

  if (store.isActiveSeason(at)) {
    rules.push({ code: "active_season", weight: RULE_WEIGHTS.active_season, evidence: { month: store.monthOf(at) } });
  }

  // 雨后 + 温暖 + 潮湿：辖区 48 小时内有降雨，且最近温湿度适宜
  if (weather) {
    const recentRain =
      Number(weather.rainfallMm || 0) > 0 && within(at, weather.at, THRESHOLDS.RAIN_LOOKBACK_HOURS);
    const rainEndedRecent =
      weather.rainEndedAt &&
      ts(weather.rainEndedAt) <= ts(at) &&
      within(at, weather.rainEndedAt, THRESHOLDS.RAIN_LOOKBACK_HOURS);
    const warm =
      weather.tempC != null &&
      weather.tempC >= THRESHOLDS.TEMP_MIN &&
      weather.tempC <= THRESHOLDS.TEMP_MAX;
    const humid = weather.humidityPct != null && weather.humidityPct >= THRESHOLDS.HUMIDITY_MIN;
    if ((recentRain || rainEndedRecent) && warm && humid) {
      rules.push({
        code: "post_rain_warm_humid",
        weight: RULE_WEIGHTS.post_rain_warm_humid,
        evidence: {
          weatherId: weather.id,
          at: weather.at,
          rainfallMm: weather.rainfallMm || 0,
          rainEndedAt: weather.rainEndedAt || null,
          tempC: weather.tempC,
          humidityPct: weather.humidityPct,
        },
      });
    }
  }

  // 诱捕数量同比上升
  const w = THRESHOLDS.TRAP_WINDOW_HOURS * 36e5;
  const cur = sumCounts(store, site.id, ts(at) - w, ts(at));
  const base = sumCounts(store, site.id, ts(at) - 2 * w, ts(at) - w);
  if (
    cur >= THRESHOLDS.TRAP_SURGE_MIN_CURRENT &&
    (base === 0 || cur / base >= THRESHOLDS.TRAP_SURGE_RATIO)
  ) {
    rules.push({
      code: "trap_surge",
      weight: RULE_WEIGHTS.trap_surge,
      evidence: { windowHours: THRESHOLDS.TRAP_WINDOW_HOURS, current: cur, baseline: base },
    });
  }

  // 去重后的公众发现聚集
  const reports = independentReports(store, site.id, site.jurisdictionId, at, THRESHOLDS.REPORT_WINDOW_HOURS);
  if (reports.length >= THRESHOLDS.REPORT_CLUSTER_MIN) {
    rules.push({
      code: "report_cluster",
      weight: RULE_WEIGHTS.report_cluster,
      evidence: {
        windowHours: THRESHOLDS.REPORT_WINDOW_HOURS,
        count: reports.length,
        reportIds: reports.map((r) => r.id),
      },
    });
  }

  // 强趋光灯具（紫外灯/强白光且仍在使用）
  const riskyLights = store.find(
    "lights",
    (l) => l.siteId === site.id && l.status === "on" && ["uv", "white_strong"].includes(l.lampType)
  );
  if (riskyLights.length) {
    rules.push({
      code: "phototaxis_lighting",
      weight: RULE_WEIGHTS.phototaxis_lighting,
      evidence: { lightIds: riskyLights.map((l) => l.id), lampTypes: riskyLights.map((l) => l.lampType) },
    });
  }

  // 纱窗破损
  const brokenScreens = store.find("screens", (s) => s.siteId === site.id && s.intact === false);
  if (brokenScreens.length) {
    rules.push({
      code: "screen_damaged",
      weight: RULE_WEIGHTS.screen_damaged,
      evidence: { screenIds: brokenScreens.map((s) => s.id), locations: brokenScreens.map((s) => s.location) },
    });
  }

  // 临水或腐殖质/茂密植被生境
  const env = store.find(
    "environments",
    (e) =>
      e.siteId === site.id &&
      (e.hasWaterbody || e.mulchAccumulation === true || e.vegetationDensity === "high")
  );
  if (env.length) {
    rules.push({
      code: "habitat",
      weight: RULE_WEIGHTS.habitat,
      evidence: {
        environmentIds: env.map((e) => e.id),
        waterbody: env.some((e) => e.hasWaterbody),
        mulch: env.some((e) => e.mulchAccumulation),
        denseVegetation: env.some((e) => e.vegetationDensity === "high"),
      },
    });
  }

  const score = rules.reduce((sum, r) => sum + r.weight, 0);
  const codes = new Set(rules.map((r) => r.code));
  const coreHit = ["post_rain_warm_humid", "trap_surge", "report_cluster"].some((c) => codes.has(c));
  let level = null;
  if (score >= THRESHOLDS.SCORE_HIGH && coreHit) level = "high";
  else if (score >= THRESHOLDS.SCORE_MEDIUM && coreHit) level = "medium";
  else if (score >= THRESHOLDS.SCORE_LOW) level = "low";

  return { site, weather, rules, score, level, inSeason: codes.has("active_season") };
}

// 依据命中规则推导建议措施；全部为"建议"，由现场确认人选择，系统不自动执行
function suggestedMeasures(evaluation) {
  const codes = new Set(evaluation.rules.map((r) => r.code));
  const measures = [];
  if (codes.has("phototaxis_lighting")) {
    measures.push({ type: "light_adjust", reason: "存在紫外/强光灯具，建议降低功率、改暖光或分时关闭", requiresApproval: false });
  }
  if (codes.has("post_rain_warm_humid") || codes.has("habitat")) {
    measures.push({ type: "cleanup", reason: "雨后潮湿并存在积水/腐殖质，建议清理落叶、翻盆倒罐、疏通积水", requiresApproval: false });
  }
  if (codes.has("screen_damaged")) {
    measures.push({ type: "seal", reason: "纱窗破损，建议修复纱网并封堵缝隙", requiresApproval: false });
  }
  // 仅高风险且出现虫情核心信号时，把消杀列为备选；仍须区级审批 + 现场确认虫种
  if (evaluation.level === "high" && (codes.has("trap_surge") || codes.has("report_cluster"))) {
    measures.push({
      type: "disinfest",
      reason: "虫情信号强，可在确认虫种与密度后考虑靶向消杀，避免广谱施药伤害其他生物",
      requiresApproval: true,
    });
  }
  return measures;
}

function childJurisdictionIds(store, rootId) {
  const ids = new Set([rootId]);
  for (const j of store.data.jurisdictions) {
    if (j.districtId === rootId) ids.add(j.id);
  }
  return ids;
}

// 执行一次区域评估，生成或复用预警；预警同时挂起一张"待核查"工单（不含任何处置动作）
function runEvaluation(store, options = {}) {
  const at = options.at || nowIso();
  const rootJurisdictionId = options.jurisdictionId || null;
  const allowed = rootJurisdictionId ? childJurisdictionIds(store, rootJurisdictionId) : null;

  const created = [];
  const reused = [];
  const skippedOffSeason = [];

  for (const site of store.data.sites) {
    if (allowed && !allowed.has(site.jurisdictionId)) continue;
    const evaluation = evaluateSite(store, site, at);
    if (!evaluation.inSeason) {
      skippedOffSeason.push({ siteId: site.id, reason: "非活跃季节" });
      continue;
    }
    // 只有中/高级（且命中雨后、诱捕或发现等虫情核心信号）才派发核查；
    // 单纯设施类低信号不打扰现场，设施问题交由"长期未闭环"分析跟踪。
    if (evaluation.level !== "medium" && evaluation.level !== "high") continue;

    const measures = suggestedMeasures(evaluation);
    const existing = store.one(
      "alerts",
      (a) =>
        a.status === "open" &&
        a.siteId === site.id &&
        (ts(at) - ts(a.createdAt)) / 36e5 <= THRESHOLDS.ALERT_REUSE_HOURS
    );
    if (existing) {
      existing.reassessments = (existing.reassessments || 0) + 1;
      existing.lastEvaluatedAt = at;
      existing.latestScore = evaluation.score;
      existing.latestLevel = evaluation.level;
      reused.push(existing.id);
      continue;
    }
    created.push(openAlert(store, { siteId: site.id, jurisdictionId: site.jurisdictionId, evaluation, measures, at }));
  }

  // 辖区级：去重后无法定位到具体点位的公众发现聚集
  for (const jurisdiction of store.data.jurisdictions) {
    if (allowed && !allowed.has(jurisdiction.id)) continue;
    const reports = independentReports(store, null, jurisdiction.id, at, THRESHOLDS.REPORT_WINDOW_HOURS);
    if (reports.length < THRESHOLDS.REPORT_CLUSTER_MIN) continue;
    const existing = store.one(
      "alerts",
      (a) =>
        a.status === "open" &&
        a.siteId === null &&
        a.jurisdictionId === jurisdiction.id &&
        (ts(at) - ts(a.createdAt)) / 36e5 <= THRESHOLDS.ALERT_REUSE_HOURS
    );
    if (existing) {
      existing.reassessments = (existing.reassessments || 0) + 1;
      reused.push(existing.id);
      continue;
    }
    const evaluation = {
      rules: [
        {
          code: "report_cluster",
          weight: RULE_WEIGHTS.report_cluster,
          evidence: { windowHours: THRESHOLDS.REPORT_WINDOW_HOURS, count: reports.length, reportIds: reports.map((r) => r.id), unlocated: true },
        },
      ],
      score: RULE_WEIGHTS.report_cluster + RULE_WEIGHTS.active_season,
      level: "medium",
      weather: latestWeatherBefore(store, jurisdiction.id, at),
    };
    created.push(
      openAlert(store, {
        siteId: null,
        jurisdictionId: jurisdiction.id,
        evaluation,
        measures: [{ type: "cleanup", reason: "区域内发现聚集，建议现场排查积水与腐殖质", requiresApproval: false }],
        at,
      })
    );
  }

  return { at, created: created.map((a) => a.id), reused, skippedOffSeason };
}

function openAlert(store, { siteId, jurisdictionId, evaluation, measures, at }) {
  const alert = {
    id: genId("al"),
    siteId,
    jurisdictionId,
    createdAt: at,
    lastEvaluatedAt: at,
    status: "open", // open（待核查）| confirmed | dismissed
    level: evaluation.level,
    score: evaluation.score,
    latestScore: evaluation.score,
    latestLevel: evaluation.level,
    triggeredRules: evaluation.rules.map((r) => ({
      code: r.code,
      label: RULE_LABELS[r.code] || r.code,
      weight: r.weight,
      evidence: r.evidence,
    })),
    suggestedMeasures: measures,
    weatherEvidence: evaluation.weather
      ? {
          weatherId: evaluation.weather.id,
          at: evaluation.weather.at,
          tempC: evaluation.weather.tempC,
          humidityPct: evaluation.weather.humidityPct,
          rainfallMm: evaluation.weather.rainfallMm,
          rainEndedAt: evaluation.weather.rainEndedAt || null,
        }
      : null,
    reassessments: 0,
    confirmationId: null,
    workOrderId: null,
  };
  store.add("alerts", alert);

  // 待核查工单：只表示"需要人到现场"，不携带任何自动处置
  const wo = {
    id: genId("wo"),
    alertId: alert.id,
    siteId,
    jurisdictionId,
    status: "pending_confirm",
    suggestedMeasures: measures,
    selectedMeasures: [],
    disinfestApproval: null, // null | approved | rejected
    createdAt: at,
    scheduledAt: null,
    implementedAt: null,
    verifiedAt: null,
  };
  store.add("workOrders", wo);
  alert.workOrderId = wo.id;
  store.logWorkOrderEvent(wo.id, "created", { alertId: alert.id, level: evaluation.level, score: evaluation.score });
  return alert;
}

// 预警依据解释：命中规则、气象条件、各类观测，以及后续人工确认与工单流转
function alertBasis(store, alertId) {
  const alert = store.byId("alerts", alertId);
  if (!alert) return null;
  const site = alert.siteId ? store.byId("sites", alert.siteId) : null;

  const trapIds = new Set();
  const reportIds = new Set();
  for (const rule of alert.triggeredRules) {
    if (Array.isArray(rule.evidence.reportIds)) rule.evidence.reportIds.forEach((id) => reportIds.add(id));
  }
  const traps = site
    ? store.find("trapCounts", (t) => t.siteId === site.id).map((t) => ({
        id: t.id, at: t.at, trapCount: t.trapCount, observer: t.observer || null,
      }))
    : [];
  const inspections = site
    ? store
        .find("inspections", (i) => i.siteId === site.id)
        .map((i) => ({ id: i.id, at: i.at, routeId: i.routeId, findings: i.findings }))
    : [];
  const lights = site ? store.find("lights", (l) => l.siteId === site.id) : [];
  const screens = site ? store.find("screens", (s) => s.siteId === site.id) : [];
  const environments = site ? store.find("environments", (e) => e.siteId === site.id) : [];
  const reports = store
    .find("publicReports", (r) => reportIds.has(r.id))
    .map((r) => ({ id: r.id, at: r.at, status: r.status }));

  const confirmation = alert.confirmationId ? store.byId("confirmations", alert.confirmationId) : null;
  const workOrder = alert.workOrderId ? store.byId("workOrders", alert.workOrderId) : null;
  const events = workOrder
    ? store.find("workOrderEvents", (e) => e.workOrderId === workOrder.id).sort((a, b) => ts(a.at) - ts(b.at))
    : [];

  return {
    alert: {
      id: alert.id,
      siteId: alert.siteId,
      siteName: site ? site.name : "（区域级，未定位到具体点位）",
      jurisdictionId: alert.jurisdictionId,
      status: alert.status,
      level: alert.level,
      score: alert.score,
      createdAt: alert.createdAt,
      lastEvaluatedAt: alert.lastEvaluatedAt,
      reassessments: alert.reassessments,
    },
    rules: alert.triggeredRules,
    weather: alert.weatherEvidence,
    observations: { traps, reports, inspections, lights, screens, environments },
    humanConfirmation: confirmation
      ? {
          id: confirmation.id,
          at: confirmation.at,
          inspectorId: confirmation.inspectorId,
          speciesConfirmed: confirmation.speciesConfirmed,
          density: confirmation.density || null,
          envChecks: confirmation.envChecks || {},
          note: confirmation.note || null,
        }
      : null,
    workOrder: workOrder
      ? {
          id: workOrder.id,
          status: workOrder.status,
          suggestedMeasures: workOrder.suggestedMeasures,
          selectedMeasures: workOrder.selectedMeasures,
          disinfestApproval: workOrder.disinfestApproval,
          scheduledAt: workOrder.scheduledAt,
          implementedAt: workOrder.implementedAt,
          verifiedAt: workOrder.verifiedAt,
          events,
        }
      : null,
  };
}

module.exports = {
  THRESHOLDS,
  RULE_LABELS,
  RULE_WEIGHTS,
  evaluateSite,
  suggestedMeasures,
  runEvaluation,
  alertBasis,
};
