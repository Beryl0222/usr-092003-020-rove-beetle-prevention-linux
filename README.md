# 隐翅虫环境防控巡查后端

面向区级爱国卫生部门的环境防控巡查后端：汇总降雨、温湿度、诱捕点、灯具类型、绿化水体、
纱窗设施与居民匿名发现，按区域与时段产生**待核查**风险点；现场人员确认虫种与环境后，
再安排调光、清理、封堵或必要消杀。系统只产生建议与待办，**不会自动下达任何处置**，
消杀还需区级额外人工审批，以避免伤害其他生物。

纯 Node.js 内置模块实现，无第三方依赖；内存存储并支持 JSON 快照，便于演练与测试。

## 模块结构

| 文件 | 职责 |
| --- | --- |
| `store.js` | 数据模型、种子数据、照片哈希索引、工单事件留痕、快照持久化 |
| `ingest.js` | 公众匿名发现与现场巡查摄入；重复照片、同路线补传合并，防虚假热点 |
| `rules.js` | 风险规则引擎；评分、建议措施、开放预警复用、预警依据（证据链） |
| `workflow.js` | 人工确认 → 选措施 → 消杀审批 → 排期 → 实施 → 复查（通过/失效） |
| `analytics.js` | 措施前后诱捕/报告对比、长期未闭环设施与滞留工单 |
| `service.js` | HTTP 路由、令牌角色、辖区数据隔离 |

## 运行

```bash
npm run check   # 配置与模块自检
npm test        # 15 个端到端接口测试
node service.js # 启动服务，默认 127.0.0.1:8000（可用 PORT 覆盖）
```

## 角色与令牌（演示用，即用户 id）

| 令牌 | 角色 | 数据范围 |
| --- | --- | --- |
| `u_district` | 区级管理员 | 全区；唯一可审批消杀 |
| `u_field1` | 现场巡查员 | 全区；录入观测、核查、复查 |
| `u_school` | 学校 | 仅本辖区工单，可参与排期/实施 |
| `u_property` | 物业 | 仅本辖区工单，可参与排期/实施 |
| 无令牌 | 公众 | 仅匿名发现与预防提示 |

请求头：`Authorization: Bearer <令牌>`。学校与物业查询预警、工单、依据时仅返回本辖区数据，
跨辖区访问返回 `403 outside_jurisdiction`。

## 关键接口

公众（无需认证）

- `POST /v1/public/reports` 匿名发现；只接受区域/点位，携带门牌住址等字段返回 `422 address_not_allowed`
- `GET  /v1/public/advisories` 预防提示正文，不含点位与住址细节

观测与设施（区级/现场）

- `POST /v1/weather` 辖区温湿度、降雨量、雨停时间
- `POST /v1/trap-counts` 诱捕点计数
- `POST /v1/inspections` 巡查记录（带 `routeId`；同路线同点位 24h 内补传自动合并）
- `PATCH /v1/screens/:id` 更新纱窗完好状态与检查时间（修复留痕）

评估与预警

- `POST /v1/evaluations` 执行规则评估，返回 `created`/`reused`/`skippedOffSeason`
- `GET  /v1/alerts?status=&jurisdictionId=` 预警列表（按辖区过滤）
- `GET  /v1/alerts/:id/basis` 预警依据：命中规则、气象、诱捕/报告/巡查/灯具/纱窗/生境观测、人工确认与工单全部留痕

工单闭环（`/v1/alerts/:id/...`）

- `POST confirm` 现场确认虫种与环境；`speciesConfirmed:false` 则取消工单、解除预警
- `POST measures` 仅能从建议措施中选择（`light_adjust|cleanup|seal|disinfest`）
- `POST disinfest-decision` **仅区级**，批准/驳回消杀
- `POST schedule` 排期（含消杀时必须已获批，否则 `409`）
- `POST implement` 登记实施
- `POST verify` 复查；通过则闭环，失效则原工单留痕 `failed` 并自动派生再处置工单

分析（区级/现场）

- `GET /v1/analytics/effect?jurisdictionId=&spanDays=14` 区域措施前后诱捕/报告对比
- `GET /v1/analytics/effect/work-orders/:id` 单工单前后对比
- `GET /v1/analytics/unclosed?stallDays=7&screenDays=14` 破损纱窗与滞留/失效工单

## 防虚假热点机制

- **照片去重**：对照片内容做 SHA-256，全局登记；相同照片再次出现只引用首次记录，不产生新信号，
  跨路线重复照片在巡查记录上标记 `duplicatePhotoOf`。
- **时间桶合并**：无照片的公众发现，同区域/同点位 1 小时内重复提交并入同一桶（`mergedInto`），
  聚集规则只统计 `status=new` 的独立信号。
- **巡查补传合并**：同一路线对同一点位 24 小时内的补传更新原记录（`mergeCount`），不新增热点。
- **开放预警复用**：同一点位 48 小时内重复评估只累加 `reassessments`，不重复生成预警与工单。

## 风险规则（阈值见 `rules.js` 的 `THRESHOLDS`）

活跃季节（4–10 月）为前提；核心虫情信号为「雨后 48h 内且 20–35℃、湿度≥65%」「72h 诱捕量
环比上升≥50%」「24h 内去重后独立公众发现≥3 条」；叠加强趋光灯具（紫外/强白光）、纱窗破损、
临水/腐殖质生境等加权。仅中/高级且命中核心信号才派发现场核查；纯设施低信号由"未闭环"分析跟踪。
消杀只在高风险时作为**需审批备选**出现。
