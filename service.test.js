"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createServer, healthPayload } = require("./service");

const FIELD = "Bearer u_field1";
const DISTRICT = "Bearer u_district";
const SCHOOL = "Bearer u_school";
const PROPERTY = "Bearer u_property";

// 固定在隐翅虫活跃季节（初夏）开展演练
const T0 = "2026-06-15T12:00:00.000Z";

async function withServer(run) {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    await run("http://127.0.0.1:" + address.port, server);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function call(base, method, path, token, body) {
  const response = await fetch(base + path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: token } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json().catch(() => ({}));
  return { status: response.status, json };
}

// 构造一次"雨后高温高湿 + 诱捕上升"的场景
async function seedSchoolOutbreak(base) {
  await call(base, "POST", "/v1/weather", FIELD, {
    jurisdictionId: "j_district",
    at: T0,
    tempC: 26,
    humidityPct: 82,
    rainfallMm: 12,
    rainEndedAt: "2026-06-15T06:00:00.000Z",
  });
  // 上一诱捕窗口仅 1 只
  await call(base, "POST", "/v1/trap-counts", FIELD, {
    siteId: "s_school_lamp", at: "2026-06-10T12:00:00.000Z", trapCount: 1,
  });
  // 当前窗口 4 只，明显上升
  await call(base, "POST", "/v1/trap-counts", FIELD, {
    siteId: "s_school_lamp", at: "2026-06-14T20:00:00.000Z", trapCount: 4,
  });
}

test("健康检查返回稳定身份", async () => {
  await withServer(async (base) => {
    const response = await fetch(base + "/health");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), healthPayload());
  });
});

test("未知路由返回不存在", async () => {
  await withServer(async (base) => {
    const response = await fetch(base + "/unknown");
    assert.equal(response.status, 404);
  });
});

test("公众发现：重复照片与同时间桶补传不制造新热点", async () => {
  await withServer(async (base) => {
    const first = await call(base, "POST", "/v1/public/reports", null, {
      jurisdictionId: "j_property", siteId: "s_garden", at: T0, photoData: "img-bytes-A",
    });
    assert.equal(first.status, 200);
    assert.equal(first.json.deduplicated, false);

    // 同照片再次提交
    const dupPhoto = await call(base, "POST", "/v1/public/reports", null, {
      jurisdictionId: "j_property", siteId: "s_garden", at: T0, photoData: "img-bytes-A",
    });
    assert.equal(dupPhoto.json.deduplicated, true);
    assert.ok(dupPhoto.json.mergedInto, "重复照片应指向被合并的原始信号");

    // 无照片、同一小时内的文字上报合并
    const dupBucket = await call(base, "POST", "/v1/public/reports", null, {
      jurisdictionId: "j_property", siteId: "s_garden", at: "2026-06-15T12:40:00.000Z",
    });
    assert.equal(dupBucket.json.deduplicated, true);

    // 独立信号（另一时间）应被接受
    const another = await call(base, "POST", "/v1/public/reports", null, {
      jurisdictionId: "j_property", siteId: "s_garden", at: "2026-06-16T08:00:00.000Z",
    });
    assert.equal(another.json.deduplicated, false);
  });
});

test("公众发现拒绝门牌住址等精确定位", async () => {
  await withServer(async (base) => {
    const res = await call(base, "POST", "/v1/public/reports", null, {
      jurisdictionId: "j_property", at: T0, addressDetail: "3栋201室",
    });
    assert.equal(res.status, 422);
    assert.equal(res.json.error, "address_not_allowed");
  });
});

test("公众预防提示不含住址与点位细节", async () => {
  await withServer(async (base) => {
    const res = await call(base, "GET", "/v1/public/advisories");
    assert.equal(res.status, 200);
    const text = JSON.stringify(res.json);
    assert.match(text, /隐翅虫/);
    assert.doesNotMatch(text, /内部点位明细/);
    assert.doesNotMatch(text, /s_school_lamp/);
  });
});

test("同一路线对同一点位的补传合并而非新增", async () => {
  await withServer(async (base) => {
    const a = await call(base, "POST", "/v1/inspections", FIELD, {
      routeId: "route-7", siteId: "s_garden", at: T0, findings: ["路灯下见虫"], photoData: "route7-photo",
    });
    const b = await call(base, "POST", "/v1/inspections", FIELD, {
      routeId: "route-7", siteId: "s_garden", at: "2026-06-15T20:00:00.000Z", findings: ["补充照片"],
    });
    assert.equal(b.json.merged, true);
    assert.equal(b.json.inspectionId, a.json.inspectionId);
    assert.equal(b.json.mergeCount, 1);

    // 重复照片在不同路线出现时被标记，不作为新影像证据
    const c = await call(base, "POST", "/v1/inspections", FIELD, {
      routeId: "route-9", siteId: "s_waterside", at: T0, findings: ["疑似"], photoData: "route7-photo",
    });
    assert.equal(c.json.merged, false);
    assert.ok(c.json.duplicatePhotoOf);
  });
});

