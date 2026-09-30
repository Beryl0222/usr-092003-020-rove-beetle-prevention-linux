"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { Store } = require("../src/store");
const { seed } = require("../src/seed");
const {
  averageHash,
  hammingDistanceHex,
  sha256Base64,
  gridCell,
  intakePublicReport,
  recordPatrolBatch,
} = require("../src/dedup");

const INSPECTOR = { id: "insp1", name: "测试巡查员", role: "inspector" };

function freshAreaStore() {
  const store = new Store();
  store.addArea({ id: "area_a", name: "测试片区", kind: "community", lat: 26.5, lng: 106.7 });
  return store;
}

test("平均哈希对近似图像汉明距离很小，对不同图像更大", () => {
  const base = Array.from({ length: 64 }, (_, i) => (i % 3 === 0 ? 200 : 40));
  const near = base.map((v, i) => (i < 4 ? v + 12 : v));
  const other = Array.from({ length: 64 }, (_, i) => (i % 2 === 0 ? 20 : 220));
  const dNear = hammingDistanceHex(averageHash(base), averageHash(near));
  const dOther = hammingDistanceHex(averageHash(base), averageHash(other));
  assert.ok(dNear <= 6, "微调图像应判为近重复");
  assert.ok(dOther > 6, "明显不同的图像不应判为近重复");
});

test("同一照片重复提交不增加独立目击数（精确哈希）", () => {
  const store = freshAreaStore();
  const photo = Buffer.from("fake-jpeg-bytes-001").toString("base64");
  const baseInput = {
    areaId: "area_a",
    lat: 26.5001,
    lng: 106.7001,
    observedAt: "2026-09-20T20:00:00Z",
    photoBase64: photo,
  };
  const first = intakePublicReport(store, baseInput);
  assert.equal(first.duplicated, false);
  assert.equal(first.cluster.independentCount, 1);

  // 换坐标、换描述，只要照片字节相同，仍是重复
  const second = intakePublicReport(store, {
    ...baseInput,
    lat: 26.5002,
    lng: 106.7002,
    description: "再发一次",
  });
  assert.equal(second.report.status, "duplicate_photo");
  assert.equal(second.duplicated, true);
  assert.equal(second.cluster.independentCount, 1, "独立目击数不能被重复照片抬高");
  assert.equal(store.publicReports.length, 2);
});

test("同地点 72 小时窗口内的近重复照片不制造热点", () => {
  const store = freshAreaStore();
  const pixelsA = Array.from({ length: 64 }, (_, i) => (i % 3 === 0 ? 190 : 50));
  const pixelsB = pixelsA.map((v, i) => (i < 3 ? v + 10 : v)); // 近重复
  const mk = (pixels, n) =>
    intakePublicReport(store, {
      areaId: "area_a",
      lat: 26.5001 + n * 0.00002,
      lng: 106.7001,
      observedAt: "2026-09-20T2" + n + ":00:00Z",
      pixels,
    });
  const a = mk(pixelsA, 0);
  const b = mk(pixelsB, 1);
  assert.equal(a.cluster.independentCount, 1);
  assert.equal(b.report.status, "near_duplicate");
  assert.equal(b.cluster.independentCount, 1, "近重复不能制造第二起独立目击");
});

test("不同位置或超出时间窗口的独立目击分别聚类", () => {
  const store = freshAreaStore();
  const input = {
    areaId: "area_a",
    lat: 26.5001,
    lng: 106.7001,
    observedAt: "2026-09-20T20:00:00Z",
  };
  intakePublicReport(store, input);
  const far = intakePublicReport(store, { ...input, lat: 26.51, lng: 106.71, observedAt: "2026-09-20T21:00:00Z" });
  assert.notEqual(far.cluster, store.reportClusters[0], "约 1 公里外应另成聚类");
  assert.equal(store.reportClusters.length, 2);
});

test("巡查批次同 batchId 补传原样返回，不新增记录", () => {
  const store = new Store();
  seed(store);
  const body = {
    areaId: "area_school",
    routeId: "route-1",
    batchId: "batch-1",
    records: [
      {
        kind: "sighting",
        observedAt: "2026-09-21T19:30:00Z",
        lat: 26.582,
        lng: 106.721,
        findings: { count: 3 },
        photoBase64: Buffer.from("patrol-photo-1").toString("base64"),
      },
    ],
  };
  const first = recordPatrolBatch(store, INSPECTOR, body);
  assert.equal(first.duplicateBatch, false);
  assert.equal(first.records.length, 1);
  const retry = recordPatrolBatch(store, INSPECTOR, { ...body, records: [...body.records] });
  assert.equal(retry.duplicateBatch, true);
  assert.equal(store.patrolRecords.length, 1, "同 batchId 重试不能产生新记录");
});

test("巡查批次换 batchId 的补传，相同照片与同路线同时刻条目仍被丢弃", () => {
  const store = new Store();
  seed(store);
  const photo = Buffer.from("patrol-photo-2").toString("base64");
  const firstBody = {
    areaId: "area_school",
    routeId: "route-9",
    batchId: "batch-a",
    records: [
      {
        kind: "lamp",
        facilityId: "lamp_playground",
        observedAt: "2026-09-21T19:30:00Z",
        findings: { on: true },
        photoBase64: photo,
      },
    ],
  };
  recordPatrolBatch(store, INSPECTOR, firstBody);
  // 网络不好后用新 batchId 补传同一路线的同一张照片
  const secondBody = {
    areaId: "area_school",
    routeId: "route-9",
    batchId: "batch-b",
    records: [
      {
        kind: "lamp",
        facilityId: "lamp_playground",
        observedAt: "2026-09-21T19:30:30Z", // 同一分钟
        findings: { on: true },
        photoBase64: photo,
      },
      {
        kind: "sighting",
        observedAt: "2026-09-21T19:32:00Z",
        lat: 26.582,
        lng: 106.721,
        findings: { count: 1 },
      },
    ],
  };
  const second = recordPatrolBatch(store, INSPECTOR, secondBody);
  assert.equal(second.records.length, 1, "重复照片/同时刻条目被丢弃，仅保留新观测");
  assert.equal(second.records[0].kind, "sighting");
  assert.equal(second.droppedDuplicates, 1);
});

test("网格单元在近距离保持稳定", () => {
  const cell1 = gridCell(26.500001, 106.700001);
  const cell2 = gridCell(26.500002, 106.700002);
  const cell3 = gridCell(26.51, 106.71);
  assert.equal(cell1, cell2, "约 1 米内应属同一网格");
  assert.notEqual(cell1, cell3);
});

test("sha256 对相同字节稳定", () => {
  assert.equal(sha256Base64(Buffer.from("abc").toString("base64")), sha256Base64(Buffer.from("abc").toString("base64")));
  assert.notEqual(
    sha256Base64(Buffer.from("abc").toString("base64")),
    sha256Base64(Buffer.from("abd").toString("base64")),
  );
});
