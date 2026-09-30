"use strict";

// HTTP 应用：角色鉴权 + 辖区数据隔离 + 业务路由。
// 区级(district)：全区观测、规则复算、消杀授权、统计与溯源、提示发布。
// 巡查员(inspector)：本辖区巡查、现场核查、实施登记、复查/失效。
// 学校(school)/物业(property)：只能看到并执行本辖区工单。
// 公众(public)：匿名提交发现、获取不含住址细节的预防提示。

const { evaluateRisk } = require("./risk");
const { intakePublicReport, recordPatrolBatch } = require("./dedup");
const {
  createWorkOrder,
  verify,
  authorizeTreatment,
  implement,
  review,
  invalidate,
  httpError,
} = require("./workorder");

function createApp(store, options = {}) {
  const persist = options.persist || (async () => {});

  async function readJson(request) {
    if (request.method === "GET" || request.method === "HEAD") return {};
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) throw httpError(413, "请求体过大", "PAYLOAD_TOO_LARGE");
      chunks.push(chunk);
    }
    if (chunks.length === 0) return {};
    try {
      const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      throw httpError(400, "请求体不是合法 JSON", "BAD_JSON");
    }
  }

  function send(response, status, payload) {
    const body = JSON.stringify(payload);
    response.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body),
      "cache-control": "no-store",
    });
    response.end(body);
  }

  function authenticate(request) {
    const header = request.headers["authorization"] || "";
    const match = /^Bearer\s+(.+)$/.exec(header);
    if (!match) throw httpError(401, "缺少登录令牌", "UNAUTHENTICATED");
    const account = store.accountByToken(match[1].trim());
    if (!account) throw httpError(401, "令牌无效", "UNAUTHENTICATED");
    return account;
  }

  function canAccessArea(account, areaId) {
    if (account.role === "district") return true;
    return account.areaIds.includes(areaId);
  }

  function assertArea(account, areaId) {
    if (!store.getArea(areaId)) throw httpError(404, "区域不存在", "NOT_FOUND");
    if (!canAccessArea(account, areaId)) throw httpError(403, "不可访问其他辖区数据", "FORBIDDEN");
  }

  function requireRole(account, roles) {
    if (!roles.includes(account.role)) {
      throw httpError(403, "当前角色无权执行该操作", "FORBIDDEN");
    }
  }

  function visibleAreas(account) {
    const all = [...store.areas.values()];
    if (account.role === "district") return all;
    return all.filter((area) => account.areaIds.includes(area.id));
  }

  function requireFields(body, fields) {
    for (const field of fields) {
      if (body[field] === undefined || body[field] === null || body[field] === "") {
        throw httpError(400, "缺少必填字段: " + field, "BAD_REQUEST");
      }
    }
  }

  async function handle(request, response) {
    try {
      const url = new URL(request.url, "http://localhost");
      const path = url.pathname.replace(/\/+$/, "") || "/";
      const query = url.searchParams;
      if (!path.startsWith("/api/")) throw httpError(404, "未知路由", "NOT_FOUND");
      let body;
      body = await readJson(request);
      let result;

      // ---- 公众（无需登录）----
      if (path === "/api/public/reports" && request.method === "POST") {
        requireFields(body, ["areaId", "lat", "lng"]);
        const intake = intakePublicReport(store, body);
        await persist();
        result = {
          accepted: true,
          duplicate: intake.duplicated,
          clusterIndependentCount: intake.cluster.independentCount,
          message: "已收到，工作人员会结合气象与现场核查研判",
        };
      } else if (path === "/api/public/advisories" && request.method === "GET") {
        result = {
          advisories: store.advisories
            .slice()
            .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
            .map(publicAdvisoryView),
        };
      } else {
        // ---- 以下全部需要登录 ----
        const account = authenticate(request);

        // ---- 账号视角 ----
        if (path === "/api/me" && request.method === "GET") {
          result = {
            id: account.id,
            name: account.name,
            role: account.role,
            areas: visibleAreas(account).map(areaView),
          };
        }

        // ---- 区域与设施 ----
        else if (path === "/api/areas" && request.method === "GET") {
          result = { areas: visibleAreas(account).map(areaView) };
        } else if (path === "/api/areas" && request.method === "POST") {
          requireRole(account, ["district"]);
          requireFields(body, ["name", "kind", "lat", "lng"]);
          const area = store.addArea(body);
          await persist();
          result = areaView(area);
        } else if (path === "/api/weather" && request.method === "POST") {
          requireRole(account, ["district"]);
          requireFields(body, ["areaId", "observedAt"]);
          assertArea(account, body.areaId);
          const reading = store.addWeather(body);
          await persist();
          result = reading;
        } else if (path === "/api/trap-counts" && request.method === "POST") {
          requireRole(account, ["district", "inspector"]);
          requireFields(body, ["trapId", "capturedAt", "count"]);
          const trap = store.traps.find((t) => t.id === body.trapId);
          if (!trap) throw httpError(404, "诱捕点不存在", "NOT_FOUND");
          assertArea(account, trap.areaId);
          const count = store.addTrapCount({ ...body, areaId: trap.areaId });
          await persist();
          result = count;
        } else if (path === "/api/facilities" && request.method === "GET") {
          result = facilitiesView(store, account, query.get("areaId"));
        } else if (facilityCreateMatch(path)) {
          const kind = facilityCreateMatch(path)[1];
          if (request.method !== "POST") throw httpError(405, "方法不允许", "METHOD_NOT_ALLOWED");
          requireRole(account, ["district"]);
          requireFields(body, ["areaId", "name", "lat", "lng"]);
          assertArea(account, body.areaId);
          result = createFacility(store, kind, body);
          await persist();
        } else if (facilityPatchMatch(path)) {
          const [, kind, id] = facilityPatchMatch(path);
          if (request.method !== "PATCH") throw httpError(405, "方法不允许", "METHOD_NOT_ALLOWED");
          requireRole(account, ["district"]);
          result = patchFacility(store, kind, id, body, account);
          await persist();
        }

        // ---- 巡查批次 ----
        else if (path === "/api/patrols" && request.method === "POST") {
          requireRole(account, ["district", "inspector"]);
          assertArea(account, body.areaId);
          const batch = recordPatrolBatch(store, account, body);
          await persist();
          result = batch;
        } else if (path === "/api/patrols" && request.method === "GET") {
          const areaId = query.get("areaId");
          if (areaId) assertArea(account, areaId);
          const allowed = new Set(visibleAreas(account).map((a) => a.id));
          result = {
            records: store.patrolRecords.filter(
              (r) => allowed.has(r.areaId) && (!areaId || r.areaId === areaId),
            ),
          };
        }

        // ---- 风险复算与点位 ----
        else if (path === "/api/risk/evaluate" && request.method === "POST") {
          requireRole(account, ["district", "inspector"]);
          if (body.areaId) assertArea(account, body.areaId);
          const run = evaluateRisk(store, {
            at: body.at,
            areaId: body.areaId,
            generatedBy: account.id,
          });
          await persist();
          result = runView(store, run);
        } else if (path === "/api/risk/runs" && request.method === "GET") {
          const areaId = query.get("areaId");
          if (areaId) assertArea(account, areaId);
          result = {
            runs: store.riskRuns
              .slice(-20)
              .reverse()
              .map((r) => runView(store, r, visibleAreas(account))),
          };
        } else if (riskRunMatch(path)) {
          const id = riskRunMatch(path)[1];
          if (request.method !== "GET") throw httpError(405, "方法不允许", "METHOD_NOT_ALLOWED");
          const run = store.riskRuns.find((r) => r.id === id);
          if (!run) throw httpError(404, "研判运行不存在", "NOT_FOUND");
          assertRunVisible(account, run);
          const scopeAreas = visibleAreas(account);
          if (path.endsWith("/explain")) {
            result = explainRun(store, run, scopeAreas, query.get("areaId"));
          } else {
            result = runView(store, run, scopeAreas);
          }
        } else if (path === "/api/risk/points" && request.method === "GET") {
          const areaId = query.get("areaId");
          if (areaId) assertArea(account, areaId);
          const allowed = new Set(visibleAreas(account).map((a) => a.id));
          const status = query.get("status");
          result = {
            points: store.riskPoints
              .filter((p) => allowed.has(p.areaId))
              .filter((p) => (!areaId || p.areaId === areaId) && (!status || p.status === status))
              .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
              .map((p) => riskPointView(store, p)),
          };
        } else if (riskPointMatch(path)) {
          const id = riskPointMatch(path)[1];
          if (request.method !== "GET") throw httpError(405, "方法不允许", "METHOD_NOT_ALLOWED");
          const point = store.getRiskPoint(id);
          if (!point) throw httpError(404, "风险点位不存在", "NOT_FOUND");
          assertArea(account, point.areaId);
          result = riskPointView(store, point, { detailed: true });
        }

        // ---- 工单 ----
        else if (path === "/api/work-orders" && request.method === "POST") {
          requireRole(account, ["district", "inspector"]);
          const point = store.getRiskPoint(body.riskPointId);
          if (!point) throw httpError(404, "风险点位不存在", "NOT_FOUND");
          assertArea(account, point.areaId);
          const order = createWorkOrder(store, account, body.riskPointId);
          await persist();
          result = orderView(order);
        } else if (path === "/api/work-orders" && request.method === "GET") {
          result = { orders: listOrders(store, account, query) };
        } else if (workOrderMatch(path)) {
          const [, id, action] = workOrderMatch(path);
          const order = store.getWorkOrder(id);
          if (!order) throw httpError(404, "工单不存在", "NOT_FOUND");
          assertArea(account, order.areaId);
          if (request.method !== "POST") throw httpError(405, "方法不允许", "METHOD_NOT_ALLOWED");

          if (action === "verify") {
            requireRole(account, ["district", "inspector"]);
            result = orderView(verify(store, account, id, body));
          } else if (action === "treatment-authorization") {
            requireRole(account, ["district"]);
            result = orderView(authorizeTreatment(store, account, id, body));
          } else if (action === "implement") {
            requireRole(account, ["district", "inspector", "school", "property"]);
            result = orderView(implement(store, account, id, body));
          } else if (action === "review") {
            requireRole(account, ["district", "inspector"]);
            result = orderView(review(store, account, id, body));
          } else if (action === "invalidate") {
            requireRole(account, ["district", "inspector"]);
            result = orderView(invalidate(store, account, id, body));
          } else {
            throw httpError(404, "未知工单操作", "NOT_FOUND");
          }
          await persist();
        }

        // ---- 统计 ----
        else if (path === "/api/stats/effectiveness" && request.method === "GET") {
          const areaId = query.get("areaId");
          if (areaId) assertArea(account, areaId);
          result = effectivenessStats(store, account, {
            areaId,
            days: Number(query.get("days") || 14),
          });
        } else if (path === "/api/stats/open-items" && request.method === "GET") {
          const areaId = query.get("areaId");
          if (areaId) assertArea(account, areaId);
          result = openItemsStats(store, account, {
            areaId,
            staleDays: Number(query.get("staleDays") || 14),
          });
        }

        // ---- 预防提示管理 ----
        else if (path === "/api/advisories" && request.method === "POST") {
          requireRole(account, ["district"]);
          requireFields(body, ["title", "content"]);
          const advisory = store.addAdvisory({
            id: "adv_" + Math.random().toString(36).slice(2, 10),
            areaId: body.areaId || null,
            title: String(body.title).slice(0, 100),
            content: String(body.content).slice(0, 1000),
            publishedAt: new Date().toISOString(),
            publishedBy: account.id,
          });
          await persist();
          result = publicAdvisoryView(advisory);
        } else {
          throw httpError(404, "未知路由", "NOT_FOUND");
        }
      }

      if (result === undefined) throw httpError(404, "未知路由", "NOT_FOUND");
      send(response, 200, result);
    } catch (error) {
      const status = error.status || 400;
      send(response, status, {
        error: error.code || "ERROR",
        message: error.message || "请求处理失败",
      });
    }
  }

  function assertRunVisible(account, run) {
    const allowed = new Set(visibleAreas(account).map((a) => a.id));
    if (!run.scopeAreaIds.some((id) => allowed.has(id))) {
      throw httpError(403, "不可访问其他辖区数据", "FORBIDDEN");
    }
  }

  function listOrders(store, account, query) {
    const allowed = new Set(visibleAreas(account).map((a) => a.id));
    const areaId = query.get("areaId");
    const status = query.get("status");
    return store.workOrders
      .filter((o) => allowed.has(o.areaId))
      .filter((o) => (!areaId || o.areaId === areaId) && (!status || o.status === status))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(orderView);
  }

  return { handle };
}

