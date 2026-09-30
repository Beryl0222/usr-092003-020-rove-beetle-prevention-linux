"use strict";

// 管理分析：处理前后诱捕/报告对比、长期未闭环设施与滞留工单识别。

const { nowIso } = require("./store");

function ts(iso) {
  return new Date(iso).getTime();
}

// 在 (from, to] 区间内统计诱捕数量与去重后独立公众发现数
function windowCounts(store, siteId, from, to) {
  const trap = store
    .find("trapCounts", (t) => t.siteId === siteId && ts(t.at) > from && ts(t.at) <= to)
    .reduce((sum, t) => sum + Number(t.trapCount || 0), 0);
  const reports = store.find(
    "publicReports",
    (r) => r.status === "new" && r.siteId === siteId && ts(r.at) > from && ts(r.at) <= to
  ).length;
  return { trap, reports };
}

function pctChange(before, after) {
  if (before === 0) return after === 0 ? 0 : null; // 基数为 0 时不给百分比，避免误导
  return Math.round(((after - before) / before) * 1000) / 10;
}

// 单张工单（以实施时间为界）的前后对比
function workOrderEffect(store, workOrderId, options = {}) {
  const wo = store.byId("workOrders", workOrderId);
  if (!wo) return null;
  if (!wo.implementedAt) {
    return {
      workOrderId: wo.id,
      siteId: wo.siteId,
      status: wo.status,
      comparable: false,
      reason: "措施尚未实施，无可对比的实施时点",
    };
  }
  const spanDays = options.spanDays || 14;
  const span = spanDays * 24 * 36e5;
  const pivot = ts(wo.implementedAt);
  const before = windowCounts(store, wo.siteId, pivot - span, pivot);
  const after = windowCounts(store, wo.siteId, pivot, pivot + span);
  return {
    workOrderId: wo.id,
    siteId: wo.siteId,
    status: wo.status,
    comparable: true,
    implementedAt: wo.implementedAt,
    spanDays,
    measures: wo.selectedMeasures,
    before,
    after,
    change: {
      trap: { delta: after.trap - before.trap, pct: pctChange(before.trap, after.trap) },
      reports: { delta: after.reports - before.reports, pct: pctChange(before.reports, after.reports) },
    },
  };
}

// 区域汇总：把区间内已实施工单的前后变化合计
function jurisdictionEffect(store, jurisdictionId, options = {}) {
  const childIds = new Set([jurisdictionId]);
  for (const j of store.data.jurisdictions) if (j.districtId === jurisdictionId) childIds.add(j.id);
  const workOrders = store.find(
    "workOrders",
    (w) => childIds.has(w.jurisdictionId) && w.implementedAt
  );
  const rows = workOrders.map((w) => workOrderEffect(store, w.id, options)).filter(Boolean);
  const totals = rows.reduce(
    (acc, r) => {
      if (!r.comparable) return acc;
      acc.beforeTrap += r.before.trap;
      acc.afterTrap += r.after.trap;
      acc.beforeReports += r.before.reports;
      acc.afterReports += r.after.reports;
      return acc;
    },
    { beforeTrap: 0, afterTrap: 0, beforeReports: 0, afterReports: 0 }
  );
  return {
    jurisdictionId,
    workOrderCount: rows.length,
    ...totals,
    trapPctChange: pctChange(totals.beforeTrap, totals.afterTrap),
    reportsPctChange: pctChange(totals.beforeReports, totals.afterReports),
    rows,
  };
}

// 长期未闭环：
// 1) 破损纱窗长期未修复（lastCheckedAt 久远或从未检查）；
// 2) 滞留工单（超过阈值仍未 verified/closed/cancelled）；
// 3) 复查失效后未再推进的工单。
function unclosedItems(store, options = {}) {
  const at = options.at || nowIso();
  const stallDays = options.stallDays || 7;
  const screenDays = options.screenDays || 14;
  const now = ts(at);

  const screens = store
    .find("screens", (s) => s.intact === false)
    .map((s) => {
      const site = store.byId("sites", s.siteId);
      const ageDays = s.lastCheckedAt ? (now - ts(s.lastCheckedAt)) / 864e5 : null;
      return {
        screenId: s.id,
        siteId: s.siteId,
        siteName: site ? site.name : null,
        jurisdictionId: site ? site.jurisdictionId : null,
        location: s.location,
        lastCheckedAt: s.lastCheckedAt,
        daysSinceCheck: ageDays == null ? null : Math.round(ageDays * 10) / 10,
        overdue: ageDays == null || ageDays >= screenDays,
      };
    });

  const stuckWorkOrders = store
    .find("workOrders", (w) => !["verified", "cancelled"].includes(w.status))
    .map((w) => {
      const ref = w.implementedAt || w.scheduledAt || w.createdAt;
      const days = (now - ts(ref)) / 864e5;
      return {
        workOrderId: w.id,
        alertId: w.alertId,
        siteId: w.siteId,
        jurisdictionId: w.jurisdictionId,
        status: w.status,
        lastAt: ref,
        daysOpen: Math.round(days * 10) / 10,
        stalled: days >= stallDays,
        failed: w.status === "failed",
      };
    })
    .filter((w) => w.stalled || w.failed);

  return {
    at,
    thresholds: { stallDays, screenDays },
    brokenScreens: screens,
    overdueScreens: screens.filter((s) => s.overdue),
    stuckWorkOrders,
  };
}

module.exports = {
  workOrderEffect,
  jurisdictionEffect,
  unclosedItems,
  pctChange,
  windowCounts,
};
