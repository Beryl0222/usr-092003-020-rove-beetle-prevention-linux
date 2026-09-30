"use strict";

// 工单生命周期：规则引擎只能产出“待核查建议”，现场人员确认虫种与环境后
// 才能安排措施；必要消杀必须由区级人工单独授权。实施、复查、失效全部留痕。
//
// proposed -> verified -> implemented -> closed
//                |            |             |
//             dismissed   reopened <-- 复查不通过 / 措施失效（可再次实施）

const { newId } = require("./store");

const ENV_MEASURE_CODES = ["dim_lamp", "seal_screen", "clean_environment"];
const TREATMENT_CODE = "targeted_treatment";

function httpError(status, message, code) {
  const error = new Error(message);
  error.status = status;
  error.code = code || "ERROR";
  return error;
}

function createWorkOrder(store, actor, riskPointId) {
  const point = store.getRiskPoint(riskPointId);
  if (!point) throw httpError(404, "风险点位不存在", "NOT_FOUND");
  if (point.status === "dismissed" || point.status === "closed") {
    throw httpError(409, "该风险点位已结束，不能再创建工单", "POINT_CLOSED");
  }
  if (point.orderId) {
    const existing = store.getWorkOrder(point.orderId);
    if (existing && existing.status !== "dismissed") return existing;
  }

  const now = new Date().toISOString();
  const order = {
    id: newId("wo"),
    riskPointId: point.id,
    areaId: point.areaId,
    title: point.title,
    level: point.level,
    status: "proposed",
    suggestedMeasures: point.suggestedMeasures.map((m) => ({ ...m })),
    authorizedMeasures: [],
    implementedMeasures: [],
    speciesConfirmed: false,
    environmentConfirmed: false,
    confirmation: null,
    events: [],
    reopenedCount: 0,
    createdAt: now,
    createdBy: { id: actor.id, name: actor.name, role: actor.role },
    closedAt: null,
  };
  recordEvent(order, now, "create", actor, "created", "proposed", "规则点位生成待核查工单", {
    runId: point.runId,
    score: point.score,
  });
  store.addWorkOrder(order);
  point.orderId = order.id;
  point.status = "proposed";
  point.updatedAt = now;
  return order;
}

function verify(store, actor, orderId, input) {
  const order = mustGetOrder(store, orderId);
  assertStatus(order, ["proposed", "reopened"], "只有待核查或重新打开的工单可以现场确认");
  const now = new Date().toISOString();

  const from = order.status;
  if (input.conclusion === "dismiss") {
    order.status = "dismissed";
    order.confirmation = {
      speciesConfirmed: Boolean(input.speciesConfirmed),
      environmentConfirmed: Boolean(input.environmentConfirmed),
      dismissReason: input.note || "现场核查排除隐翅虫风险",
      verifierId: actor.id,
      verifiedAt: now,
    };
    recordEvent(order, now, "verify_dismiss", actor, from, "dismissed", input.note || "现场核查排除风险", {
      speciesConfirmed: input.speciesConfirmed === true,
    });
    const point = store.getRiskPoint(order.riskPointId);
    point.status = "dismissed";
    point.verification = order.confirmation;
    point.updatedAt = now;
    return order;
  }

  if (input.speciesConfirmed !== true) {
    throw httpError(422, "确认虫种前不能通过核查：speciesConfirmed 必须为 true", "SPECIES_UNCONFIRMED");
  }
  if (input.environmentConfirmed !== true) {
    throw httpError(422, "需同时确认孳生/趋光环境后才能安排措施", "ENVIRONMENT_UNCONFIRMED");
  }

  order.speciesConfirmed = true;
  order.environmentConfirmed = true;
  order.confirmation = {
    speciesConfirmed: true,
    environmentConfirmed: true,
    note: input.note || null,
    verifierId: actor.id,
    verifierName: actor.name,
    verifiedAt: now,
  };

  // 现场可依据实际情况调整环境措施建议，但系统不允许在此加入消杀。
  const codes = new Set(order.suggestedMeasures.map((m) => m.code));
  for (const code of input.removeMeasures || []) {
    if (!ENV_MEASURE_CODES.includes(code)) throw httpError(400, "不可移除措施: " + code, "BAD_MEASURE");
    codes.delete(code);
  }
  for (const code of input.addMeasures || []) {
    if (!ENV_MEASURE_CODES.includes(code)) {
      throw httpError(403, "消杀措施不能在核查环节添加，必须由区级单独授权", "TREATMENT_NOT_AUTHORIZED");
    }
    codes.add(code);
  }
  order.suggestedMeasures = [...codes].map(measureView);

  order.status = "verified";
  recordEvent(order, now, "verify_confirm", actor, from, "verified", input.note || "现场确认虫种及环境", {
    suggestedMeasures: order.suggestedMeasures.map((m) => m.code),
  });
  const point = store.getRiskPoint(order.riskPointId);
  point.status = "verified";
  point.verification = order.confirmation;
  point.updatedAt = now;
  return order;
}