// ---------------- 视图与统计 ----------------

function areaView(area) {
  // 公众可见的区域信息不含门牌住址；内部视图也仅保留坐标与类型
  return { ...area };
}

function facilitiesView(store, account, areaId) {
  if (areaId) {
    if (!canAccessAreaStatic(account, areaId, store)) {
      throw httpError(403, "不可访问其他辖区数据", "FORBIDDEN");
    }
  }
  const allowed = new Set(
    (account.role === "district"
      ? [...store.areas.values()]
      : [...store.areas.values()].filter((a) => account.areaIds.includes(a.id))
    ).map((a) => a.id),
  );
  const inScope = (item) => allowed.has(item.areaId) && (!areaId || item.areaId === areaId);
  return {
    traps: store.traps.filter(inScope),
    lamps: store.lamps.filter(inScope),
    screens: store.screens.filter(inScope),
    waterSites: store.waterSites.filter(inScope),
  };
}

function canAccessAreaStatic(account, areaId, store) {
  if (!store.getArea(areaId)) throw httpError(404, "区域不存在", "NOT_FOUND");
  if (account.role === "district") return true;
  return account.areaIds.includes(areaId);
}

function createFacility(store, kind, body) {
  if (kind === "lamps") return store.addLamp(body);
  if (kind === "screens") return store.addScreen(body);
  if (kind === "water-sites") return store.addWaterSite(body);
  if (kind === "traps") return store.addTrap(body);
  throw httpError(404, "未知设施类型", "NOT_FOUND");
}