test("规则引擎命中雨后温湿度与诱捕上升，重复评估复用预警", async () => {
  await withServer(async (base) => {
    await seedSchoolOutbreak(base);
    const eval1 = await call(base, "POST", "/v1/evaluations", FIELD, { jurisdictionId: "j_school", at: T0 });
    assert.equal(eval1.status, 200);
    assert.equal(eval1.json.created.length, 1, "仅有学校点位达到中高风险");
    const alertId = eval1.json.created[0];

    // 再次评估不产生新预警/工单
    const eval2 = await call(base, "POST", "/v1/evaluations", FIELD, { jurisdictionId: "j_school", at: T0 });
    assert.deepEqual(eval2.json.created, []);
    assert.deepEqual(eval2.json.reused, [alertId]);

    const basis = await call(base, "GET", `/v1/alerts/${alertId}/basis`, FIELD);
    const codes = basis.json.rules.map((r) => r.code);
    assert.ok(codes.includes("post_rain_warm_humid"));
    assert.ok(codes.includes("trap_surge"));
    assert.ok(codes.includes("phototaxis_lighting"));
    assert.ok(codes.includes("screen_damaged"));
    assert.equal(basis.json.weather.tempC, 26);
    assert.equal(basis.json.weather.humidityPct, 82);
    // 建议里环境措施齐备，消杀仅作为需审批备选
    const measureTypes = basis.json.workOrder.suggestedMeasures.map((m) => m.type);
    assert.ok(measureTypes.includes("light_adjust"));
    assert.ok(measureTypes.includes("cleanup"));
    assert.ok(measureTypes.includes("seal"));
    assert.ok(measureTypes.includes("disinfest"));
  });
});

test("未确认虫种前不能选择或安排措施", async () => {
  await withServer(async (base) => {
    await seedSchoolOutbreak(base);
    const { json: evalJson } = await call(base, "POST", "/v1/evaluations", FIELD, { jurisdictionId: "j_school", at: T0 });
    const alertId = evalJson.created[0];

    const early = await call(base, "POST", `/v1/alerts/${alertId}/measures`, FIELD, { types: ["cleanup"] });
    assert.equal(early.status, 409);

    const scheduled = await call(base, "POST", `/v1/alerts/${alertId}/schedule`, FIELD, {});
    assert.equal(scheduled.status, 409);
  });
});

test("确认排除虫种则取消工单并解除预警", async () => {
  await withServer(async (base) => {
    await seedSchoolOutbreak(base);
    const { json: evalJson } = await call(base, "POST", "/v1/evaluations", FIELD, { jurisdictionId: "j_school", at: T0 });
    const alertId = evalJson.created[0];
    const res = await call(base, "POST", `/v1/alerts/${alertId}/confirm`, FIELD, {
      at: T0, speciesConfirmed: false, note: "为其他甲虫",
    });
    assert.equal(res.json.outcome, "dismissed");
    assert.equal(res.json.workOrder.status, "cancelled");
  });
});