// 必要消杀：仅区级账号，在虫种确认之后单独授权，一次一授权，写入事件。
function authorizeTreatment(store, actor, orderId, input) {
  const order = mustGetOrder(store, orderId);
  if (actor.role !== "district") {
    throw httpError(403, "只有区级爱卫部门可以授权消杀", "FORBIDDEN");
  }
  if (order.status !== "verified" && order.status !== "reopened") {
    throw httpError(409, "工单需先完成虫种与环境确认", "ORDER_NOT_VERIFIED");
  }
  if (!order.speciesConfirmed) {
    throw httpError(409, "虫种未确认，不能授权消杀", "SPECIES_UNCONFIRMED");
  }
  const justification = (input && input.justification || "").trim();
  if (justification.length < 10) {
    throw httpError(422, "消杀授权必须填写不少于 10 字的必要性说明", "JUSTIFICATION_REQUIRED");
  }
  if (!order.authorizedMeasures.includes(TREATMENT_CODE)) {
    order.authorizedMeasures.push(TREATMENT_CODE);
    if (!order.suggestedMeasures.some((m) => m.code === TREATMENT_CODE)) {
      order.suggestedMeasures.push(measureView(TREATMENT_CODE));
    }
  }
  recordEvent(order, new Date().toISOString(), "authorize_treatment", actor, order.status, order.status, justification, {
    measure: TREATMENT_CODE,
    scope: input.scope || "targeted",
  });
  return order;
}

function implement(store, actor, orderId, input) {
  const order = mustGetOrder(store, orderId);
  assertStatus(order, ["verified", "reopened"], "只有已确认或重新打开的工单可以登记实施");
  const codes = Array.isArray(input.measureCodes) ? input.measureCodes : [];
  if (codes.length === 0) throw httpError(400, "请登记至少一项实施措施", "NO_MEASURE");

  const allowed = new Set(order.suggestedMeasures.map((m) => m.code));
  for (const code of codes) {
    if (!allowed.has(code)) throw httpError(400, "措施不在本工单范围内: " + code, "BAD_MEASURE");
    if (code === TREATMENT_CODE && !order.authorizedMeasures.includes(TREATMENT_CODE)) {
      throw httpError(403, "消杀缺少区级人工授权，系统禁止实施", "TREATMENT_NOT_AUTHORIZED");
    }
  }

  const now = new Date().toISOString();
  const effects = applyFacilityEffects(store, order, codes, now, actor, input.targets || []);

  for (const code of codes) {
    if (!order.implementedMeasures.includes(code)) order.implementedMeasures.push(code);
  }
  const from = order.status;
  order.status = "implemented";
  recordEvent(order, now, "implement", actor, from, "implemented", input.note || "措施已现场实施", {
    measures: codes,
    effects,
  });
  const point = store.getRiskPoint(order.riskPointId);
  point.status = "implemented";
  point.updatedAt = now;
  return order;
}

function review(store, actor, orderId, input) {
  const order = mustGetOrder(store, orderId);
  assertStatus(order, ["implemented"], "只有已实施的工单可以复查");
  const now = new Date().toISOString();
  const pass = input.pass !== false;
  if (pass) {
    order.status = "closed";
    order.closedAt = now;
    recordEvent(order, now, "review_pass", actor, "implemented", "closed", input.note || "复查通过，风险闭环", {
      nextReviewAt: input.nextReviewAt || null,
    });
    const point = store.getRiskPoint(order.riskPointId);
    point.status = "closed";
    point.updatedAt = now;
  } else {
    order.status = "reopened";
    order.reopenedCount += 1;
    recordEvent(order, now, "review_fail", actor, "implemented", "reopened", input.note || "复查未通过，重新处置", {
      reason: input.reason || null,
    });
    const point = store.getRiskPoint(order.riskPointId);
    point.status = "reopened";
    point.updatedAt = now;
  }
  return order;
}

