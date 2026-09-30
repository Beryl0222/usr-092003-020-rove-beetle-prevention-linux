"use strict";

// 工单工作流：现场确认 → 选择措施 →（消杀需区级审批）→ 排期 → 实施 → 复查。
// 关键约束：规则引擎只产生"建议措施"；必须由现场人员确认虫种与环境后，
// 才能选择并安排措施；系统不会自动下达任何处置，尤其是消杀。

const { genId, nowIso } = require("./store");

class WorkflowError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function getAlert(store, alertId) {
  const alert = store.byId("alerts", alertId);
  if (!alert) throw new WorkflowError("alert_not_found", "预警不存在");
  return alert;
}

function getWorkOrderForAlert(store, alert) {
  const wo = store.byId("workOrders", alert.workOrderId);
  if (!wo) throw new WorkflowError("work_order_not_found", "工单不存在");
  return wo;
}

// 现场人员核查：确认（或排除）虫种、密度与环境条件。
// speciesConfirmed=false 表示排除隐翅虫，工单取消、预警解除。
function confirm(store, alertId, actorId, payload) {
  const alert = getAlert(store, alertId);
  const wo = getWorkOrderForAlert(store, alert);
  if (wo.status !== "pending_confirm") {
    throw new WorkflowError("invalid_status", `当前工单状态 ${wo.status} 不可再核查`);
  }

  const at = (payload && payload.at) || nowIso();
  const speciesConfirmed = Boolean(payload && payload.speciesConfirmed);

  const confirmation = {
    id: genId("cf"),
    alertId: alert.id,
    siteId: alert.siteId,
    inspectorId: actorId,
    at,
    speciesConfirmed,
    density: payload.density || null, // low|medium|high
    envChecks: {
      waterLogged: payload.envChecks ? Boolean(payload.envChecks.waterLogged) : false,
      mulch: payload.envChecks ? Boolean(payload.envChecks.mulch) : false,
      lighting: payload.envChecks ? Boolean(payload.envChecks.lighting) : false,
      screenGap: payload.envChecks ? Boolean(payload.envChecks.screenGap) : false,
    },
    note: payload.note || null,
  };
  store.add("confirmations", confirmation);
  alert.confirmationId = confirmation.id;

  if (!speciesConfirmed) {
    wo.status = "cancelled";
    alert.status = "dismissed";
    store.logWorkOrderEvent(wo.id, "cancelled", { reason: "现场核查未确认隐翅虫", confirmationId: confirmation.id }, actorId);
    return { confirmation, workOrder: wo, alert, outcome: "dismissed" };
  }

  wo.status = "confirmed";
  alert.status = "confirmed";
  store.logWorkOrderEvent(
    wo.id,
    "confirmed",
    { confirmationId: confirmation.id, density: confirmation.density, envChecks: confirmation.envChecks },
    actorId
  );
  return { confirmation, workOrder: wo, alert, outcome: "confirmed" };
}

// 选择要采取的措施。只能从预警建议中选，且必须已确认虫种。
// 选取消杀不会立即生效，需要后续区级审批。
function selectMeasures(store, alertId, actorId, types, note) {
  const alert = getAlert(store, alertId);
  const wo = getWorkOrderForAlert(store, alert);
  if (!["confirmed", "scheduled"].includes(wo.status)) {
    throw new WorkflowError("invalid_status", "请先完成现场虫种确认，再选择措施");
  }
  const allowed = new Set(alert.suggestedMeasures.map((m) => m.type));
  const chosen = [];
  for (const type of types || []) {
    if (!allowed.has(type)) {
      throw new WorkflowError("measure_not_suggested", `措施 ${type} 不在本预警建议范围内，不能下达`);
    }
    if (!chosen.includes(type)) chosen.push(type);
  }
  if (!chosen.length) throw new WorkflowError("empty_measures", "至少选择一项措施");

  wo.selectedMeasures = chosen;
  wo.disinfestApproval = chosen.includes("disinfest") ? wo.disinfestApproval : null;
  store.logWorkOrderEvent(wo.id, "measures_selected", { measures: chosen, note: note || null }, actorId);
  return wo;
}