test("完整闭环：确认后选措施，消杀须区级审批，复查通过", async () => {
  await withServer(async (base) => {
    await seedSchoolOutbreak(base);
    const { json: evalJson } = await call(base, "POST", "/v1/evaluations", FIELD, { jurisdictionId: "j_school", at: T0 });
    const alertId = evalJson.created[0];

    await call(base, "POST", `/v1/alerts/${alertId}/confirm`, FIELD, {
      at: T0, speciesConfirmed: true, density: "high",
      envChecks: { lighting: true, screenGap: true, mulch: true },
    });

    // 不能选择建议之外的措施
    const bad = await call(base, "POST", `/v1/alerts/${alertId}/measures`, FIELD, { types: ["burn"] });
    assert.equal(bad.status, 409);
    assert.equal(bad.json.error, "measure_not_suggested");

    await call(base, "POST", `/v1/alerts/${alertId}/measures`, FIELD, {
      types: ["light_adjust", "cleanup", "seal", "disinfest"],
    });

    // 消杀未审批不能排期
    const blocked = await call(base, "POST", `/v1/alerts/${alertId}/schedule`, FIELD, {
      scheduledAt: "2026-06-16T09:00:00.000Z",
    });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.json.error, "disinfest_requires_approval");

    // 现场人员与物业都不能审批消杀
    assert.equal((await call(base, "POST", `/v1/alerts/${alertId}/disinfest-decision`, FIELD, { approved: true })).status, 403);
    assert.equal((await call(base, "POST", `/v1/alerts/${alertId}/disinfest-decision`, PROPERTY, { approved: true })).status, 403);

    const approval = await call(base, "POST", `/v1/alerts/${alertId}/disinfest-decision`, DISTRICT, {
      approved: true, note: "限靶向施药，避开水体",
    });
    assert.equal(approval.json.workOrder.disinfestApproval, "approved");

    await call(base, "POST", `/v1/alerts/${alertId}/schedule`, SCHOOL, {
      scheduledAt: "2026-06-16T09:00:00.000Z",
    });
    const implemented = await call(base, "POST", `/v1/alerts/${alertId}/implement`, SCHOOL, {
      at: "2026-06-16T10:00:00.000Z", details: "改暖光、清落叶、修纱窗，靶向处理一处",
    });
    assert.equal(implemented.json.workOrder.status, "implemented");

    const verified = await call(base, "POST", `/v1/alerts/${alertId}/verify`, FIELD, {
      at: "2026-06-23T10:00:00.000Z", passed: true,
    });
    assert.equal(verified.json.outcome, "verified");
    assert.equal(verified.json.workOrder.status, "verified");
  });
});

test("复查失效留痕并派生再处置工单", async () => {
  await withServer(async (base) => {
    // 社区花园点位制造高风险
    await call(base, "POST", "/v1/weather", FIELD, {
      jurisdictionId: "j_district", at: T0, tempC: 27, humidityPct: 80, rainfallMm: 8,
      rainEndedAt: "2026-06-15T08:00:00.000Z",
    });
    await call(base, "POST", "/v1/trap-counts", FIELD, {
      siteId: "s_garden", at: "2026-06-14T21:00:00.000Z", trapCount: 3,
    });
    const { json: evalJson } = await call(base, "POST", "/v1/evaluations", FIELD, { jurisdictionId: "j_property", at: T0 });
    // 雨后辖区内可能有多个点位命中，按点位选出社区花园预警
    let gardenAlert = null;
    for (const id of evalJson.created) {
      const b = await call(base, "GET", `/v1/alerts/${id}/basis`, FIELD);
      if (b.json.alert.siteId === "s_garden") gardenAlert = id;
    }
    assert.ok(gardenAlert);
    const basisBefore = await call(base, "GET", `/v1/alerts/${gardenAlert}/basis`, FIELD);
    assert.equal(basisBefore.json.alert.siteId, "s_garden");

    await call(base, "POST", `/v1/alerts/${gardenAlert}/confirm`, FIELD, { at: T0, speciesConfirmed: true, density: "medium" });
    await call(base, "POST", `/v1/alerts/${gardenAlert}/measures`, FIELD, { types: ["light_adjust", "cleanup"] });
    await call(base, "POST", `/v1/alerts/${gardenAlert}/schedule`, FIELD, { scheduledAt: "2026-06-16T09:00:00.000Z" });
    await call(base, "POST", `/v1/alerts/${gardenAlert}/implement`, FIELD, { at: "2026-06-16T10:00:00.000Z" });
    const failed = await call(base, "POST", `/v1/alerts/${gardenAlert}/verify`, FIELD, {
      at: "2026-06-20T10:00:00.000Z", passed: false, note: "雨后积水未清，仍见虫",
    });
    assert.equal(failed.json.outcome, "failed");
    assert.equal(failed.json.workOrder.status, "failed");
    assert.equal(failed.json.followUp.status, "pending_confirm");
    assert.equal(failed.json.followUp.followsWorkOrderId, failed.json.workOrder.id);
  });
});

test("学校与物业只能看到本辖区工单，跨辖区访问被拒", async () => {
  await withServer(async (base) => {
    await seedSchoolOutbreak(base);
    await call(base, "POST", "/v1/evaluations", FIELD, { jurisdictionId: "j_school", at: T0 });

    const schoolList = await call(base, "GET", "/v1/work-orders", SCHOOL);
    assert.equal(schoolList.json.workOrders.length, 1);
    assert.equal(schoolList.json.workOrders[0].jurisdictionId, "j_school");

    const propertyList = await call(base, "GET", "/v1/work-orders", PROPERTY);
    assert.equal(propertyList.json.workOrders.length, 0);

    const schoolAlerts = await call(base, "GET", "/v1/alerts", SCHOOL);
    const schoolAlertId = schoolAlerts.json.alerts[0].id;
    const cross = await call(base, "GET", `/v1/alerts/${schoolAlertId}/basis`, PROPERTY);
    assert.equal(cross.status, 403);
    assert.equal(cross.json.error, "outside_jurisdiction");

    // 公众与学校角色无权触发评估
    assert.equal((await call(base, "POST", "/v1/evaluations", SCHOOL, {})).status, 403);
    assert.equal((await call(base, "POST", "/v1/evaluations", null, {})).status, 401);
  });
});