function invalidate(store, actor, orderId, input) {
  const order = mustGetOrder(store, orderId);
  if (!["closed", "implemented"].includes(order.status)) {
    throw httpError(409, "只有已闭环或已实施的措施可以登记失效", "ORDER_NOT_CLOSABLE");
  }
  const reason = (input && input.reason || "").trim();
  if (reason.length < 5) throw httpError(422, "请说明措施失效的具体表现", "REASON_REQUIRED");
  const now = new Date().toISOString();
  const from = order.status;
  order.status = "reopened";
  order.reopenedCount += 1;
  if (from === "closed") order.closedAt = null;
  recordEvent(order, now, "invalidate", actor, from, "reopened", reason, {
    observedAt: input.observedAt || now,
  });
  const point = store.getRiskPoint(order.riskPointId);
  point.status = "reopened";
  point.updatedAt = now;
  return order;
}

// 设施回写对象 = 证据链点名设施 ∪ 现场登记 targets（须在同一辖区）。
// 热点/诱捕类点位证据里没有设施时，必须由现场人员显式指定 targets。
function applyFacilityEffects(store, order, codes, at, actor, rawTargets = []) {
  const effects = [];
  const point = store.getRiskPoint(order.riskPointId);
  const targets = new Set(point.evidence.facilityIds || []);

  for (const ref of rawTargets) {
    const facility =
      store.lamps.find((f) => f.id === ref) ||
      store.screens.find((f) => f.id === ref) ||
      store.waterSites.find((f) => f.id === ref);
    if (!facility) throw httpError(404, "目标设施不存在: " + ref, "TARGET_NOT_FOUND");
    if (facility.areaId !== order.areaId) {
      throw httpError(403, "不能处置其他辖区的设施: " + ref, "FORBIDDEN");
    }
    targets.add(ref);
  }

  if (codes.includes("dim_lamp")) {
    const lamps = store.lamps.filter((l) => targets.has(l.id));
    if (lamps.length === 0) {
      throw httpError(422, "调光措施需指定本辖区灯具（证据未关联灯具时请在 targets 登记）", "TARGET_REQUIRED");
    }
    for (const lamp of lamps) {
      if (!lamp.adjusted) {
        store.updateLamp(lamp.id, { adjusted: true });
        effects.push({ type: "lamp", id: lamp.id, adjusted: true });
      }
    }
  }
  if (codes.includes("seal_screen")) {
    const screens = store.screens.filter((s) => targets.has(s.id));
    if (screens.length === 0) {
      throw httpError(422, "封堵措施需指定本辖区纱窗设施", "TARGET_REQUIRED");
    }
    for (const screen of screens) {
      if (!screen.intact) {
        store.updateScreen(screen.id, { intact: true, damageNote: null }, at);
        effects.push({ type: "screen", id: screen.id, intact: true, sealedBy: actor.id });
      }
    }
  }
  if (codes.includes("clean_environment")) {
    const sites = store.waterSites.filter((w) => targets.has(w.id));
    if (sites.length === 0) {
      throw httpError(422, "清理措施需指定本辖区绿化水体点", "TARGET_REQUIRED");
    }
    for (const site of sites) {
      if (!site.tidy || site.standingWater) {
        store.updateWaterSite(site.id, { tidy: true, standingWater: false }, at);
        effects.push({ type: "waterSite", id: site.id, tidy: true, standingWater: false });
      }
    }
  }
  return effects;
}

function measureView(codeOrMeasure) {
  const code = typeof codeOrMeasure === "string" ? codeOrMeasure : codeOrMeasure.code;
  const labels = {
    inspect_confirm: "现场核查虫种与孳生环境，确认前不实施处置",
    dim_lamp: "调整夜间趋光灯具：降功率、改暖色、缩短时长或加挡光",
    seal_screen: "修补封堵破损纱窗、门缝与通风口",
    clean_environment: "清理落叶腐殖与积水，整理临水绿化带",
    targeted_treatment: "区级授权后的定点消杀（最小范围，避开非靶标生物）",
  };
  return { code, label: labels[code] || code };
}

function recordEvent(order, at, action, actor, from, to, note, details) {
  order.events.push({
    at,
    action,
    actor: { id: actor.id, name: actor.name, role: actor.role },
    from,
    to,
    note: note || null,
    details: details || {},
  });
}

function mustGetOrder(store, id) {
  const order = store.getWorkOrder(id);
  if (!order) throw httpError(404, "工单不存在", "NOT_FOUND");
  return order;
}

function assertStatus(order, statuses, message) {
  if (!statuses.includes(order.status)) {
    throw httpError(409, message + `（当前状态：${order.status}）`, "BAD_STATUS");
  }
}

module.exports = {
  ENV_MEASURE_CODES,
  TREATMENT_CODE,
  createWorkOrder,
  verify,
  authorizeTreatment,
  implement,
  review,
  invalidate,
  httpError,
};
