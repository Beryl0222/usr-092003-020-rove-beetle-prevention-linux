"use strict";

// 隐翅虫环境防控巡查 —— HTTP 服务层
// 纯 Node 内置模块。负责路由、令牌角色认证、辖区数据隔离，
// 以及把摄入、规则引擎、工单工作流、分析模块串联为接口。

const http = require("node:http");
const { createStore, seed, nowIso } = require("./store");
const { recordPublicReport, recordInspection } = require("./ingest");
const rules = require("./rules");
const workflow = require("./workflow");
const analytics = require("./analytics");

const SERVICE_ID = "rove-beetle-prevention";
const SERVICE_NAME = "隐翅虫环境防控巡查";

function healthPayload() {
  return { status: "ok", service: SERVICE_ID, name: SERVICE_NAME };
}

// 演示用令牌直接对应用户 id；生产环境应替换为正式认证。
function authenticate(store, request) {
  const header = request.headers["authorization"] || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return null;
  return store.one("users", (u) => u.id === token) || null;
}

// 用户可见的辖区集合：区级与区级现场人员可见全部下级；学校/物业仅本辖区
function visibleJurisdictionIds(store, user) {
  if (!user) return new Set();
  const ids = new Set([user.jurisdictionId]);
  if (user.role === "district" || user.role === "field") {
    for (const j of store.data.jurisdictions) {
      if (j.kind === "district" || j.districtId === user.jurisdictionId) ids.add(j.id);
    }
  }
  return ids;
}

function siteJurisdiction(store, siteId) {
  if (!siteId) return null;
  const site = store.byId("sites", siteId);
  return site ? site.jurisdictionId : null;
}

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function requireUser(user) {
  if (!user) throw new HttpError(401, "unauthorized", "缺少或无效的访问令牌");
}

function requireRole(user, roles) {
  requireUser(user);
  if (!roles.includes(user.role)) throw new HttpError(403, "forbidden_role", "当前角色无权执行该操作");
}

function requireJurisdiction(store, user, jurisdictionId) {
  if (!visibleJurisdictionIds(store, user).has(jurisdictionId)) {
    throw new HttpError(403, "outside_jurisdiction", "只能访问本辖区数据");
  }
}

function requireSiteAccess(store, user, siteId) {
  const j = siteJurisdiction(store, siteId);
  if (!j) throw new HttpError(404, "site_not_found", "点位不存在");
  requireJurisdiction(store, user, j);
  return j;
}

function requireAlertAccess(store, user, alertId) {
  const alert = store.byId("alerts", alertId);
  if (!alert) throw new HttpError(404, "alert_not_found", "预警不存在");
  requireJurisdiction(store, user, alert.jurisdictionId);
  return alert;
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) {
        reject(new HttpError(413, "body_too_large", "请求体过大"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new HttpError(400, "bad_json", "请求体不是合法 JSON"));
      }
    });
    request.on("error", reject);
  });
}

// 禁止公众上报携带任何门牌住址类细节，位置只能到区域/点位
function assertNoAddressDetail(body) {
  const forbidden = ["address", "addressDetail", "room", "doorplate", "houseNumber"];
  for (const key of forbidden) {
    if (body[key] != null) {
      throw new HttpError(422, "address_not_allowed", "公众发现不接受门牌住址等精确定位信息");
    }
  }
}