test("措施前后诱捕与报告变化可量化对比", async () => {
  await withServer(async (base) => {
    await seedSchoolOutbreak(base);
    const { json: evalJson } = await call(base, "POST", "/v1/evaluations", FIELD, { jurisdictionId: "j_school", at: T0 });
    const alertId = evalJson.created[0];
    await call(base, "POST", `/v1/alerts/${alertId}/confirm`, FIELD, { at: T0, speciesConfirmed: true, density: "high" });
    await call(base, "POST", `/v1/alerts/${alertId}/measures`, FIELD, { types: ["light_adjust", "cleanup", "seal"] });
    await call(base, "POST", `/v1/alerts/${alertId}/schedule`, FIELD, { scheduledAt: "2026-06-16T09:00:00.000Z" });
    await call(base, "POST", `/v1/alerts/${alertId}/implement`, FIELD, { at: "2026-06-16T10:00:00.000Z" });

    // 实施后窗口仅诱到 1 只
    await call(base, "POST", "/v1/trap-counts", FIELD, {
      siteId: "s_school_lamp", at: "2026-06-22T20:00:00.000Z", trapCount: 1,
    });

    const wos = await call(base, "GET", "/v1/work-orders?status=implemented", FIELD);
    // 复查前状态为 implemented
    const woId = wos.json.workOrders[0].id;
    const effect = await call(base, "GET", `/v1/analytics/effect/work-orders/${woId}`, FIELD);
    assert.equal(effect.json.comparable, true);
    assert.ok(effect.json.before.trap > effect.json.after.trap);
    assert.ok(effect.json.change.trap.pct < 0);
  });
});

test("长期未闭环设施与滞留工单可被识别", async () => {
  await withServer(async (base, server) => {
    await seedSchoolOutbreak(base);
    await call(base, "POST", "/v1/evaluations", FIELD, { jurisdictionId: "j_school", at: T0 });

    // 破损纱窗从未修复，演练当前时间距其检查已久
    const res = await call(base, "GET", "/v1/analytics/unclosed?stallDays=7&screenDays=14", DISTRICT);
    assert.equal(res.status, 200);
    const broken = res.json.brokenScreens.find((s) => s.screenId === "sc1");
    assert.ok(broken);
    assert.equal(broken.overdue, true);

    // 待核查工单长期未推进，进入滞留清单
    assert.ok(res.json.stuckWorkOrders.some((w) => w.status === "pending_confirm" && w.stalled));

    // 修复纱窗后从未闭环清单消失
    const patched = await call(base, "PATCH", "/v1/screens/sc1", FIELD, { intact: true });
    assert.equal(patched.status, 200);
    const after = await call(base, "GET", "/v1/analytics/unclosed", DISTRICT);
    assert.equal(after.json.brokenScreens.some((s) => s.screenId === "sc1"), false);
  });
});

test("预警依据可追溯到观测、气象与人工确认留痕", async () => {
  await withServer(async (base) => {
    await seedSchoolOutbreak(base);
    const { json: evalJson } = await call(base, "POST", "/v1/evaluations", FIELD, { jurisdictionId: "j_school", at: T0 });
    const alertId = evalJson.created[0];
    await call(base, "POST", "/v1/inspections", FIELD, {
      routeId: "route-1", siteId: "s_school_lamp", at: T0, findings: ["现场见成虫"],
    });
    await call(base, "POST", `/v1/alerts/${alertId}/confirm`, FIELD, {
      at: T0, speciesConfirmed: true, density: "high", envChecks: { lighting: true }, note: "确认隐翅虫",
    });

    const basis = await call(base, "GET", `/v1/alerts/${alertId}/basis`, FIELD);
    assert.ok(basis.json.observations.traps.length >= 2);
    assert.ok(basis.json.observations.inspections.some((i) => i.routeId === "route-1"));
    assert.equal(basis.json.humanConfirmation.speciesConfirmed, true);
    assert.equal(basis.json.humanConfirmation.density, "high");
    const eventTypes = basis.json.workOrder.events.map((e) => e.type);
    assert.ok(eventTypes.includes("created"));
    assert.ok(eventTypes.includes("confirmed"));
  });
});
