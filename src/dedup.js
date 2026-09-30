"use strict";

// 去重与热点计数：
// 1) 照片 SHA-256 精确去重；2) 64 位平均感知哈希近重判定；
// 3) 约 50m 网格 + 72 小时滑窗的时空聚类，只有“独立目击”才计入热点；
// 4) 巡查路线按 batchId 幂等，网络补传/重复提交不会制造新记录。

const crypto = require("node:crypto");
const { newId, canonicalTime } = require("./store");

const GRID_LAT_DEG = 0.00045; // 纬度方向约 50 米
const CLUSTER_WINDOW_MS = 72 * 60 * 60 * 1000;
const PHASH_HAMMING_THRESHOLD = 6; // 0..64，越小越严格

function sha256Base64(photoBase64) {
  const buffer = Buffer.from(photoBase64, "base64");
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function sha256Text(text) {
  return crypto.createHash("sha256").update(String(text)).digest("hex");
}

// 由客户端按 8x8 灰度（64 个 0..255）给出的缩略图计算平均哈希。
// 移动端可直接生成；后端不依赖图像解码库。
function averageHash(pixels) {
  if (!Array.isArray(pixels) || pixels.length !== 64) {
    const error = new Error("感知哈希需要 8x8=64 个灰度值");
    error.code = "BAD_PIXELS";
    throw error;
  }
  const values = pixels.map(Number);
  if (values.some((v) => !Number.isFinite(v) || v < 0 || v > 255)) {
    const error = new Error("灰度值必须在 0..255 之间");
    error.code = "BAD_PIXELS";
    throw error;
  }
  const avg = values.reduce((sum, v) => sum + v, 0) / values.length;
  let bits = 0n;
  for (let i = 0; i < 64; i += 1) {
    if (values[i] >= avg) bits |= 1n << BigInt(i);
  }
  return bits.toString(16).padStart(16, "0");
}

function hammingDistanceHex(a, b) {
  let x = BigInt("0x" + a) ^ BigInt("0x" + b);
  let distance = 0;
  while (x) {
    distance += Number(x & 1n);
    x >>= 1n;
  }
  return distance;
}

function gridCell(lat, lng) {
  const latIndex = Math.floor(Number(lat) / GRID_LAT_DEG);
  const lngStep = GRID_LAT_DEG / Math.max(Math.cos((Number(lat) * Math.PI) / 180), 0.15);
  const lngIndex = Math.floor(Number(lng) / lngStep);
  return latIndex + ":" + lngIndex;
}

function cellCentroid(cell) {
  const [latIndexRaw, lngIndexRaw] = cell.split(":");
  const latIndex = Number(latIndexRaw);
  const lngIndex = Number(lngIndexRaw);
  const lat = (latIndex + 0.5) * GRID_LAT_DEG;
  const lngStep = GRID_LAT_DEG / Math.max(Math.cos((lat * Math.PI) / 180), 0.15);
  const lng = (lngIndex + 0.5) * lngStep;
  return { lat: round6(lat), lng: round6(lng) };
}

function round6(v) {
  return Math.round(v * 1e6) / 1e6;
}

function openCluster(store, areaId, cell, atMs) {
  let matched = null;
  for (const cluster of store.reportClusters) {
    if (cluster.areaId !== areaId || cluster.cell !== cell) continue;
    if (cluster.closed) continue;
    if (Math.abs(atMs - Date.parse(cluster.lastSeenAt)) <= CLUSTER_WINDOW_MS) {
      if (!matched || cluster.lastSeenAt > matched.lastSeenAt) matched = cluster;
    }
  }
  return matched;
}

// 公众匿名发现接入。返回 { report, cluster, duplicated }。
function intakePublicReport(store, input) {
  const observedAt = canonicalTime(input.observedAt);
  const lat = Number(input.lat);
  const lng = Number(input.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    const error = new Error("缺少有效的经纬度");
    error.code = "BAD_REQUEST";
    throw error;
  }
  if (!store.getArea(input.areaId)) {
    const error = new Error("区域不存在");
    error.code = "NOT_FOUND";
    throw error;
  }

  let photoSha256 = input.photoSha256 || null;
  if (input.photoBase64) photoSha256 = sha256Base64(input.photoBase64);
  const phash = input.pixels ? averageHash(input.pixels) : null;
  const atMs = Date.parse(observedAt);
  const cell = gridCell(lat, lng);

  // 精确重复照片：同一素材再次提交，零权重。
  let status = "unique";
  let dupOfId = null;
  if (photoSha256) {
    const exact = store.publicReports.find((r) => r.photoSha256 === photoSha256);
    if (exact) {
      status = "duplicate_photo";
      dupOfId = exact.id;
    }
  }

  const cluster = openCluster(store, input.areaId, cell, atMs) ||
    store.addReportCluster({
      id: newId("clu"),
      areaId: input.areaId,
      cell,
      firstSeenAt: observedAt,
      lastSeenAt: observedAt,
      independentCount: 0,
      reportIds: [],
    });

  // 近重复照片（同地点窗口内的相似图）也不增加独立目击数。
  if (status === "unique" && phash) {
    const near = store.publicReports.find(
      (r) =>
        r.clusterId === cluster.id &&
        r.phash &&
        hammingDistanceHex(r.phash, phash) <= PHASH_HAMMING_THRESHOLD,
    );
    if (near) {
      status = "near_duplicate";
      dupOfId = near.id;
    }
  }

  const report = store.addPublicReport({
    id: newId("rep"),
    areaId: input.areaId,
    clusterId: cluster.id,
    anonymous: true,
    lat: round6(lat),
    lng: round6(lng),
    gridCell: cell,
    observedAt,
    photoSha256,
    phash,
    description: typeof input.description === "string" ? input.description.slice(0, 500) : null,
    status,
    dupOfId,
    createdAt: new Date().toISOString(),
  });

  cluster.reportIds.push(report.id);
  if (status === "unique") {
    cluster.independentCount += 1;
  } else {
    cluster.duplicateCount = (cluster.duplicateCount || 0) + 1;
  }
  if (observedAt > cluster.lastSeenAt) cluster.lastSeenAt = observedAt;
  if (observedAt < cluster.firstSeenAt) cluster.firstSeenAt = observedAt;

  return { report, cluster, duplicated: status !== "unique" };
}

// 巡查路线一批观测接入；相同 batchId 的补传/重试原样返回，不新增记录。
function recordPatrolBatch(store, account, input) {
  if (!input.batchId || !input.routeId) {
    const error = new Error("巡查批次需要 routeId 与 batchId");
    error.code = "BAD_REQUEST";
    throw error;
  }
  if (!store.getArea(input.areaId)) {
    const error = new Error("区域不存在");
    error.code = "NOT_FOUND";
    throw error;
  }
  const prior = store.patrolRecords.filter((r) => r.batchId === input.batchId);
  if (prior.length > 0) {
    return { duplicateBatch: true, records: prior };
  }
  if (!Array.isArray(input.records) || input.records.length === 0) {
    const error = new Error("巡查批次至少包含一条记录");
    error.code = "BAD_REQUEST";
    throw error;
  }

  const seenPhotos = new Set();
  // 历史巡查已出现过的素材/同路线同设施同一分钟条目：补传或换 batchId 重传同样幂等。
  const knownPhotos = new Set(
    store.patrolRecords.filter((r) => r.photoSha256).map((r) => r.photoSha256),
  );
  const knownSlots = new Set(
    store.patrolRecords.map((r) => [r.routeId, r.kind, r.facilityId || "", r.observedAt.slice(0, 16)].join("|")),
  );
  const seenSlots = new Set();
  const records = [];
  let dropped = 0;
  for (const item of input.records) {
    const observedAt = canonicalTime(item.observedAt);
    let photoSha256 = item.photoSha256 || null;
    if (item.photoBase64) photoSha256 = sha256Base64(item.photoBase64);
    const phash = item.pixels ? averageHash(item.pixels) : null;

    if (photoSha256) {
      if (seenPhotos.has(photoSha256) || knownPhotos.has(photoSha256)) {
        dropped += 1;
        continue; // 批内或历史重复照片
      }
      seenPhotos.add(photoSha256);
    }
    const slotKey = [input.routeId, item.kind, item.facilityId || "", observedAt.slice(0, 16)].join("|");
    if (seenSlots.has(slotKey) || knownSlots.has(slotKey)) {
      dropped += 1;
      continue; // 同路线同设施同一分钟重复条目
    }
    seenSlots.add(slotKey);

    const lat = item.lat === undefined ? null : Number(item.lat);
    const lng = item.lng === undefined ? null : Number(item.lng);
    records.push(
      store.addPatrolRecord({
        id: newId("pat"),
        routeId: input.routeId,
        batchId: input.batchId,
        areaId: input.areaId,
        inspectorId: account.id,
        inspectorName: account.name,
        kind: item.kind, // sighting | trap | lamp | screen | water
        facilityId: item.facilityId || null,
        lat: Number.isFinite(lat) ? round6(lat) : null,
        lng: Number.isFinite(lng) ? round6(lng) : null,
        gridCell: Number.isFinite(lat) && Number.isFinite(lng) ? gridCell(lat, lng) : null,
        observedAt,
        findings: sanitizeFindings(item.findings),
        photoSha256,
        phash,
        createdAt: new Date().toISOString(),
      }),
    );
  }

  if (records.length === 0) {
    const error = new Error(dropped > 0 ? "批次内全部为重复照片或重复补传条目" : "批次内全部为重复条目");
    error.code = "DUPLICATE_BATCH";
    throw error;
  }
  return { duplicateBatch: false, records, droppedDuplicates: dropped };
}

function sanitizeFindings(findings) {
  if (!findings || typeof findings !== "object") return {};
  const out = {};
  for (const [key, value] of Object.entries(findings)) {
    if (["string", "number", "boolean"].includes(typeof value)) out[key] = value;
  }
  return out;
}

module.exports = {
  GRID_LAT_DEG,
  CLUSTER_WINDOW_MS,
  PHASH_HAMMING_THRESHOLD,
  sha256Base64,
  sha256Text,
  averageHash,
  hammingDistanceHex,
  gridCell,
  cellCentroid,
  intakePublicReport,
  recordPatrolBatch,
};