function createServer(options = {}) {
  const store = options.store || seed(createStore());

  function sendJson(response, status, payload) {
    const body = JSON.stringify(payload);
    response.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body),
    });
    response.end(body);
  }

  function sanitizeAlert(alert) {
    return {
      id: alert.id,
      siteId: alert.siteId,
      jurisdictionId: alert.jurisdictionId,
      status: alert.status,
      level: alert.level,
      score: alert.score,
      createdAt: alert.createdAt,
      lastEvaluatedAt: alert.lastEvaluatedAt,
      reassessments: alert.reassessments,
      ruleCodes: alert.triggeredRules.map((r) => r.code),
      suggestedMeasureTypes: alert.suggestedMeasures.map((m) => m.type),
      workOrderId: alert.workOrderId,
      confirmationId: alert.confirmationId,
    };
  }

  function sanitizeWorkOrder(wo) {
    return {
      id: wo.id,
      alertId: wo.alertId,
      siteId: wo.siteId,
      jurisdictionId: wo.jurisdictionId,
      status: wo.status,
      followsWorkOrderId: wo.followsWorkOrderId || null,
      suggestedMeasureTypes: wo.suggestedMeasures.map((m) => m.type),
      selectedMeasures: wo.selectedMeasures,
      disinfestApproval: wo.disinfestApproval,
      scheduledAt: wo.scheduledAt,
      implementedAt: wo.implementedAt,
      verifiedAt: wo.verifiedAt,
      failedAt: wo.failedAt || null,
      createdAt: wo.createdAt,
    };
  }

  // 每个 handler: (params, body, user, request) => payload
  const routes = [];
  const route = (method, pattern, roles, handler) => {
    // pattern 形如 /v1/alerts/:id/basis
    const names = [];
    const regex = new RegExp(
      "^" +
        pattern.replace(/:[^/]+/g, (m) => {
          names.push(m.slice(1));
          return "([^/]+)";
        }) +
        "$"
    );
    routes.push({ method, regex, names, roles, handler });
  };

  // ---------- 公众（无需认证）----------
  route("POST", "/v1/public/reports", "*", async (_p, body) => {
    assertNoAddressDetail(body);
    if (!body.jurisdictionId) throw new HttpError(400, "missing_jurisdiction", "需要选择区域");
    const jurisdiction = store.byId("jurisdictions", body.jurisdictionId);
    if (!jurisdiction) throw new HttpError(404, "jurisdiction_not_found", "区域不存在");
    if (body.siteId) {
      const site = store.byId("sites", body.siteId);
      if (!site || site.jurisdictionId !== body.jurisdictionId) {
        throw new HttpError(422, "bad_site", "点位与区域不匹配");
      }
    }
    const result = recordPublicReport(store, {
      jurisdictionId: body.jurisdictionId,
      siteId: body.siteId,
      at: body.at,
      photoData: body.photoData,
      contact: body.contact,
    });
    return {
      received: true,
      deduplicated: result.duplicated,
      mergedInto: result.mergedInto || null,
      adviceRef: "GET /v1/public/advisories",
    };
  });

  route("GET", "/v1/public/advisories", "*", async () => {
    // 仅发布预防提示正文，不含任何点位、住址细节
    return {
      advisories: store.data.advisories.map((a) => ({
        id: a.id,
        title: a.title,
        body: a.body,
        publishedAt: a.publishedAt,
      })),
    };
  });

  // ---------- 气象与诱捕观测 ----------
  route("POST", "/v1/weather", ["district", "field"], async (_p, body, user) => {
    requireJurisdiction(store, user, body.jurisdictionId);
    if (!store.byId("jurisdictions", body.jurisdictionId)) throw new HttpError(404, "jurisdiction_not_found", "区域不存在");
    const rec = {
      id: store.genId("w"),
      jurisdictionId: body.jurisdictionId,
      at: body.at || nowIso(),
      tempC: body.tempC == null ? null : Number(body.tempC),
      humidityPct: body.humidityPct == null ? null : Number(body.humidityPct),
      rainfallMm: body.rainfallMm == null ? 0 : Number(body.rainfallMm),
      rainEndedAt: body.rainEndedAt || null,
    };
    store.add("weather", rec);
    return { weatherId: rec.id };
  });

  route("POST", "/v1/trap-counts", ["district", "field"], async (_p, body, user) => {
    requireSiteAccess(store, user, body.siteId);
    const rec = {
      id: store.genId("tc"),
      siteId: body.siteId,
      at: body.at || nowIso(),
      trapCount: Number(body.trapCount || 0),
      observer: body.observer || (user ? user.id : null),
    };
    store.add("trapCounts", rec);
    return { trapCountId: rec.id, trapCount: rec.trapCount };
  });

  // ---------- 现场巡查 ----------
  route("POST", "/v1/inspections", ["district", "field"], async (_p, body, user) => {
    requireSiteAccess(store, user, body.siteId);
    if (!body.routeId) throw new HttpError(400, "missing_route", "需要巡查路线标识");
    const site = store.byId("sites", body.siteId);
    const result = recordInspection(store, {
      routeId: body.routeId,
      siteId: body.siteId,
      jurisdictionId: site.jurisdictionId,
      inspectorId: user.id,
      at: body.at,
      findings: body.findings || [],
      photoData: body.photoData,
    });
    return {
      inspectionId: result.inspection.id,
      merged: result.merged,
      duplicatePhotoOf: result.duplicatePhotoOf,
      mergeCount: result.inspection.mergeCount,
    };
  });

  // ---------- 纱窗设施状态更新（修复留痕）----------
  route("PATCH", "/v1/screens/:id", ["district", "field"], async (params, body, user) => {
    const screen = store.byId("screens", params.id);
    if (!screen) throw new HttpError(404, "screen_not_found", "纱窗设施不存在");
    requireSiteAccess(store, user, screen.siteId);
    if (typeof body.intact !== "boolean") throw new HttpError(400, "bad_intact", "需要给出 intact 布尔值");
    screen.intact = body.intact;
    screen.lastCheckedAt = body.at || nowIso();
    return { screenId: screen.id, intact: screen.intact, lastCheckedAt: screen.lastCheckedAt };
  });

  // ---------- 规则评估 ----------
  route("POST", "/v1/evaluations", ["district", "field"], async (_p, body, user) => {
    if (body.jurisdictionId) requireJurisdiction(store, user, body.jurisdictionId);
    return rules.runEvaluation(store, { jurisdictionId: body.jurisdictionId || user.jurisdictionId, at: body.at });
  });

  // ---------- 预警查询 ----------
  route("GET", "/v1/alerts", ["district", "field", "school", "property"], async (_p, _b, user, request) => {
    const url = new URL(request.url, "http://localhost");
    const status = url.searchParams.get("status");
    const jurisdictionId = url.searchParams.get("jurisdictionId");
    const visible = visibleJurisdictionIds(store, user);
    if (jurisdictionId) requireJurisdiction(store, user, jurisdictionId);
    const list = store
      .find("alerts", (a) => {
        if (!visible.has(a.jurisdictionId)) return false;
        if (jurisdictionId && a.jurisdictionId !== jurisdictionId) return false;
        if (status && a.status !== status) return false;
        return true;
      })
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .map(sanitizeAlert);
    return { alerts: list };
  });

  route("GET", "/v1/alerts/:id/basis", ["district", "field", "school", "property"], async (params, _b, user) => {
    requireAlertAccess(store, user, params.id);
    const basis = rules.alertBasis(store, params.id);
    return basis;
  });

  // ---------- 人工确认与工单流转 ----------
  route("POST", "/v1/alerts/:id/confirm", ["district", "field"], async (params, body, user) => {
    requireAlertAccess(store, user, params.id);
    if (typeof body.speciesConfirmed !== "boolean") {
      throw new HttpError(400, "missing_species", "需要明确是否确认隐翅虫");
    }
    const result = workflow.confirm(store, params.id, user.id, body);
    return { outcome: result.outcome, workOrder: sanitizeWorkOrder(result.workOrder) };
  });

  route("POST", "/v1/alerts/:id/measures", ["district", "field"], async (params, body, user) => {
    requireAlertAccess(store, user, params.id);
    const wo = workflow.selectMeasures(store, params.id, user.id, body.types || [], body.note);
    return { workOrder: sanitizeWorkOrder(wo) };
  });

  // 消杀审批仅区级
  route("POST", "/v1/alerts/:id/disinfest-decision", ["district"], async (params, body, user) => {
    requireAlertAccess(store, user, params.id);
    if (typeof body.approved !== "boolean") throw new HttpError(400, "missing_decision", "需要明确批准或驳回");
    const wo = workflow.decideDisinfest(store, params.id, user.id, body.approved, body.note);
    return { workOrder: sanitizeWorkOrder(wo) };
  });

  // 排期/实施允许本辖区学校与物业参与；确认与复查仍由现场/区级负责
  route("POST", "/v1/alerts/:id/schedule", ["district", "field", "school", "property"], async (params, body, user) => {
    requireAlertAccess(store, user, params.id);
    const wo = workflow.schedule(store, params.id, user.id, body.scheduledAt);
    return { workOrder: sanitizeWorkOrder(wo) };
  });

  route("POST", "/v1/alerts/:id/implement", ["district", "field", "school", "property"], async (params, body, user) => {
    requireAlertAccess(store, user, params.id);
    const wo = workflow.implement(store, params.id, user.id, body || {});
    return { workOrder: sanitizeWorkOrder(wo) };
  });

  route("POST", "/v1/alerts/:id/verify", ["district", "field"], async (params, body, user) => {
    requireAlertAccess(store, user, params.id);
    const result = workflow.verify(store, params.id, user.id, body || {});
    return {
      outcome: result.outcome,
      workOrder: sanitizeWorkOrder(result.workOrder),
      followUp: result.followUp ? sanitizeWorkOrder(result.followUp) : null,
    };
  });

  // ---------- 工单 ----------
  route("GET", "/v1/work-orders", ["district", "field", "school", "property"], async (_p, _b, user, request) => {
    const url = new URL(request.url, "http://localhost");
    const status = url.searchParams.get("status");
    const visible = visibleJurisdictionIds(store, user);
    const list = store
      .find("workOrders", (w) => {
        if (!visible.has(w.jurisdictionId)) return false;
        if (status && w.status !== status) return false;
        return true;
      })
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .map(sanitizeWorkOrder);
    return { workOrders: list };
  });

  // ---------- 管理分析 ----------
  route("GET", "/v1/analytics/effect", ["district", "field"], async (_p, _b, user, request) => {
    const url = new URL(request.url, "http://localhost");
    const jurisdictionId = url.searchParams.get("jurisdictionId") || user.jurisdictionId;
    requireJurisdiction(store, user, jurisdictionId);
    const spanDays = Number(url.searchParams.get("spanDays") || 14);
    return analytics.jurisdictionEffect(store, jurisdictionId, { spanDays });
  });

  route("GET", "/v1/analytics/effect/work-orders/:id", ["district", "field", "school", "property"], async (params, _b, user) => {
    const wo = store.byId("workOrders", params.id);
    if (!wo) throw new HttpError(404, "work_order_not_found", "工单不存在");
    requireJurisdiction(store, user, wo.jurisdictionId);
    const result = analytics.workOrderEffect(store, wo.id);
    if (!result) throw new HttpError(404, "work_order_not_found", "工单不存在");
    return result;
  });

  route("GET", "/v1/analytics/unclosed", ["district", "field"], async (_p, _b, user, request) => {
    const url = new URL(request.url, "http://localhost");
    const stallDays = Number(url.searchParams.get("stallDays") || 7);
    const screenDays = Number(url.searchParams.get("screenDays") || 14);
    const result = analytics.unclosedItems(store, { stallDays, screenDays });
    // 学校/物业角色不可访问本接口；区级与现场只返回可见辖区
    const visible = visibleJurisdictionIds(store, user);
    result.brokenScreens = result.brokenScreens.filter((s) => visible.has(s.jurisdictionId));
    result.overdueScreens = result.overdueScreens.filter((s) => visible.has(s.jurisdictionId));
    result.stuckWorkOrders = result.stuckWorkOrders.filter((w) => visible.has(w.jurisdictionId));
    return result;
  });

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    try {
      if (request.method === "GET" && url.pathname === "/health") {
        return sendJson(response, 200, healthPayload());
      }

      const match = routes.find((r) => r.method === request.method && r.regex.test(url.pathname));
      if (!match) throw new HttpError(404, "not_found", "接口不存在");

      const user = match.roles === "*" ? null : authenticate(store, request);
      if (match.roles !== "*") {
        requireRole(user, match.roles);
      }
      const parts = url.pathname.match(match.regex);
      const params = {};
      match.names.forEach((name, i) => (params[name] = decodeURIComponent(parts[i + 1])));
      const body = request.method === "GET" || request.method === "HEAD" ? {} : await readBody(request);
      const payload = await match.handler(params, body, user, request);
      return sendJson(response, 200, payload === undefined ? {} : payload);
    } catch (error) {
      if (error instanceof HttpError) {
        return sendJson(response, error.status, { error: error.code, message: error.message });
      }
      if (error instanceof workflow.WorkflowError) {
        const status = error.code === "alert_not_found" || error.code === "work_order_not_found" ? 404 : 409;
        return sendJson(response, status, { error: error.code, message: error.message });
      }
      return sendJson(response, 500, { error: "internal_error", message: "服务内部错误" });
    }
  });

  server.store = store;
  return server;
}

if (require.main === module) {
  if (process.argv.includes("--check")) {
    if (healthPayload().service !== SERVICE_ID) throw new Error("服务身份不一致");
    const store = seed(createStore());
    if (store.data.sites.length === 0) throw new Error("种子数据异常");
    if (typeof rules.runEvaluation !== "function") throw new Error("规则引擎异常");
    process.stdout.write("基础检查通过\n");
  } else {
    const port = Number(process.env.PORT || 8000);
    createServer().listen(port, "127.0.0.1");
  }
}

module.exports = { SERVICE_ID, SERVICE_NAME, createServer, healthPayload };
