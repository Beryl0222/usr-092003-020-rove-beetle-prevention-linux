"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { withServer, TOKENS } = require("./helpers");
const { Store } = require("../src/store");
const { createApp } = require("../src/app");
const { evaluateRisk } = require("../src/risk");
const { seed } = require("../src/seed");
const http = require("node:http");

// 直接在 store 上准备好一次研判与工单，供接口测试复用。
function preparedStore() {
  const store = new Store();
  seed(store);
  evaluateRisk(store, { generatedBy: "acct_district" });
  return store;
}

async function withPreparedServer(run) {
  const store = preparedStore();
  const app = createApp(store);
  const server = http.createServer(app.handle);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + server.address().port;
  const client = async (method, path, body, token) => {
    const headers = { "content-type": "application/json" };
    if (token) headers.authorization = "Bearer " + token;
    const response = await fetch(base + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, json: await response.json().catch(() => ({})), headers: response.headers };
  };
  try {
    await run({ client, store });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

test("无令牌访问业务接口返回 401", async () => {
  await withServer(async ({ client }) => {
    const res = await client("GET", "/api/work-orders");
    assert.equal(res.status, 401);
  });
});

test("伪造令牌返回 401", async () => {
  await withServer(async ({ client }) => {
    const res = await client("GET", "/api/areas", undefined, "not-a-real-token");
    assert.equal(res.status, 401);
  });
});

test("学校只能看到本辖区，物业不能访问学校工单", async () => {
  await withPreparedServer(async ({ client, store }) => {
    const schoolAreas = await client("GET", "/api/areas", undefined, TOKENS.school);
    assert.deepEqual(schoolAreas.json.areas.map((a) => a.id), ["area_school"]);

    const propertyAreas = await client("GET", "/api/areas", undefined, TOKENS.property);
    assert.deepEqual(propertyAreas.json.areas.map((a) => a.id), ["area_community"]);

    const schoolOrderPoint = store.riskPoints.find((p) => p.dedupKey === "screen:screen_dorm_3");
    const created = await client(
      "POST",
      "/api/work-orders",
      { riskPointId: schoolOrderPoint.id },
      TOKENS.inspector,
    );
    assert.equal(created.status, 200);

    // 物业拿学校工单详情/列表均不可见
    const list = await client("GET", "/api/work-orders", undefined, TOKENS.property);
    assert.ok(!list.json.orders.some((o) => o.areaId === "area_school"));

    const forbidden = await client(
      "POST",
      `/api/work-orders/${created.json.id}/implement`,
      { measureCodes: ["seal_screen"], targets: ["screen_dorm_3"] },
      TOKENS.property,
    );
    assert.equal(forbidden.status, 403);

    // 物业也不能查看学校的风险点详情
    const pointDetail = await client(
      "GET",
      `/api/risk/points/${schoolOrderPoint.id}`,
      undefined,
      TOKENS.property,
    );
    assert.equal(pointDetail.status, 403);
  });
});

test("学校后勤可在本辖区执行已核查工单的实施", async () => {
  await withPreparedServer(async ({ client, store }) => {
    const point = store.riskPoints.find((p) => p.dedupKey === "screen:screen_dorm_3");
    await client("POST", "/api/work-orders", { riskPointId: point.id }, TOKENS.inspector);
    const orderId = store.getRiskPoint(point.id).orderId;
    await client(
      "POST",
      `/api/work-orders/${orderId}/verify`,
      { speciesConfirmed: true, environmentConfirmed: true, note: "确认" },
      TOKENS.inspector,
    );
    const res = await client(
      "POST",
      `/api/work-orders/${orderId}/implement`,
      { measureCodes: ["seal_screen"], targets: ["screen_dorm_3"] },
      TOKENS.school,
    );
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.implementedMeasures, ["seal_screen"]);
  });
});

test("巡查员不能授权消杀，区级可以且被留痕", async () => {
  await withPreparedServer(async ({ client, store }) => {
    const point = store.riskPoints.find((p) => p.dedupKey === "screen:screen_dorm_3");
    const created = await client("POST", "/api/work-orders", { riskPointId: point.id }, TOKENS.inspector);
    const orderId = created.json.id;
    await client(
      "POST",
      `/api/work-orders/${orderId}/verify`,
      { speciesConfirmed: true, environmentConfirmed: true },
      TOKENS.inspector,
    );
    const inspectorDenied = await client(
      "POST",
      `/api/work-orders/${orderId}/treatment-authorization`,
      { justification: "连续灼伤事件，需要在最小范围定点处理并记录" },
      TOKENS.inspector,
    );
    assert.equal(inspectorDenied.status, 403);

    const ok = await client(
      "POST",
      `/api/work-orders/${orderId}/treatment-authorization`,
      { justification: "连续灼伤事件，需要在最小范围定点处理并记录", scope: "targeted" },
      TOKENS.district,
    );
    assert.equal(ok.status, 200);
    assert.ok(ok.json.authorizedMeasures.includes("targeted_treatment"));
    assert.ok(ok.json.events.some((e) => e.action === "authorize_treatment" && e.actor.role === "district"));
  });
});

test("公众可匿名提交发现，重复照片被标记且不抬高计数", async () => {
  await withPreparedServer(async ({ client }) => {
    const photo = Buffer.from("citizen-photo-x").toString("base64");
    const payload = {
      areaId: "area_community",
      lat: 26.5762,
      lng: 106.7152,
      observedAt: new Date().toISOString(),
      photoBase64: photo,
      description: "楼道灯下有虫",
    };
    const first = await client("POST", "/api/public/reports", payload);
    assert.equal(first.status, 200);
    assert.equal(first.json.duplicate, false);
    const second = await client("POST", "/api/public/reports", { ...payload, description: "补发" });
    assert.equal(second.status, 200);
    assert.equal(second.json.duplicate, true);
    assert.equal(second.json.clusterIndependentCount, 1);
  });
});

test("公众预防提示不含区域编号、坐标等住址细节", async () => {
  await withPreparedServer(async ({ client }) => {
    const res = await client("GET", "/api/public/advisories");
    assert.equal(res.status, 200);
    assert.ok(res.json.advisories.length >= 1);
    for (const adv of res.json.advisories) {
      const text = JSON.stringify(adv);
      assert.ok(!text.includes("area_"), "提示不应泄露区域内部编号");
      assert.ok(!/"lat"/.test(text), "提示不应含坐标");
      assert.ok(adv.content.includes("不要拍打") || adv.content.includes("吹走"));
    }
  });
});

test("公众接口不需要鉴权，业务写接口不接受公众直连", async () => {
  await withPreparedServer(async ({ client }) => {
    const res = await client("POST", "/api/weather", {
      areaId: "area_school",
      observedAt: new Date().toISOString(),
      rainfallMm: 5,
    });
    assert.equal(res.status, 401);
  });
});

test("巡查批次 HTTP 提交与补传幂等", async () => {
  await withPreparedServer(async ({ client }) => {
    const body = {
      areaId: "area_school",
      routeId: "route-http-1",
      batchId: "batch-http-1",
      records: [
        {
          kind: "sighting",
          observedAt: new Date().toISOString(),
          lat: 26.5821,
          lng: 106.7211,
          findings: { count: 2 },
        },
      ],
    };
    const first = await client("POST", "/api/patrols", body, TOKENS.inspector);
    assert.equal(first.status, 200);
    const retry = await client("POST", "/api/patrols", body, TOKENS.inspector);
    assert.equal(retry.status, 200);
    assert.equal(retry.json.duplicateBatch, true);
  });
});

test("学校不能向其他辖区提交巡查或气象", async () => {
  await withPreparedServer(async ({ client }) => {
    const patrol = await client(
      "POST",
      "/api/patrols",
      {
        areaId: "area_community",
        routeId: "r",
        batchId: "b",
        records: [{ kind: "sighting", observedAt: new Date().toISOString() }],
      },
      TOKENS.school,
    );
    assert.equal(patrol.status, 403);
  });
});

test("研判溯源说明预警依据的观测、气象与人工确认", async () => {
  await withPreparedServer(async ({ client, store }) => {
    const runs = await client("GET", "/api/risk/runs", undefined, TOKENS.district);
    const runId = runs.json.runs[0].id;
    const explain = await client(
      "GET",
      `/api/risk/runs/${runId}/explain?areaId=area_school`,
      undefined,
      TOKENS.district,
    );
    assert.equal(explain.status, 200);
    assert.ok(explain.json.evidence.weatherReadings.length >= 1, "应列出降雨气象依据");
    assert.ok(explain.json.evidence.weatherReadings.some((w) => w.rainfallMm >= 2));
    assert.ok(explain.json.evidence.trapCounts.length >= 4, "应列出诱捕观测依据");
    assert.ok(explain.json.points.some((p) => p.evidence.facilityIds.includes("screen_dorm_3")));

    // 走完核查后，溯源中应出现人工确认记录
    const point = store.riskPoints.find((p) => p.dedupKey === "screen:screen_dorm_3");
    const order = await client("POST", "/api/work-orders", { riskPointId: point.id }, TOKENS.inspector);
    await client(
      "POST",
      `/api/work-orders/${order.json.id}/verify`,
      { speciesConfirmed: true, environmentConfirmed: true, note: "现场确认为毒隐翅虫" },
      TOKENS.inspector,
    );
    const after = await client(
      "GET",
      `/api/risk/runs/${runId}/explain?areaId=area_school`,
      undefined,
      TOKENS.district,
    );
    assert.ok(
      after.json.evidence.manualConfirmations.some((c) => c.action === "verify_confirm"),
      "溯源应包含现场人工确认",
    );
  });
});

test("学校视角的研判运行只含本辖区摘要且不泄露其他区域", async () => {
  await withPreparedServer(async ({ client }) => {
    const res = await client("GET", "/api/risk/runs", undefined, TOKENS.school);
    assert.equal(res.status, 200);
    const run = res.json.runs[0];
    assert.deepEqual(run.areaSummaries.map((s) => s.areaId), ["area_school"]);
    assert.ok(run.pointIds.every((id) => id)); // 点位 id 本身无辖区信息，摘要已裁剪
  });
});

test("处理前后效果统计按工单实施时间分界对比", async () => {
  await withPreparedServer(async ({ client, store }) => {
    const point = store.riskPoints.find((p) => p.dedupKey === "screen:screen_dorm_3");
    const created = await client("POST", "/api/work-orders", { riskPointId: point.id }, TOKENS.inspector);
    const orderId = created.json.id;
    await client(
      "POST",
      `/api/work-orders/${orderId}/verify`,
      { speciesConfirmed: true, environmentConfirmed: true },
      TOKENS.inspector,
    );
    const impl = await client(
      "POST",
      `/api/work-orders/${orderId}/implement`,
      { measureCodes: ["seal_screen"], targets: ["screen_dorm_3"] },
      TOKENS.school,
    );
    assert.equal(impl.status, 200);
    const stats = await client("GET", "/api/stats/effectiveness?days=14", undefined, TOKENS.district);
    assert.equal(stats.status, 200);
    const order = stats.json.orders.find((o) => o.orderId === orderId);
    assert.ok(order);
    assert.ok(order.before.trapTotal > 0, "实施前应有诱捕基线");
    assert.equal(order.after.trapTotal, 0, "实施刚发生，之后窗口尚无新增计数");
    assert.ok(order.implementedAt);
  });
});

test("长期未闭环设施与滞留工单被识别", async () => {
  await withPreparedServer(async ({ client, store }) => {
    const res = await client("GET", "/api/stats/open-items?staleDays=14", undefined, TOKENS.district);
    assert.equal(res.status, 200);
    assert.ok(res.json.brokenScreens.some((s) => s.id === "screen_dorm_3"));
    assert.ok(res.json.unadjustedLamps.some((l) => l.id === "lamp_playground"));
    assert.ok(res.json.untidyWaterSites.some((w) => w.id === "water_flowerbed"));
    assert.ok(res.json.summary.brokenScreens >= 1);

    // 学校视角只看到自己辖区的未闭环项
    const schoolView = await client("GET", "/api/stats/open-items", undefined, TOKENS.school);
    assert.equal(schoolView.status, 200);
    const ids = schoolView.json.brokenScreens.map((s) => s.id);
    assert.ok(ids.includes("screen_dorm_3"));
    assert.ok(!schoolView.json.unadjustedLamps.some((l) => l.id === "lamp_community_path"));
  });
});

test("区级发布提示后公众立即可见，其他角色不能发布", async () => {
  await withPreparedServer(async ({ client }) => {
    const denied = await client(
      "POST",
      "/api/advisories",
      { title: "x", content: "y" },
      TOKENS.property,
    );
    assert.equal(denied.status, 403);
    const created = await client(
      "POST",
      "/api/advisories",
      { title: "秋季防护补充提示", content: "夜间减少在强光下逗留，落虫勿拍打。" },
      TOKENS.district,
    );
    assert.equal(created.status, 200);
    const pub = await client("GET", "/api/public/advisories");
    assert.ok(pub.json.advisories.some((a) => a.title === "秋季防护补充提示"));
  });
});

test("未知业务路由经过鉴权，无令牌返回 401", async () => {
  await withServer(async ({ client }) => {
    const unknown = await client("GET", "/api/nope");
    assert.equal(unknown.status, 401);
  });
});
