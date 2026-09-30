"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { Store } = require("../src/store");
const { evaluateRisk, isActiveSeason } = require("../src/risk");
const { intakePublicReport } = require("../src/dedup");
const {
  createWorkOrder,
  verify,
  authorizeTreatment,
  implement,
  review,
  invalidate,
} = require("../src/workorder");

const DISTRICT = { id: "acct_district", name: "区爱卫办", role: "district" };
const INSPECTOR = { id: "insp", name: "巡查员", role: "inspector" };

function seeded() {
  const store = new Store();
  require("../src/seed").seed(store);
  return store;
}

test("非活跃季节不产点（12 月）", () => {
  const store = seeded();
  const run = evaluateRisk(store, { at: "2026-12-15T10:00:00Z" });
  assert.equal(run.seasonActive, false);
  assert.equal(run.pointIds.length, 0);
  assert.equal(isActiveSeason("2026-05-01"), true);
  assert.equal(isActiveSeason("2026-11-01"), false);
});

test("雨后暖湿 + 诱捕上升 + 设施状态共同触发风险点且带证据链", () => {
  const store = seeded();
  const run = evaluateRisk(store, {});
  assert.ok(run.seasonActive);
  const points = run.pointIds.map((id) => store.getRiskPoint(id));
  const lampPoint = points.find((p) => p.dedupKey === "lamp:lamp_playground");
  assert.ok(lampPoint, "未调光强光灯应产点");
  assert.ok(lampPoint.evidence.weatherReadingIds.length >= 1, "应引用降雨气象观测");
  assert.deepEqual(
    lampPoint.suggestedMeasures.map((m) => m.code).sort(),
    ["dim_lamp", "inspect_confirm"],
  );

  const screenPoint = points.find((p) => p.dedupKey === "screen:screen_dorm_3");
  assert.ok(screenPoint);
  assert.equal(screenPoint.evidence.facilityIds[0], "screen_dorm_3");

  const trapPoint = points.find((p) => p.dedupKey === "trap:trap_school_gate");
  assert.ok(trapPoint, "诱捕量上升应产点");
  assert.ok(trapPoint.evidence.trapCountIds.length >= 4, "应引用近 7 天诱捕观测");
});

test("规则引擎只建议环境措施，任何点位都不包含消杀", () => {
  const store = seeded();
  const run = evaluateRisk(store, {});
  for (const id of run.pointIds) {
    const point = store.getRiskPoint(id);
    assert.ok(
      !point.suggestedMeasures.some((m) => m.code === "targeted_treatment"),
      "规则不得自动建议消杀: " + point.id,
    );
  }
});

test("去重后的独立目击达到阈值才产生热点", () => {
  const store = seeded();
  const now = new Date().toISOString();
  const pixels = Array.from({ length: 64 }, (_, i) => (i % 4 === 0 ? 200 : 30));
  // 首条：带照片字节与像素指纹
  intakePublicReport(store, {
    areaId: "area_riverside", lat: 26.5711, lng: 106.7281, observedAt: now,
    photoBase64: Buffer.from("rpt-1").toString("base64"), pixels,
  });
  // 同照片精确重复
  intakePublicReport(store, {
    areaId: "area_riverside", lat: 26.5711, lng: 106.7281, observedAt: now,
    photoBase64: Buffer.from("rpt-1").toString("base64"),
  });
  // 无新照片、仅近重复像素：与首条近重复，不计独立目击
  intakePublicReport(store, {
    areaId: "area_riverside", lat: 26.5711, lng: 106.7281, observedAt: now,
    pixels: pixels.map((v) => v + 5),
  });
  // 第二名独立目击
  intakePublicReport(store, {
    areaId: "area_riverside", lat: 26.5711, lng: 106.7281, observedAt: now,
    photoBase64: Buffer.from("rpt-distinct").toString("base64"),
  });
  const run = evaluateRisk(store, {});
  const hotspots = run.pointIds
    .map((id) => store.getRiskPoint(id))
    .filter((p) => p.kind === "hotspot");
  assert.equal(hotspots.length, 1, "2 起独立目击形成 1 个热点，重复照片不计数");
  const clusterReason = hotspots[0].reasons.find((r) => r.code === "report_cluster");
  assert.match(clusterReason.text, /独立目击 2 起/);
  assert.match(clusterReason.text, /重复照片 2 起未计入/);
});

