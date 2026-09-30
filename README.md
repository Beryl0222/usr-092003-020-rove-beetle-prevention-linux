# 隐翅虫环境防控巡查后端

面向区级爱卫部门的环境防控巡查服务：把降雨、温湿度、诱捕点、灯具类型、绿化水体、纱窗设施
与居民匿名发现按区域与时段汇总，经规则研判产生**需要人工核查的点位与环境性建议**；
现场确认虫种与环境后再安排调光、清理、封堵；消杀必须由区级单独人工授权。
系统不会自动下达可能伤害非靶标生物的处置。

纯 Node.js 内置模块实现，无第三方依赖；内存存储，可通过 `DATA_FILE` 开启 JSON 持久化。

## 运行

```bash
npm run check          # 基础自检
npm test               # 39 项测试
node service.js        # 默认 127.0.0.1:8000，首次启动注入演示数据

DATA_FILE=./data.json PORT=8000 node service.js   # 开启持久化
NO_SEED=1 node service.js                          # 不注入演示数据
```

演示令牌（见 `src/seed.js`）：

| 令牌 | 角色 | 辖区 |
| --- | --- | --- |
| `district-demo-token` | 区级爱卫办 district | 全部区域 |
| `inspector-demo-token` | 巡查员 inspector | 全部区域（可授权范围内核查/实施/复查） |
| `school-demo-token` | 学校 school | 阳光小学 |
| `property-demo-token` | 物业 property | 幸福社区 |

公众接口无需令牌。所有业务接口用 `Authorization: Bearer <token>`。

## 领域模型（`src/store.js`）

- 区域 `areas`：school / community / greenbelt / waterside
- 设施：诱捕点 `traps`、灯具 `lamps`（强白光/紫外诱虫灯/暖光/钠灯、是否已调光）、
  纱窗封堵 `screens`（完好性、破损起始时间）、绿化水体 `waterSites`（积水、整洁度）
- 气象 `weatherReadings`：降雨 mm、温度、湿度与观测时刻
- 诱捕计数 `trapCounts`；巡查记录 `patrolRecords`（路线 routeId + 批次 batchId）
- 公众发现 `publicReports` 与时空聚类 `reportClusters`
- 研判运行 `riskRuns` 与风险点位 `riskPoints`（含证据链 evidence）
- 工单 `workOrders`（事件流 events）；公众预防提示 `advisories`

## 风险研判（`src/risk.js`）

`POST /api/risk/evaluate` 触发一次复算，规则与阈值随运行记录、可审计：

- **季节**：5–10 月（初夏至深秋）才产点，其余月份运行留痕但不出点。
- **雨后暖湿**：近 48 小时累计降雨 ≥ 2mm（+2 分）；最新气温 18–33℃ 且湿度 ≥ 70%（+2 分）。
- **趋光灯具**：未调光的强白光 / 紫外诱虫灯（+2，临水再加 1）。
- **破损纱窗/门缝通风口**（+3）；**积水或未清理的临水绿化**（+2~3）。
- **去重后公众目击**：72 小时、约 50 米网格内独立目击 ≥ 2 起成热点（2 起 +3、≥4 起 +5），
  区域诱捕量同步上升再加 1。
- **巡查目击网格**与**诱捕量异常上升点**（近 7 天较前 7 天 ≥1.5 倍且增量 ≥3）。

得分 ≥ 2/5/8 分别为 watch / warning / high；出现 high 或 ≥3 个 warning 时本次运行为区域预警。
每个点位只携带环境性措施（现场核查、调光、封堵、清理），**规则永远不产出消杀**。
点位按 `dedupKey` 幂等更新；复算时证据消失的待核查点位置为 `cleared` 并记录原因，历史保留。

## 防止虚假热点（`src/dedup.js`）

- 照片字节 **SHA-256 精确去重**：同一素材换坐标、换描述再提交，标记 `duplicate_photo`，权重为 0。
- 8×8 灰度平均哈希 **pHash 近重复**（汉明距离 ≤ 6）：同聚类窗口内相似图标记 `near_duplicate`，不计独立目击。
- **约 50 米网格 + 72 小时滑窗**：只有 `status=unique` 的独立目击累加 `cluster.independentCount`。
- 巡查批次按 `batchId` 幂等；即使补传换了 batchId，相同照片字节、
  或同路线同设施同一分钟的条目仍被丢弃（`droppedDuplicates` 计数），批内重复同样过滤。

## 人工核查与工单流（`src/workorder.js`）

```
proposed ──核查确认虫种+环境──▶ verified ──实施──▶ implemented ──复查通过──▶ closed
   │                                 ▲                  │
   └──核查排除──▶ dismissed      复查不通过/措施失效 ── reopened（可再实施）
```

