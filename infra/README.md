# Signal Hunt - AWS Infrastructure

## 架构

```
NFC Device
    │
    ▼
CloudFront ─────────────────────────────────┐
    │                                        │
    ├── /api/* ──► API Gateway (HTTP API) ──► Lambda ──► DynamoDB
    │
    └── /* ──► S3 (静态网站)
```

## 成本优化策略

| 组件 | 选择 | 原因 |
|------|------|------|
| API Gateway | HTTP API (v2) | 比 REST API 便宜 ~70% |
| Lambda | ARM64 + 128MB | ARM 比 x86 便宜 20%，128MB 足够处理简单 CRUD |
| DynamoDB | On-Demand (PAY_PER_REQUEST) | 无流量时零成本，无需预估容量 |
| CloudFront | PRICE_CLASS_100 | 仅北美+欧洲节点，最便宜的价格等级 |
| S3 | 标准存储 | 静态文件极少，成本可忽略 |
| 日志 | 1 周保留 | 控制 CloudWatch 日志成本 |
| TTL | 30 天自动过期 | 自动清理旧数据，减少存储 |

**预估月成本（低流量场景，<1000 次打卡/月）：< $1/月**

## 部署步骤

### 前置条件

- Node.js 18+
- AWS CLI 已配置 (`aws configure`)
- CDK CLI (`npm install -g aws-cdk`)

### 1. 安装依赖

```bash
cd infra
npm install

cd ../lambda/checkin
npm install
```

### 2. Bootstrap CDK（首次部署）

```bash
cd infra
cdk bootstrap
```

### 3. 部署

部署需要提供两个**不应硬编码进仓库**的配置项：

| 配置项 | CDK context 参数 | 环境变量 | 说明 |
|--------|------------------|----------|------|
| 管理员邮箱 | `adminEmail` | `ADMIN_EMAIL` | 预创建的 Cognito 管理员账号邮箱 |
| ACM 证书 ARN | `certificateArn` | `CERTIFICATE_ARN` | CloudFront 自定义域名证书（须在 us-east-1） |

通过 context 传入：

```bash
cd infra
cdk deploy \
  -c adminEmail=you@example.com \
  -c certificateArn=arn:aws:acm:us-east-1:<account-id>:certificate/<cert-id>
```

或通过环境变量：

```bash
cd infra
$env:ADMIN_EMAIL="you@example.com"          # PowerShell
$env:CERTIFICATE_ARN="arn:aws:acm:us-east-1:<account-id>:certificate/<cert-id>"
cdk deploy
```

> 缺少任一配置时，`cdk synth` / `cdk deploy` 会直接报错并提示需要提供的值。

部署完成后会输出：
- `CloudFrontURL` - 前端访问地址
- `ApiEndpoint` - API 地址

### 种子脚本与本地文件

以下文件包含真实账号/密码或硬编码的资源名称，已加入 `.gitignore`，**保留在本地使用但不会提交**：

- `SOP-展商.md` / `SOP-志愿者.md`（含初始密码）
- `lambda/checkin/scripts/test-users.json`（含账号密码）
- `scripts/seed-lottery-demo.mjs`、`lambda/checkin/scripts/seed-lottery-demo.mjs`、`seed-lottery-full.mjs`、`cleanup-garbled.mjs`（硬编码表名）

`test-users.example.json` 是可提交的占位模板，可作为创建本地 `test-users.json` 的参考。

### 4. 销毁（清理资源）

```bash
cd infra
cdk destroy
```

## API 接口

### POST /api/checkin

NFC 打卡请求。

```json
{
  "userId": "user-abc-123",
  "stationId": 3
}
```

Response:
```json
{
  "success": true,
  "message": "Station 3 checked in!",
  "userId": "user-abc-123",
  "stationId": 3,
  "checkinTime": "2026-05-07T10:30:00.000Z"
}
```

### GET /api/checkin/{userId}

查询用户打卡进度。

Response:
```json
{
  "userId": "user-abc-123",
  "totalCheckins": 5,
  "completed": false,
  "stations": [
    { "stationId": 1, "checkinTime": "2026-05-07T10:00:00.000Z" },
    { "stationId": 3, "checkinTime": "2026-05-07T10:30:00.000Z" }
  ]
}
```

## DynamoDB 表结构

| 字段 | 类型 | 说明 |
|------|------|------|
| userId (PK) | String | 用户唯一标识 |
| stationId (SK) | Number | 站点编号 1-10 |
| checkinTime | String | ISO 时间戳 |
| ttl | Number | Unix 时间戳，30天后自动过期 |

**GSI: StationIndex**
- PK: stationId
- SK: checkinTime
- 用途：按站点查询所有打卡记录