test("证据消失后复算会把待核查点位置为 cleared", () => {
  const store = seeded();
  const first = evaluateRisk(store, {});
  assert.ok(first.pointIds.length > 0);
  store.updateScreen("screen_dorm_3", { intact: true, damageNote: null });
  store.updateLamp("lamp_playground", { adjusted: true });
  store.updateWaterSite("water_flowerbed", { tidy: true, standingWater: false });
  store.updateLamp("lamp_community_path", { adjusted: true });
  store.updateWaterSite("water_riverbank", { tidy: true, standingWater: false });
  const later = evaluateRisk(store, { at: new Date(Date.now() + 9 * 86400000).toISOString() });
  assert.ok(later);
  const screenPoint = store.riskPoints.find((p) => p.dedupKey === "screen:screen_dorm_3");
  assert.equal(screenPoint.status, "cleared");
});

test("未确认虫种前不能安排任何措施", () => {
  const store = seeded();
  const run = evaluateRisk(store, {});
  const point = store.getRiskPoint(run.pointIds[0]);
  const order = createWorkOrder(store, INSPECTOR, point.id);
  assert.equal(order.status, "proposed");
  assert.throws(
    () => implement(store, INSPECTOR, order.id, { measureCodes: ["dim_lamp"] }),
    (e) => e.status === 409,
  );
  assert.throws(
    () => verify(store, INSPECTOR, order.id, { speciesConfirmed: false, environmentConfirmed: true }),
    (e) => e.status === 422 && e.code === "SPECIES_UNCONFIRMED",
  );
});

test("核查环节任何人都不能夹带消杀措施", () => {
  const store = seeded();
  const run = evaluateRisk(store, {});
  const point = store.getRiskPoint(run.pointIds[0]);
  const order = createWorkOrder(store, INSPECTOR, point.id);
  assert.throws(
    () =>
      verify(store, INSPECTOR, order.id, {
        speciesConfirmed: true,
        environmentConfirmed: true,
        addMeasures: ["targeted_treatment"],
      }),
    (e) => e.status === 403 && e.code === "TREATMENT_NOT_AUTHORIZED",
  );
});

test("完整生命周期：核查→区级授权消杀→实施→复查通过，全程留痕", () => {
  const store = seeded();
  const run = evaluateRisk(store, {});
  const point = store.riskPoints.find((p) => p.dedupKey === "screen:screen_dorm_3");
  const order = createWorkOrder(store, INSPECTOR, point.id);

  // 非区级不能授权消杀
  assert.throws(
    () => authorizeTreatment(store, INSPECTOR, order.id, { justification: "现场密度很高需要处理" }),
    (e) => e.status === 403,
  );
  // 未核查时区级也不能授权
  assert.throws(
    () => authorizeTreatment(store, DISTRICT, order.id, { justification: "现场密度很高需要处理" }),
    (e) => e.status === 409,
  );

  verify(store, INSPECTOR, order.id, {
    speciesConfirmed: true,
    environmentConfirmed: true,
    note: "确认为毒隐翅虫，窗纱破损入室",
  });
  // 授权理由过短被拒绝
  assert.throws(
    () => authorizeTreatment(store, DISTRICT, order.id, { justification: "密度高" }),
    (e) => e.status === 422,
  );
  authorizeTreatment(store, DISTRICT, order.id, {
    justification: "连续多日居民被灼伤，环境措施短期无法降密度，定点小范围处理",
    scope: "targeted",
  });

  // 未授权的普通环境措施直接实施；消杀授权态已写入
  assert.ok(order.authorizedMeasures.includes("targeted_treatment"));
  implement(store, INSPECTOR, order.id, {
    measureCodes: ["seal_screen", "targeted_treatment"],
    targets: ["screen_dorm_3"],
    note: "更换纱网并在楼外定点处理",
  });
  const screen = store.screens.find((s) => s.id === "screen_dorm_3");
  assert.equal(screen.intact, true, "实施应回写纱窗状态");

  review(store, INSPECTOR, order.id, { pass: true, note: "复查无入室报告" });
  assert.equal(order.status, "closed");
  assert.ok(order.closedAt);
  const actions = order.events.map((e) => e.action);
  assert.deepEqual(actions, [
    "create",
    "verify_confirm",
    "authorize_treatment",
    "implement",
    "review_pass",
  ]);
  const authEvent = order.events.find((e) => e.action === "authorize_treatment");
  assert.equal(authEvent.actor.role, "district");
});

