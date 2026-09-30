"use strict";

// 演示种子数据：账号、三类片区、设施、雨后温湿气象、上升的诱捕计数。
// 时间相对“当前”生成，保证启动后规则引擎能真实触发。

function seed(store) {
  const now = Date.now();
  const iso = (offsetMs) => new Date(now + offsetMs).toISOString();
  const hours = (h) => h * 3600 * 1000;
  const days = (d) => d * 24 * 3600 * 1000;

  const school = store.addArea({
    id: "area_school",
    name: "阳光小学",
    kind: "school",
    district: "花溪区",
    lat: 26.582,
    lng: 106.721,
  });
  const community = store.addArea({
    id: "area_community",
    name: "幸福社区",
    kind: "community",
    district: "花溪区",
    lat: 26.576,
    lng: 106.715,
  });
  const riverside = store.addArea({
    id: "area_riverside",
    name: "滨河绿化带",
    kind: "waterside",
    district: "花溪区",
    lat: 26.571,
    lng: 106.728,
  });

  store.addAccount({
    id: "acct_district",
    name: "花溪区爱卫办",
    role: "district",
    areaIds: [school.id, community.id, riverside.id],
    token: "district-demo-token",
  });
  store.addAccount({
    id: "acct_inspector",
    name: "巡查员李彤",
    role: "inspector",
    areaIds: [school.id, community.id, riverside.id],
    token: "inspector-demo-token",
  });
  store.addAccount({
    id: "acct_school",
    name: "阳光小学后勤处",
    role: "school",
    areaIds: [school.id],
    token: "school-demo-token",
  });
  store.addAccount({
    id: "acct_property",
    name: "幸福社区物业服务中心",
    role: "property",
    areaIds: [community.id],
    token: "property-demo-token",
  });

  // 学校：操场强白光未调光、宿舍楼纱窗破损
  store.addLamp({
    id: "lamp_playground",
    areaId: school.id,
    name: "操场东侧高杆灯",
    lampType: "white_strong",
    wattage: 400,
    nightHours: 10,
    lat: 26.5825,
    lng: 106.7216,
    adjusted: false,
  });
  store.addLamp({
    id: "lamp_gate_warm",
    areaId: school.id,
    name: "校门暖光廊灯",
    lampType: "warm_led",
    wattage: 30,
    nightHours: 6,
    lat: 26.5815,
    lng: 106.7206,
    adjusted: true,
  });
  store.addScreen({
    id: "screen_dorm_3",
    areaId: school.id,
    name: "3号宿舍楼二层纱窗",
    facilityKind: "window",
    intact: false,
    damageNote: "纱网开裂约15厘米",
    damagedSince: iso(-days(20)),
    lastCheckedAt: iso(-days(20)),
    lat: 26.5828,
    lng: 106.7219,
  });
  store.addWaterSite({
    id: "water_flowerbed",
    areaId: school.id,
    name: "教学楼后侧花坛",
    kind: "flowerbed",
    standingWater: true,
    tidy: false,
    lastCheckedAt: iso(-days(2)),
    lat: 26.5811,
    lng: 106.7212,
  });
  const trapSchool = store.addTrap({
    id: "trap_school_gate",
    areaId: school.id,
    name: "校门诱捕点",
    lat: 26.5816,
    lng: 106.7205,
  });

  // 社区
  store.addLamp({
    id: "lamp_community_path",
    areaId: community.id,
    name: "中心花园步道灯",
    lampType: "uv_adhesive",
    wattage: 18,
    nightHours: 12,
    lat: 26.5762,
    lng: 106.7153,
    adjusted: false,
  });
  store.addScreen({
    id: "screen_club_door",
    areaId: community.id,
    name: "老年活动中心门帘",
    facilityKind: "door",
    intact: true,
    lastCheckedAt: iso(-days(5)),
    lat: 26.5758,
    lng: 106.7149,
  });
  const trapCommunity = store.addTrap({
    id: "trap_community_garden",
    areaId: community.id,
    name: "中心花园诱捕点",
    lat: 26.5763,
    lng: 106.7154,
  });

  // 滨河绿化带：临水、钠灯已调光
  store.addLamp({
    id: "lamp_riverside_sodium",
    areaId: riverside.id,
    name: "滨河步道钠灯",
    lampType: "sodium",
    wattage: 70,
    nightHours: 8,
    lat: 26.5712,
    lng: 106.7282,
    adjusted: true,
  });
  store.addWaterSite({
    id: "water_riverbank",
    areaId: riverside.id,
    name: "滨河植被缓冲带",
    kind: "greenbelt",
    standingWater: true,
    tidy: false,
    lastCheckedAt: iso(-days(1)),
    lat: 26.571,
    lng: 106.728,
  });

  // 气象：昨夜降雨、当前暖湿
  for (const areaId of [school.id, community.id, riverside.id]) {
    store.addWeather({ areaId, observedAt: iso(-hours(20)), rainfallMm: 0, tempC: 24, humidityPct: 68, source: "weather_api" });
    store.addWeather({ areaId, observedAt: iso(-hours(14)), rainfallMm: 11.5, tempC: 23, humidityPct: 82, source: "weather_api" });
    store.addWeather({ areaId, observedAt: iso(-hours(2)), rainfallMm: 0, tempC: 26.4, humidityPct: 86, source: "weather_api" });
  }

  // 诱捕：前 7 天低位，近 7 天明显上升
  const mkCounts = (trap, areaId, base) => {
    for (let d = 13; d >= 8; d -= 1) {
      store.addTrapCount({ trapId: trap, areaId, capturedAt: iso(-days(d)), count: base + (d % 2) });
    }
    for (let d = 6; d >= 1; d -= 1) {
      store.addTrapCount({ trapId: trap, areaId, capturedAt: iso(-days(d)), count: base * 4 + d });
    }
  };
  mkCounts(trapSchool.id, school.id, 1);
  mkCounts(trapCommunity.id, community.id, 1);

  // 一条面向公众的预防提示
  store.addAdvisory({
    id: "adv_seasonal",
    areaId: null,
    title: "雨后夜间隐翅虫防护提示",
    content:
      "近期降雨频繁、空气湿度高，隐翅虫夜间趋光活跃。请关好纱门纱窗，减少强光直射室外；" +
      "皮肤上落虫时不要拍打或捏碎，轻轻吹走或用纸片拨离后用清水冲洗；如出现条索状红斑灼痛请及时就医。",
    publishedAt: iso(-hours(3)),
    publishedBy: "acct_district",
  });

  return store;
}

module.exports = { seed };