function patchFacility(store, kind, id, body) {
  if (kind === "lamps") {
    const lamp = store.updateLamp(id, body);
    if (!lamp) throw httpError(404, "灯具不存在", "NOT_FOUND");
    return lamp;
  }
  if (kind === "screens") {
    const screen = store.updateScreen(id, body);
    if (!screen) throw httpError(404, "纱窗设施不存在", "NOT_FOUND");
    return screen;
  }
  if (kind === "water-sites") {
    const site = store.updateWaterSite(id, body);
    if (!site) throw httpError(404, "绿化水体点不存在", "NOT_FOUND");
    return site;
  }
  throw httpError(404, "未知设施类型", "NOT_FOUND");
}

function facilityCreateMatch(path) {
  return /^\/api\/facilities\/(lamps|screens|water-sites|traps)$/.exec(path);
}

function facilityPatchMatch(path) {
  return /^\/api\/facilities\/(lamps|screens|water-sites)\/([\w-]+)$/.exec(path);
}

function riskRunMatch(path) {
  return /^\/api\/risk\/runs\/([\w-]+?)(\/explain)?$/.exec(path);
}

function riskPointMatch(path) {
  return /^\/api\/risk\/points\/([\w-]+)$/.exec(path);
}

function workOrderMatch(path) {
  return /^\/api\/work-orders\/([\w-]+)(?:\/(verify|treatment-authorization|implement|review|invalidate))?$/.exec(
    path,
  );
}

