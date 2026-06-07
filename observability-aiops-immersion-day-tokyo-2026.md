# Observability & AIOps Immersion Day - Tokyo 2026

> 日期：7月18日  
> 地点：东京（AWS Office / Partner Office）  
> 受众：在日华人开发者社区（中文授课）  
> 时长：半天下午（13:30 - 17:30，共 4 小时）  
> 场地：主会场 + 2 个分会场

## 主题

**CloudWatch Omni - End-to-End Observability by AI and for AI**

核心理念：

- **By AI**：用 AI 构建和运营可观测性体系，包括 DevOps Agent 与 AIOps。
- **For AI**：为 GenAI / Agent 应用提供可观测性，包括 AgentCore Observability 与评估体系。

## 规划原则

- 每个正式内容 session 统一按 **30 分钟** 设计。
- 给 **NebulaGraph** 保留一个独立 session。
- 场地规划为 **主会场 + 2 个分会场**。
- Workshop 时段允许主会场与两个分会场并行：主会场继续讲内容，两个分会场各安排 1 小时 builder session。
- 核心目标是让关键 speaker / partner 都有明确 session，而不是把重要内容挤进 panel 或 closing。

## 场地设置

- **主会场**：开场、主题演讲、partner session、closing；在 workshop 时段继续安排并行内容。
- **分会场 A / B**：仅在 workshop 时段开放，各承载 1 小时 Builder Session / Hands-on Workshop。

## 议程总览

### 主会场

| 时间 | 模块 | 类型 | 讲师 |
|------|------|------|------|
| 13:30 - 13:40 | 开场 & 活动介绍 | Opening | MC |
| 13:40 - 14:10 | What's New in CloudWatch | 演讲 | Betty Zheng |
| 14:10 - 14:40 | CloudWatch Omni - 端到端可观测性 | 演讲 + Demo | Shanna Chang |
| 14:40 - 15:10 | GenAI Observability on AgentCore | 演讲 + Demo | Miki Tsuwazaki |
| 15:10 - 15:40 | Partner Talk: TrueWatch - AIOps 实践 | 演讲 | TrueWatch SA |
| 15:40 - 15:50 | 茶歇 & 分会场入场 | Break | All |
| 15:50 - 16:20 | Partner Talk: NebulaGraph - Graph for Observability / AIOps | 演讲 | NebulaGraph Speaker |
| 16:20 - 16:50 | DevOps Agent - AI 驱动的运维自动化 | 演讲 + Demo | Yagr Xu |
| 16:50 - 17:20 | 回流 Q&A / Panel / 自由交流 | Q&A | MC + All |
| 17:20 - 17:30 | 总结 & Closing | Closing | MC |

### 分会场 Workshop（与主会场后半段并行）

| 时间 | 分会场 A | 分会场 B |
|------|----------|----------|
| 15:40 - 15:50 | 入场 & 环境准备（与茶歇并行） | 入场 & 环境准备（与茶歇并行） |
| 15:50 - 16:50 | Builder Session: CloudWatch 端到端可观测性实战 | Builder Session: AIOps / Partner Observability 实战 |
| 16:50 - 17:20 | 自由练习、问题排查 & Q&A | 自由练习、问题排查 & Q&A |
| 17:20 - 17:30 | 返回主会场或分会场收尾 | 返回主会场或分会场收尾 |

> 说明：15:50 - 16:50 是核心并行时段。主会场继续安排 NebulaGraph 与 DevOps Agent；两个分会场同步进行 1 小时 builder session。16:50 之后预留回流、问题排查、Q&A 和自由交流，避免 workshop 结束后没有缓冲。

## 模块详细设计

### 1. What's New in CloudWatch（30 min）

**核心信息**：帮助已有 AWS / CloudWatch 用户快速了解近期重要能力更新。

内容要点：

- CloudWatch 近期重点发布回顾。
- Database Insights、Network Monitor、Application Signals、Log Anomaly Detection 等能力更新。
- Metrics / Logs / Traces 的统一分析体验。
- 对开发者、SRE、平台团队的迁移与升级建议。

### 2. CloudWatch Omni - 端到端可观测性（30 min）

**核心信息**：CloudWatch 已经从传统监控工具演进为 AI-native 的全栈可观测性平台。

内容要点：

- 可观测性的演进：Monitoring -> Observability -> AIOps。
- CloudWatch Omni 全景：Metrics、Logs、Traces、Application Signals、Internet Monitor、Network Monitor。
- 从用户浏览器到后端服务的端到端可观测链路。
- AI 能力内嵌：Anomaly Detection、Log Insights 自然语言查询、Contributor Insights。

关键 Demo：

- Application Signals 自动发现服务依赖。
- Natural Language Query in Log Insights。

