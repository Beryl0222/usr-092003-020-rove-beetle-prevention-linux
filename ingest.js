"use strict";

// 摄入层：公众匿名发现与现场巡查记录的写入去重。
// 目标：重复照片、同一巡查路线的补传，都不能制造新的"热点"信号。

const { genId, nowIso, photoSha } = require("./store");

// 同一辖区/点位在此时长内、且无独立照片佐证的公众发现，视为同一聚集信号
const REPORT_BUCKET_HOURS = 1;
// 同一路线对同一点位的补传合并窗口
const INSPECTION_MERGE_HOURS = 24;

// 公众匿名发现。
// 入参：{ jurisdictionId, siteId?, at?, photoData?(任意可哈希内容), contact?(可选) }
// 位置只接受区域/点位归属，不接受门牌住址细节。
function recordPublicReport(store, input) {
  const at = input.at || nowIso();
  const sha = photoSha(input.photoData);

  // 1) 照片内容全局去重：重复照片只保留引用，不产生新信号
  const priorPhoto = sha ? store.photoFirstSeen(sha) : null;
  const duplicatePhoto = priorPhoto || null;

  // 2) 同时段、同位置的匿名文字上报合并为同一时间桶，重复提交不重复计数
  const bucket = hourBucket(at, REPORT_BUCKET_HOURS);
  const existing = store.one(
    "publicReports",
    (r) =>
      !r.duplicatePhotoOf &&
      r.jurisdictionId === input.jurisdictionId &&
      (r.siteId || null) === (input.siteId || null) &&
      hourBucket(r.at, REPORT_BUCKET_HOURS) === bucket
  );

  if (duplicatePhoto || existing) {
    const rec = {
      id: genId("pr"),
      jurisdictionId: input.jurisdictionId,
      siteId: input.siteId || null,
      at,
      photoSha: sha,
      contact: input.contact || null,
      status: "duplicate",
      duplicatePhotoOf: duplicatePhoto ? duplicatePhoto.id : null,
      mergedInto: existing ? existing.id : duplicatePhoto ? duplicatePhoto.id : null,
      createdAt: nowIso(),
    };
    store.add("publicReports", rec);
    if (existing) existing.duplicateCount = (existing.duplicateCount || 0) + 1;
    // 新照片随合并信号登记到原始记录名下，后续相同照片仍指向同一信号
    if (sha && !duplicatePhoto) store.registerPhoto(sha, "public_report", existing.id);
    return { report: rec, duplicated: true, mergedInto: rec.mergedInto };
  }

  const report = {
    id: genId("pr"),
    jurisdictionId: input.jurisdictionId,
    siteId: input.siteId || null,
    at,
    photoSha: sha,
    contact: input.contact || null,
    status: "new",
    duplicateCount: 0,
    createdAt: nowIso(),
  };
  store.add("publicReports", report);
  if (sha) store.registerPhoto(sha, "public_report", report.id);
  return { report, duplicated: false };
}

// 现场巡查记录。同一巡查路线（routeId）对同一点位在合并窗口内的补传：
// 更新原记录而不是新增，避免一条路线反复上传把该点刷成热点。
function recordInspection(store, input) {
  const at = input.at || nowIso();
  const sha = photoSha(input.photoData);

  const priorPhoto = sha ? store.photoFirstSeen(sha) : null;
  const duplicatePhotoOf = priorPhoto ? priorPhoto.id : null;

  const prior = store.one(
    "inspections",
    (r) =>
      r.routeId === input.routeId &&
      r.siteId === input.siteId &&
      store.hoursBetween(r.at, at) <= INSPECTION_MERGE_HOURS
  );

  if (prior) {
    // 补传合并：追加发现、推进时间、记录合并次数；不新增记录
    prior.findings = prior.findings.concat(input.findings || []);
    prior.updatedAt = at;
    prior.mergeCount = (prior.mergeCount || 0) + 1;
    if (sha && !duplicatePhotoOf && !prior.photoSha) {
      prior.photoSha = sha;
      store.registerPhoto(sha, "inspection", prior.id);
    }
    return { inspection: prior, merged: true, duplicatePhotoOf };
  }

  const inspection = {
    id: genId("insp"),
    routeId: input.routeId,
    siteId: input.siteId,
    jurisdictionId: input.jurisdictionId,
    inspectorId: input.inspectorId || null,
    at,
    findings: input.findings || [],
    photoSha: duplicatePhotoOf ? null : sha,
    duplicatePhotoOf,
    mergeCount: 0,
    createdAt: nowIso(),
  };
  store.add("inspections", inspection);
  if (sha && !duplicatePhotoOf) store.registerPhoto(sha, "inspection", inspection.id);
  return { inspection, merged: false, duplicatePhotoOf };
}

function hourBucket(iso, spanHours) {
  const ms = new Date(iso).getTime();
  return Math.floor(ms / (spanHours * 36e5));
}

module.exports = {
  recordPublicReport,
  recordInspection,
  hourBucket,
  REPORT_BUCKET_HOURS,
  INSPECTION_MERGE_HOURS,
};