function runView(store, run, scopeAreas) {
  const allowed = scopeAreas ? new Set(scopeAreas.map((a) => a.id)) : null;
  const summaries = run.areaSummaries.filter((s) => !allowed || allowed.has(s.areaId));
  const pointIds = allowed
    ? run.pointIds.filter((id) => {
        const point = store.getRiskPoint(id);
        return point && allowed.has(point.areaId);
      })
    : run.pointIds;
  const points = pointIds.map((id) => store.getRiskPoint(id)).filter(Boolean);
  const levels = levelsOf(points);
  return {
    id: run.id,
    generatedAt: run.generatedAt,
    generatedBy: run.generatedBy,
    seasonActive: run.seasonActive,
    alert: allowed ? levels.high > 0 || levels.warning >= 3 : run.alert,
    pointLevels: levels,
    thresholds: run.thresholds,
    areaSummaries: summaries,
    pointIds,
  };
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

function riskPointView(store, point, options = {}) {
  const view = {
    id: point.id,
    runId: point.runId,
    areaId: point.areaId,
    kind: point.kind,
    title: point.title,
    level: point.level,
    score: point.score,
    status: point.status,
    reasons: point.reasons,
    suggestedMeasures: point.suggestedMeasures,
    orderId: point.orderId,
    generatedAt: point.generatedAt,
    updatedAt: point.updatedAt,
  };
  if (point.clearReason) view.clearReason = point.clearReason;
  if (point.verification) view.verification = point.verification;
  if (options.detailed) {
    view.lat = point.lat;
    view.lng = point.lng;
    view.evidence = point.evidence;
  }
  return view;
}

function orderView(order) {
  return {
    id: order.id,
    riskPointId: order.riskPointId,
    areaId: order.areaId,
    title: order.title,
    level: order.level,
    status: order.status,
    suggestedMeasures: order.suggestedMeasures,
    authorizedMeasures: order.authorizedMeasures,
    implementedMeasures: order.implementedMeasures,
    speciesConfirmed: order.speciesConfirmed,
    environmentConfirmed: order.environmentConfirmed,
    reopenedCount: order.reopenedCount,
    createdAt: order.createdAt,
    createdBy: order.createdBy,
    closedAt: order.closedAt,
    events: order.events,
  };
}

function publicAdvisoryView(advisory) {
  // 不含区域编号、坐标、住址等可定位细节
  return {
    title: advisory.title,
    content: advisory.content,
    publishedAt: advisory.publishedAt,
  };
}

// 预警溯源：解析某次研判引用了哪些气象、诱捕、聚类、巡查记录与人工确认。
function explainRun(store, run, scopeAreas, areaIdFilter) {
  const allowed = new Set(scopeAreas.map((a) => a.id));
  const points = run.pointIds
    .map((id) => store.getRiskPoint(id))
    .filter(Boolean)
    .filter((p) => allowed.has(p.areaId))
    .filter((p) => !areaIdFilter || p.areaId === areaIdFilter);

  const weatherIds = new Set();
  const trapCountIds = new Set();
  const clusterIds = new Set();
  const patrolIds = new Set();
  const facilityIds = new Set();

  for (const point of points) {
    for (const id of point.evidence.weatherReadingIds || []) weatherIds.add(id);
    for (const id of point.evidence.trapCountIds || []) trapCountIds.add(id);
    for (const id of point.evidence.clusterIds || []) clusterIds.add(id);
    for (const id of point.evidence.patrolRecordIds || []) patrolIds.add(id);
    for (const id of point.evidence.facilityIds || []) facilityIds.add(id);
  }

  const manualConfirmations = [];
  for (const point of points) {
    if (!point.orderId) continue;
    const order = store.getWorkOrder(point.orderId);
    if (!order) continue;
    for (const event of order.events) {
      if (event.action === "verify_confirm" || event.action === "authorize_treatment") {
        manualConfirmations.push({
          orderId: order.id,
          action: event.action,
          at: event.at,
          actor: event.actor,
          note: event.note,
          details: event.details,
        });
      }
    }
  }

  return {
    runId: run.id,
    generatedAt: run.generatedAt,
    alert: run.alert,
    thresholds: run.thresholds,
    areaContext: run.areaSummaries.filter(
      (s) => allowed.has(s.areaId) && (!areaIdFilter || s.areaId === areaIdFilter),
    ),
    points: points.map((p) => ({
      id: p.id,
      areaId: p.areaId,
      title: p.title,
      level: p.level,
      score: p.score,
      status: p.status,
      reasons: p.reasons,
      evidence: p.evidence,
    })),
    evidence: {
      weatherReadings: store.weatherReadings.filter((r) => weatherIds.has(r.id)),
      trapCounts: store.trapCounts.filter((c) => trapCountIds.has(c.id)),
      clusters: store.reportClusters
        .filter((c) => clusterIds.has(c.id))
        .map((c) => ({
          id: c.id,
          areaId: c.areaId,
          firstSeenAt: c.firstSeenAt,
          lastSeenAt: c.lastSeenAt,
          independentCount: c.independentCount,
          duplicateCount: c.duplicateCount || 0,
          reportIds: c.reportIds,
        })),
      patrolRecords: store.patrolRecords
        .filter((r) => patrolIds.has(r.id))
        .map((r) => ({
          id: r.id,
          routeId: r.routeId,
          batchId: r.batchId,
          kind: r.kind,
          observedAt: r.observedAt,
          findings: r.findings,
          inspectorName: r.inspectorName,
        })),
      facilities: [
        ...store.lamps.filter((f) => facilityIds.has(f.id)),
        ...store.screens.filter((f) => facilityIds.has(f.id)),
        ...store.waterSites.filter((f) => facilityIds.has(f.id)),
        ...store.traps.filter((f) => facilityIds.has(f.id)),
      ],
      manualConfirmations,
    },
  };
}

// 处理前后对比：以每张工单首次实施时间为界，比较前后窗口内
// 诱捕量与去重后独立公众目击数。
function effectivenessStats(store, account, { areaId, days }) {
  const allowed = new Set(
    (account.role === "district"
      ? [...store.areas.values()]
      : [...store.areas.values()].filter((a) => account.areaIds.includes(a.id))
    ).map((a) => a.id),
  );
  const windowMs = days * 24 * 3600 * 1000;

  const orders = store.workOrders
    .filter((o) => allowed.has(o.areaId) && (!areaId || o.areaId === areaId))
    .filter((o) => o.implementedMeasures.length > 0);

  const perOrder = orders.map((order) => {
    const implementedEvent = order.events.find((e) => e.action === "implement");
    const atMs = implementedEvent ? Date.parse(implementedEvent.at) : Date.now();
    const before = windowCounts(store, order.areaId, atMs - windowMs, atMs);
    const after = windowCounts(store, order.areaId, atMs, atMs + windowMs);
    return {
      orderId: order.id,
      areaId: order.areaId,
      title: order.title,
      status: order.status,
      implementedAt: implementedEvent ? implementedEvent.at : null,
      implementedMeasures: order.implementedMeasures,
      before: scaleWindow(before, days),
      after: scaleWindow(after, Math.min(days, Math.max(1, (Date.now() - atMs) / 86400000))),
      changePct: pctChange(
        scaleWindow(before, days).trapPerDay,
        scaleWindow(after, Math.min(days, Math.max(1, (Date.now() - atMs) / 86400000))).trapPerDay,
      ),
      reopenedCount: order.reopenedCount,
    };
  });

  const areaAgg = new Map();
  for (const item of perOrder) {
    if (!areaAgg.has(item.areaId)) {
      areaAgg.set(item.areaId, { areaId: item.areaId, beforeTrap: 0, afterTrap: 0, beforeReports: 0, afterReports: 0, orders: 0 });
    }
    const agg = areaAgg.get(item.areaId);
    agg.beforeTrap += item.before.trapTotal;
    agg.afterTrap += item.after.trapTotal;
    agg.beforeReports += item.before.independentReports;
    agg.afterReports += item.after.independentReports;
    agg.orders += 1;
  }

  return {
    windowDays: days,
    generatedAt: new Date().toISOString(),
    areas: [...areaAgg.values()].map((agg) => ({
      ...agg,
      trapChangePct: pctChange(agg.beforeTrap, agg.afterTrap),
      reportChangePct: pctChange(agg.beforeReports, agg.afterReports),
    })),
    orders: perOrder,
  };
}

function windowCounts(store, areaId, fromMs, toMs) {
  const boundedTo = Math.min(toMs, Date.now());
  let trapTotal = 0;
  for (const c of store.trapCounts) {
    if (c.areaId !== areaId) continue;
    const t = Date.parse(c.capturedAt);
    if (t >= fromMs && t < boundedTo) trapTotal += c.count;
  }
  let independentReports = 0;
  for (const r of store.publicReports) {
    if (r.areaId !== areaId || r.status !== "unique") continue;
    const t = Date.parse(r.observedAt);
    if (t >= fromMs && t < boundedTo) independentReports += 1;
  }
  return { trapTotal, independentReports, spanDays: Math.max((boundedTo - fromMs) / 86400000, 0.0001) };
}

function scaleWindow(counts, days) {
  const span = Math.min(counts.spanDays, days);
  return {
    trapTotal: counts.trapTotal,
    independentReports: counts.independentReports,
    trapPerDay: round1(counts.trapTotal / Math.max(span, 0.0001)),
    reportsPerDay: round1(counts.independentReports / Math.max(span, 0.0001)),
  };
}

function pctChange(before, after) {
  if (!before) return after > 0 ? null : 0;
  return Math.round(((after - before) / before) * 100);
}

// 长期未闭环：破损纱窗、未调光强光灯、积水点、滞留/反复重开工单。
function openItemsStats(store, account, { areaId, staleDays }) {
  const allowed = new Set(
    (account.role === "district"
      ? [...store.areas.values()]
      : [...store.areas.values()].filter((a) => account.areaIds.includes(a.id))
    ).map((a) => a.id),
  );
  const nowMs = Date.now();
  const ageDays = (iso) => (iso ? Math.floor((nowMs - Date.parse(iso)) / 86400000) : null);
  const inScope = (item) => allowed.has(item.areaId) && (!areaId || item.areaId === areaId);

  const brokenScreens = store.screens
    .filter((s) => inScope(s) && !s.intact)
    .map((s) => ({
      id: s.id,
      areaId: s.areaId,
      name: s.name,
      damagedSince: s.damagedSince,
      openDays: ageDays(s.damagedSince),
      overdue: ageDays(s.damagedSince) >= staleDays,
    }));

  const unadjustedLamps = store.lamps
    .filter((s) => inScope(s) && !s.adjusted && ["white_strong", "uv_adhesive"].includes(s.lampType))
    .map((l) => ({
      id: l.id,
      areaId: l.areaId,
      name: l.name,
      lampType: l.lampType,
      openDays: ageDays(l.createdAt),
      overdue: ageDays(l.createdAt) >= staleDays,
    }));

  const untidyWater = store.waterSites
    .filter((w) => inScope(w) && (w.standingWater || !w.tidy))
    .map((w) => ({
      id: w.id,
      areaId: w.areaId,
      name: w.name,
      standingWater: w.standingWater,
      tidy: w.tidy,
      openDays: ageDays(w.lastCheckedAt),
      overdue: ageDays(w.lastCheckedAt) >= staleDays,
    }));

  const staleOrders = store.workOrders
    .filter((o) => inScope(o) && !["closed", "dismissed"].includes(o.status))
    .map((o) => {
      const lastEvent = o.events[o.events.length - 1];
      const openDays = ageDays(o.createdAt);
      return {
        id: o.id,
        areaId: o.areaId,
        title: o.title,
        status: o.status,
        reopenedCount: o.reopenedCount,
        speciesConfirmed: o.speciesConfirmed,
        lastEventAction: lastEvent ? lastEvent.action : null,
        lastEventAt: lastEvent ? lastEvent.at : o.createdAt,
        openDays,
        overdue: openDays >= staleDays || o.reopenedCount >= 2,
      };
    })
    .filter((o) => o.overdue);

  return {
    generatedAt: new Date().toISOString(),
    staleDays,
    summary: {
      brokenScreens: brokenScreens.length,
      unadjustedLamps: unadjustedLamps.length,
      untidyWaterSites: untidyWater.length,
      staleOrders: staleOrders.length,
    },
    brokenScreens,
    unadjustedLamps,
    untidyWaterSites: untidyWater,
    staleOrders,
  };
}

function round1(v) {
  return Math.round(v * 10) / 10;
}

module.exports = { createApp };