- 规则点位需由 district/inspector 建单；**未确认 `speciesConfirmed` 与 `environmentConfirmed`
  之前不能实施任何措施**；核查可 `conclusion:"dismiss"` 排除误报。
- 核查环节只允许调整环境措施，加入消杀直接 403。
- `targeted_treatment`（定点消杀）**只能** district 角色在虫种确认后单独授权，
  须填写不少于 10 字的必要性说明；一次一授权，写入事件流。实施时缺授权即被拒绝。
- 实施环境措施会回写设施状态（灯具调光、纱窗修复、水体清理）；
  证据未点名设施时，现场必须在 `targets` 中显式指定**本辖区**设施，禁止跨辖区处置。
- 创建、核查、授权、实施、复查、失效分别产生不可篡改的事件条目（动作人、时间、状态迁移、说明）。

## 数据隔离与隐私

- district 可见全部；inspector/school/property 仅见授权辖区的区域、设施、研判摘要、点位与工单；
  跨辖区读写返回 404/403。研判运行视图按辖区裁剪 `areaSummaries`、点位与预警级别。
- school/property 可对本辖区已核查工单登记实施，但不能授权消杀、不能发布提示。
- 公众预防提示 `GET /api/public/advisories` 只返回标题、正文、发布时间，
  不含区域编号、坐标、门牌住址；公众发现提交为匿名且响应不回传他人数据。

## 效果对比、未闭环识别与溯源

- `GET /api/stats/effectiveness?days=14`：以每张工单**首次实施时间**为界，
  比较前后窗口的诱捕量与去重后独立公众目击（按实际经过天数折算日均）。
- `GET /api/stats/open-items?staleDays=14`：长期破损纱窗、未调光强光灯、积水/未清理水体、
  滞留或重开 ≥2 次的工单。
- `GET /api/risk/runs/:id/explain`：列出某次预警引用的全部气象读数、诱捕观测、
  目击聚类（含独立/重复计数）、巡查批次与设施，以及后续的现场确认与消杀授权人工记录。

## 接口一览

| 方法/路径 | 角色 | 说明 |
| --- | --- | --- |
| `GET /health` | 公开 | 健康检查 |
| `POST /api/public/reports` | 公众 | 匿名提交发现（照片 base64 或 8×8 像素） |
| `GET /api/public/advisories` | 公众 | 脱敏预防提示 |
| `GET /api/me` `GET /api/areas` | 登录 | 账号视角与可见辖区 |
| `POST /api/areas` | district | 新建区域 |
| `POST /api/weather` | district | 录入气象 |
| `POST /api/trap-counts` | district/inspector | 录入诱捕计数 |
| `GET /api/facilities?areaId=` | 登录 | 灯具/纱窗/水体/诱捕点 |
| `POST /api/facilities/{lamps,screens,water-sites,traps}` | district | 新建设施 |
| `PATCH /api/facilities/{lamps,screens,water-sites}/:id` | district | 设施状态维护 |
| `POST/GET /api/patrols` | district/inspector | 巡查批次（幂等）与查询 |
| `POST /api/risk/evaluate` | district/inspector | 规则复算 |
| `GET /api/risk/runs` `GET /api/risk/runs/:id[/explain]` | 登录 | 运行列表、详情、证据溯源 |
| `GET /api/risk/points[/:id]` | 登录（辖区内） | 风险点位 |
| `POST /api/work-orders` | district/inspector | 由点位建单 |
| `GET /api/work-orders` | 登录（辖区内） | 工单列表 |
| `POST /api/work-orders/:id/verify` | district/inspector | 现场确认/排除 |
| `POST /api/work-orders/:id/treatment-authorization` | district | 消杀人工授权 |
| `POST /api/work-orders/:id/implement` | 登录（含学校/物业，本辖区） | 登记实施 |
| `POST /api/work-orders/:id/review` | district/inspector | 复查通过/不通过 |
| `POST /api/work-orders/:id/invalidate` | district/inspector | 登记措施失效 |
| `GET /api/stats/effectiveness` `GET /api/stats/open-items` | 登录（辖区裁剪） | 效果对比与未闭环 |
| `POST /api/advisories` | district | 发布公众提示 |

## 代码结构

```
service.js          HTTP 入口、/health、存储装配
src/store.js        领域模型、内存存储与 JSON 持久化
src/dedup.js        照片哈希/pHash、时空聚类、巡查批次幂等
src/risk.js         季节/气象/诱捕/设施/目击规则引擎与证据链
src/workorder.js    人核门禁、消杀授权、生命周期与留痕
src/app.js          鉴权、辖区隔离、路由、统计与溯源视图
src/seed.js         演示数据
test/               node:test 测试（去重、规则、工单流、HTTP 权限与隐私）
```