### 3. GenAI Observability on AgentCore（30 min）

**核心信息**：AI Agent 应用需要新的可观测性维度，AgentCore 提供原生支持。

内容要点：

- GenAI 应用的特殊可观测性需求：Token、成本、工具调用、推理链路、Guardrail、循环检测。
- Agent Trace：完整推理链路可视化。
- Token 用量与成本归因。
- 与 CloudWatch 的统一视图：传统应用 + AI 应用。

关键 Demo：

- Multi-Agent 应用 Trace 可视化。
- Token 成本归因 Dashboard。

### 4. Partner Talk: TrueWatch - AIOps 实践（30 min）

**核心信息**：TrueWatch 如何通过 AIOps 帮助企业做智能运维。

建议内容：

- TrueWatch 产品定位与 AWS 生态集成方式。
- 智能告警降噪与事件聚合。
- 异常检测、根因分析与影响面分析。
- 客户案例分享，优先选择日本或亚太客户案例。

### 5. Partner Talk: NebulaGraph - Graph for Observability / AIOps（30 min）

**核心信息**：用图数据库表达复杂系统依赖、事件关系与根因路径，支撑 AIOps 分析。

建议内容：

- NebulaGraph 在可观测性和 AIOps 场景中的定位。
- 服务、主机、Pod、数据库、告警、事件之间的关系建模。
- Graph 查询如何辅助依赖分析、影响面分析和根因定位。
- 与日志、指标、Trace 或 partner observability 平台的集成方式。

建议 Demo：

- 基于服务依赖图定位故障传播路径。
- 从告警节点反查受影响服务与潜在根因。

### 6. DevOps Agent - AI 驱动的运维自动化（30 min）

**核心信息**：让 AI Agent 成为 7x24 运维伙伴，从告警到分析再到修复建议。

内容要点：

- DevOps Agent 的定位与典型使用场景。
- 告警智能分析、根因定位、Runbook 执行与历史相似问题召回。
- 与 CloudWatch 告警、日志、Trace 的联动。
- 从一条告警进入自动分析与修复建议的完整流程。

关键 Demo：

- 告警触发 -> Agent 自动分析 -> 定位根因 -> 给出修复建议。
- 自然语言运维对话。

### 7. Builder Session: CloudWatch 端到端可观测性实战（60 min）

**目标**：让参与者亲手体验 CloudWatch 端到端可观测性能力。

实验内容：

- 使用预置微服务示例应用确认环境。
- 启用 Application Signals，查看 Service Map。
- 查看端到端 Trace，分析延迟瓶颈。
- Trace -> Log 关联与 Log Insights 自然语言查询。
- 告警触发后的分析与排查流程。

### 8. Builder Session: AIOps / Partner Observability 实战（60 min）

**目标**：体验 partner observability / AIOps 能力，并与主会场内容形成呼应。

可选方向：

- TrueWatch AIOps 实战：告警降噪、异常检测、根因分析。
- NebulaGraph 图分析实战：依赖图建模、影响面分析、根因路径查询。
- 如果两家 partner 都需要动手内容，可将此 session 设计为共同 workshop，或拆成两个 30 分钟 lab block。

### 9. 回流 Q&A / Panel / 自由交流（30 min）

**目标**：给主会场和 workshop 参与者留出讨论与收尾空间。

可选形式：

- 主会场 speaker 与 partner 联合 Q&A。
- Workshop 问题排查与成果展示。
- 自由交流与后续合作讨论。

## 人员分工

| 姓名 | 角色 | 负责模块 |
|------|------|----------|
| Betty Zheng | AWS Developer Advocate | What's New in CloudWatch |
| Shanna Chang | AWS SA | CloudWatch Omni - 端到端可观测性 |
| Miki Tsuwazaki | AWS SA | GenAI Observability on AgentCore |
| Yagr Xu | AWS SA | DevOps Agent - AI 驱动的运维自动化 |
| TrueWatch SA | Partner | TrueWatch AIOps 实践 / Workshop 支持 |
| NebulaGraph Speaker | Partner | Graph for Observability / AIOps |
| 社区 Speaker（TBD） | 社区 | 可作为 MC、closing Q&A、或后续城市场次分享嘉宾 |

## 待确认事项

- NebulaGraph speaker 姓名、主题标题、是否需要 Demo 环境。
- TrueWatch 是否只做主会场演讲，还是同时支持分会场 B workshop。
- NebulaGraph 是否参与分会场 B，或只保留主会场 session。
- 两个分会场 workshop 是否需要提前报名或限制人数。
- 主会场与分会场是否需要统一收尾，还是允许分会场独立结束。
- 16:50 - 17:20 是否做正式 panel，还是保留为自由交流和 workshop buffer。