// 区级对消杀的额外人工审批
function decideDisinfest(store, alertId, actorId, approved, note) {
  const alert = getAlert(store, alertId);
  const wo = getWorkOrderForAlert(store, alert);
  if (!wo.selectedMeasures.includes("disinfest")) {
    throw new WorkflowError("disinfest_not_selected", "该工单未选取消杀，无需审批");
  }
  if (!["confirmed", "scheduled"].includes(wo.status)) {
    throw new WorkflowError("invalid_status", "当前状态不可审批消杀");
  }
  wo.disinfestApproval = approved ? "approved" : "rejected";
  store.logWorkOrderEvent(
    wo.id,
    approved ? "disinfest_approved" : "disinfest_rejected",
    { note: note || null },
    actorId
  );
  return wo;
}

function schedule(store, alertId, actorId, scheduledAt) {
  const alert = getAlert(store, alertId);
  const wo = getWorkOrderForAlert(store, alert);
  if (wo.status !== "confirmed") throw new WorkflowError("invalid_status", "仅已确认工单可排期");
  if (!wo.selectedMeasures.length) throw new WorkflowError("no_measures", "请先选择措施再排期");
  if (wo.selectedMeasures.includes("disinfest") && wo.disinfestApproval !== "approved") {
    throw new WorkflowError("disinfest_requires_approval", "消杀尚未获区级审批，不能排期");
  }
  wo.status = "scheduled";
  wo.scheduledAt = scheduledAt || nowIso();
  store.logWorkOrderEvent(wo.id, "scheduled", { scheduledAt: wo.scheduledAt }, actorId);
  return wo;
}

function implement(store, alertId, actorId, payload = {}) {
  const alert = getAlert(store, alertId);
  const wo = getWorkOrderForAlert(store, alert);
  if (wo.status !== "scheduled") throw new WorkflowError("invalid_status", "仅已排期工单可登记实施");
  wo.status = "implemented";
  wo.implementedAt = payload.at || nowIso();
  wo.implementation = {
    measures: wo.selectedMeasures,
    details: payload.details || null,
    operatorId: actorId,
  };
  store.logWorkOrderEvent(
    wo.id,
    "implemented",
    { at: wo.implementedAt, measures: wo.selectedMeasures, details: payload.details || null },
    actorId
  );
  return wo;
}

// 复查：通过则闭环；失效则留痕并重新挂起，预警重新开放以便再处置
function verify(store, alertId, actorId, payload) {
  const alert = getAlert(store, alertId);
  const wo = getWorkOrderForAlert(store, alert);
  if (wo.status !== "implemented") throw new WorkflowError("invalid_status", "仅已实施工单可复查");
  const passed = Boolean(payload && payload.passed);
  const at = (payload && payload.at) || nowIso();
  if (passed) {
    wo.status = "verified";
    wo.verifiedAt = at;
    alert.status = "closed";
    store.logWorkOrderEvent(wo.id, "verified", { at, note: payload.note || null }, actorId);
  } else {
    wo.status = "failed";
    wo.failedAt = at;
    wo.failureReason = (payload && payload.note) || "复查未通过";
    alert.status = "open"; // 预警重新开放，可再次确认处置；原工单保留失效记录
    store.logWorkOrderEvent(wo.id, "failed", { at, reason: wo.failureReason }, actorId);
    // 为再处置派生一张新工单，保留与失效工单的关联
    const followUp = {
      id: genId("wo"),
      alertId: alert.id,
      siteId: alert.siteId,
      jurisdictionId: alert.jurisdictionId,
      status: "pending_confirm",
      suggestedMeasures: alert.suggestedMeasures,
      selectedMeasures: [],
      disinfestApproval: null,
      followsWorkOrderId: wo.id,
      createdAt: at,
    };
    store.add("workOrders", followUp);
    alert.workOrderId = followUp.id;
    store.logWorkOrderEvent(followUp.id, "created", { alertId: alert.id, followsWorkOrderId: wo.id, reason: "复查失效后再处置" }, actorId);
    return { workOrder: wo, followUp, alert, outcome: "failed" };
  }
  return { workOrder: wo, alert, outcome: "verified" };
}

module.exports = {
  WorkflowError,
  confirm,
  selectMeasures,
  decideDisinfest,
  schedule,
  implement,
  verify,
};