test("没有区级授权时实施消杀被系统拒绝", () => {
  const store = seeded();
  const run = evaluateRisk(store, {});
  const point = store.riskPoints.find((p) => p.dedupKey === "lamp:lamp_playground");
  const order = createWorkOrder(store, INSPECTOR, point.id);
  verify(store, INSPECTOR, order.id, { speciesConfirmed: true, environmentConfirmed: true });
  // 工单范围里根本没有消杀
  assert.throws(
    () => implement(store, INSPECTOR, order.id, { measureCodes: ["targeted_treatment"] }),
    (e) => e.status === 400,
  );
});

test("复查不通过与措施失效都会重开并累计次数", () => {
  const store = seeded();
  const run = evaluateRisk(store, {});
  const point = store.riskPoints.find((p) => p.dedupKey === "screen:screen_dorm_3");
  const order = createWorkOrder(store, INSPECTOR, point.id);
  verify(store, INSPECTOR, order.id, { speciesConfirmed: true, environmentConfirmed: true });
  implement(store, INSPECTOR, order.id, { measureCodes: ["seal_screen"], targets: ["screen_dorm_3"] });
  review(store, INSPECTOR, order.id, { pass: false, reason: "纱网仍有缝隙", note: "不合格" });
  assert.equal(order.status, "reopened");
  assert.equal(order.reopenedCount, 1);

  implement(store, INSPECTOR, order.id, { measureCodes: ["seal_screen"], targets: ["screen_dorm_3"] });
  review(store, INSPECTOR, order.id, { pass: true });
  invalidate(store, INSPECTOR, order.id, { reason: "两周后纱框变形再次开裂" });
  assert.equal(order.status, "reopened");
  assert.equal(order.reopenedCount, 2);
  assert.equal(order.closedAt, null);
  assert.ok(order.events.some((e) => e.action === "invalidate"));
});

test("现场核查可排除误报并关闭点位", () => {
  const store = seeded();
  const run = evaluateRisk(store, {});
  const point = store.riskPoints.find((p) => p.dedupKey === "lamp:lamp_playground");
  const order = createWorkOrder(store, INSPECTOR, point.id);
  verify(store, INSPECTOR, order.id, {
    conclusion: "dismiss",
    speciesConfirmed: false,
    note: "现场为其他无害甲虫，排除隐翅虫",
  });
  assert.equal(order.status, "dismissed");
  assert.equal(store.getRiskPoint(point.id).status, "dismissed");
});

test("不能跨辖区处置设施", () => {
  const store = seeded();
  const run = evaluateRisk(store, {});
  // 社区灯具点位，实施时指定学校纱窗
  const point = store.riskPoints.find((p) => p.dedupKey === "lamp:lamp_community_path");
  const order = createWorkOrder(store, INSPECTOR, point.id);
  verify(store, INSPECTOR, order.id, { speciesConfirmed: true, environmentConfirmed: true });
  assert.throws(
    () =>
      implement(store, INSPECTOR, order.id, {
        measureCodes: ["dim_lamp"],
        targets: ["lamp_playground"],
      }),
    (e) => e.status === 403,
  );
});
