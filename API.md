# Signal Hunt API 文档

> Base URL: `https://7orrwwprye.execute-api.ap-northeast-1.amazonaws.com`

## 认证说明

| 类型 | 说明 |
|------|------|
| 🔓 Public | 无需认证，任何人可调用 |
| 🔐 JWT (admin) | 需在 `Authorization: Bearer {idToken}` 中携带 admin 组的 Cognito JWT |
| 🔐 JWT (staff/admin) | 需携带 staff 或 admin 组的 JWT |

---

## 一、打卡 (Check-in)

### POST /checkin 🔓
NFC 打卡请求。

**请求体：**
```json
{ "tagId": "2b0d6629", "scannerId": "station-3" }
```

**成功响应 (200)：**
```json
{
  "success": true,
  "tagId": "2b0d6629",
  "stationId": 3,
  "checkinTime": "2026-06-28T10:30:00.000Z",
  "missions": { ... }
}
```

**错误码：**
- `400` — 缺少 tagId/scannerId，或 scannerId 无效
- `404` — tagId 未注册
- `429` — 30 秒冷却期内重复打卡，返回 `remainingSeconds`

---

### GET /checkin/{tagId} 🔓
查询参与者打卡进度。

**响应 (200)：**
```json
{
  "tagId": "2b0d6629",
  "totalCheckins": 5,
  "completed": false,
  "stations": [
    { "stationId": 1, "checkinTime": "2026-06-28T09:00:00Z" },
    { "stationId": 3, "checkinTime": "2026-06-28T10:30:00Z" }
  ],
  "afterPartyEligible": true,
  "lotteryEligible": false,
  "lotteryReason": "incomplete_stations",
  "stationsRemaining": 5,
  "nickname": null,
  "rewardCode": null
}
```

**字段说明：**
- `completed` — 是否集齐全部 10 站
- `afterPartyEligible` — 是否有 After Party 入场打卡
- `lotteryEligible` — 是否满足抽奖条件（10 站 + After Party）
- `lotteryReason` — 不满足时的原因码：`incomplete_stations` / `after_party_checkin_required` / `incomplete_stations_and_no_after_party_checkin`
- `nickname` — 已注册的抽奖昵称（未注册为 null）
- `rewardCode` — 集邮完成后的奖励码

---

### GET /checkin/{tagId}/rewards 🔓
查询参与者的全部可领取奖励。

**响应 (200)：**
```json
{
  "tagId": "demo-tag-1",
  "rewards": [
    {
      "type": "stamp_rally",
      "name": "Stamp Rally 集邮完成",
      "rewardCode": "9779a2214a2685c4f1ea",
      "rewardKey": "stamp_rally",
      "redeemedAt": null
    },
    {
      "type": "lottery_winner",
      "name": "After Party 抽奖中奖 🎉",
      "nickname": "测试用户A",
      "drawSeq": 5,
      "rewardKey": "lottery_winner:5",
      "redeemedAt": null
    }
  ],
  "totalRewards": 2
}
```

**奖励类型：**
- `stamp_rally` — 集齐 10 站
- `combo` — 组合奖励
- `mission_winner` — 任务中奖（幸运抽奖等）
- `early_bird` — 早鸟奖励
- `milestone` — 编号里程碑
- `lottery_winner` — After Party 抽奖中奖

---

## 二、站点流量 (Station Traffic)

### GET /stations 🔓
全部站点的访客统计摘要。

**响应 (200)：**
```json
{
  "stations": [
    { "stationId": 1, "uniqueVisitors": 120 },
    { "stationId": 2, "uniqueVisitors": 85 },
    ...
  ]
}
```

### GET /stations/{stationId} 🔓
单个站点的详细流量（最近 1000 条打卡时间）。

**响应 (200)：**
```json
{
  "stationId": 3,
  "uniqueVisitors": 85,
  "timestamps": ["2026-06-28T10:30:00Z", ...]
}
```

---

## 三、排行榜 (Leaderboard)

### GET /leaderboard 🔓
速度挑战排行榜（集齐 10 站最快的前 20 人）。

**响应 (200)：**
```json
{
  "entries": [
    { "maskedTagId": "2b0d****6629", "elapsedSeconds": 1234, "completedAt": "..." },
    ...
  ],
  "totalEntries": 5
}
```

---

## 四、任务管理 (Missions)

### GET /missions/active 🔓
当前正在进行的任务列表（参与者可见）。

### GET /missions 🔐 admin
全部任务列表（含已结束）。

### POST /missions 🔐 admin
创建任务。

**请求体示例：**
```json
{
  "type": "numbered_visit",
  "name": "站点1限时挑战",
  "stationId": 1,
  "startTime": "2026-06-28T09:00:00Z",
  "endTime": "2026-06-28T12:00:00Z",
  "milestones": [10, 50, 100]
}
```

### GET /missions/{missionId} 🔐 admin
查询单个任务详情。

### PUT /missions/{missionId} 🔐 admin
更新任务（仅未开始的可改）。

### DELETE /missions/{missionId} 🔐 admin
删除任务（仅未开始的可删）。

### GET /missions/{missionId}/winners 🔓
查询任务中奖者名单。

---

## 五、组合奖励 (Combos)

### GET /combos 🔓
查询全部组合配置。

### POST /combos 🔐 admin
创建组合奖励。

**请求体：**
```json
{
  "name": "科技三连",
  "stations": [3, 4, 5],
  "reward": "限量技术 T 恤"
}
```

---

## 六、权益核验 (Entitlements)

### POST /verify/lunch 🔐 staff/admin
核销午餐资格（一次性）。

**请求体：** `{ "tagId": "2b0d6629" }`

### POST /verify/party 🔐 staff/admin
核销派对入场资格（一次性）。

**请求体：** `{ "tagId": "2b0d6629" }`

### POST /entitlement/set 🔐 staff/admin
设置自定义资格。

**请求体：** `{ "tagId": "2b0d6629", "type": "lunch" }`

### POST /entitlement/remove 🔐 staff/admin
移除资格。

**请求体：** `{ "tagId": "2b0d6629", "type": "lunch" }`

### GET /entitlement/{tagId} 🔐 staff/admin
查询参与者全部资格状态。

---

## 七、奖励核销 (Rewards Redeem)

### POST /rewards/redeem 🔐 staff/admin
核销一条奖励。

**请求体：**
```json
{ "tagId": "demo-tag-1", "rewardKey": "stamp_rally" }
```

**rewardKey 格式：**
- `stamp_rally` — 集邮完成
- `combo:{comboName}` — 组合奖励
- `winner:{missionId}` — 任务中奖
- `early_bird:{missionId}` — 早鸟
- `milestone:{missionId}` — 里程碑
- `lottery_winner:{drawSeq}` — 抽奖中奖

---

## 八、抽奖 (Lottery)

### POST /lottery/nickname 🔓
注册抽奖昵称（需满足 10 站 + After Party 入场）。

**请求体：** `{ "tagId": "2b0d6629", "nickname": "量子比特" }`

### GET /lottery/participants 🔓
获取全部已注册的抽奖参与者（大屏展示用）。

**响应 (200)：**
```json
{ "count": 150, "participants": [{ "nickname": "量子比特" }, ...] }
```

### POST /lottery/draw 🔐 admin
执行一次抽奖（支持批量）。

**请求体：** `{ "count": 5 }`（可选，默认 1）

**响应：**
```json
{
  "count": 5,
  "winners": [
    { "drawSeq": 1, "nickname": "量子比特", "tagId": "2b0d6629", "drawnAt": "..." },
    ...
  ]
}
```

### POST /lottery/winner 🔐 admin
手动指定中奖人（无需是已注册参与者）。

**请求体：** `{ "nickname": "萍姐" }`

### POST /lottery/participant 🔐 admin
手动添加抽奖候选人。

**请求体：** `{ "nickname": "某某某" }`

### GET /lottery/winners 🔓
获取全部中奖名单（大屏轮询用）。

**响应：**
```json
{ "count": 3, "winners": [{ "drawSeq": 1, "nickname": "...", "tagId": "...", "drawnAt": "..." }] }
```

### GET /lottery/config 🔓
读取抽奖配置（时间门、总中奖人数）。

### POST /lottery/config 🔐 admin
设置抽奖配置。

**请求体：** `{ "afterPartyTime": "2026-06-28T09:00:00Z", "totalWinners": 10 }`

### POST /lottery/reset 🔐 admin
重置全部抽奖数据（昵称 + 中奖记录）。

### POST /lottery/winner/delete 🔐 admin
按昵称删除中奖记录。

**请求体：** `{ "nicknames": ["萍姐", "丹丹", "琳小轩"] }`

---

## 九、管理操作 (Admin)

### POST /admin/reset-stats 🔐 admin
重置所有统计数据（保留站点 1 默认打卡和配置）。

**响应：** `{ "reset": true, "deletedCount": 1234 }`

### GET /admin/users 🔐 admin
列出全部志愿者/展商账号。

**响应：**
```json
{
  "count": 20,
  "users": [
    { "email": "staff1@example.com", "group": "staff", "stationId": null, "status": "CONFIRMED" },
    { "email": "exhibitor1@example.com", "group": "exhibitor", "stationId": "1", "status": "CONFIRMED" }
  ]
}
```

### POST /admin/users 🔐 admin
创建志愿者/展商账号。

**请求体：**
```json
{ "email": "new@example.com", "group": "exhibitor", "password": "MyPass123!", "stationId": "5" }
```

### POST /admin/users/password 🔐 admin
重置账号密码。

**请求体：** `{ "email": "staff1@example.com", "password": "NewPass456!" }`

### POST /admin/users/delete 🔐 admin
删除账号。

**请求体：** `{ "email": "staff1@example.com" }`

---

## 通用错误格式

所有错误响应结构一致：
```json
{
  "error": "error_code",
  "message": "人类可读的错误描述",
  "field": "出错字段（可选）"
}
```

## CORS

全部端点支持 `OPTIONS` 预检，返回：
- `Access-Control-Allow-Origin: *`
- `Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS`
- `Access-Control-Allow-Headers: Content-Type, Authorization`

---

## 快速测试示例 (curl)

```bash
# 查询某参与者打卡进度
curl https://7orrwwprye.execute-api.ap-northeast-1.amazonaws.com/checkin/2b0d6629

# 查询全部站点流量
curl https://7orrwwprye.execute-api.ap-northeast-1.amazonaws.com/stations

# 查询排行榜
curl https://7orrwwprye.execute-api.ap-northeast-1.amazonaws.com/leaderboard

# 查询抽奖参与者列表
curl https://7orrwwprye.execute-api.ap-northeast-1.amazonaws.com/lottery/participants

# 查询中奖名单
curl https://7orrwwprye.execute-api.ap-northeast-1.amazonaws.com/lottery/winners
```

> 管理接口需要先通过 Cognito 获取 JWT token，再在请求头加 `Authorization: Bearer {token}`。

---

## 十、外部系统集成：获取 JWT Token

需要 JWT 的接口（🔐 标记）必须先通过 Cognito 认证获取 token。以下是完整流程。

### 配置参数

| 参数 | 值 |
|------|------|
| Cognito 区域 | `ap-northeast-1` |
| Cognito Endpoint | `https://cognito-idp.ap-northeast-1.amazonaws.com/` |
| User Pool ID | `ap-northeast-1_dBdKduSNI` |
| Client ID | `43gokealbmen6doviustcfh62c` |
| Auth Flow | `USER_PASSWORD_AUTH` |
| Token 有效期 | IdToken 24 小时 / RefreshToken 7 天 |

> 无需 Client Secret（User Pool Client 配置为无 secret 的公开客户端）。

### Step 1：用邮箱+密码获取 Token

```bash
curl -X POST https://cognito-idp.ap-northeast-1.amazonaws.com/ \
  -H "Content-Type: application/x-amz-json-1.1" \
  -H "X-Amz-Target: AWSCognitoIdentityProviderService.InitiateAuth" \
  -d '{
    "AuthFlow": "USER_PASSWORD_AUTH",
    "ClientId": "43gokealbmen6doviustcfh62c",
    "AuthParameters": {
      "USERNAME": "your-admin@email.com",
      "PASSWORD": "your-password"
    }
  }'
```

**成功响应：**
```json
{
  "AuthenticationResult": {
    "IdToken": "eyJra...(很长的 JWT)...",
    "AccessToken": "eyJra...",
    "RefreshToken": "eyJjd...",
    "ExpiresIn": 86400
  }
}
```

取 `AuthenticationResult.IdToken` 的值。

### Step 2：调用业务接口

```bash
curl -X POST https://7orrwwprye.execute-api.ap-northeast-1.amazonaws.com/lottery/draw \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer eyJra...(Step 1 拿到的 IdToken)..." \
  -d '{"count": 1}'
```

### Step 3：Token 过期后刷新

IdToken 24 小时过期后，用 RefreshToken 换取新 token（无需重新输入密码）：

```bash
curl -X POST https://cognito-idp.ap-northeast-1.amazonaws.com/ \
  -H "Content-Type: application/x-amz-json-1.1" \
  -H "X-Amz-Target: AWSCognitoIdentityProviderService.InitiateAuth" \
  -d '{
    "AuthFlow": "REFRESH_TOKEN_AUTH",
    "ClientId": "43gokealbmen6doviustcfh62c",
    "AuthParameters": {
      "REFRESH_TOKEN": "eyJjd...(Step 1 拿到的 RefreshToken)..."
    }
  }'
```

### Python 完整示例

```python
import requests

COGNITO_URL = "https://cognito-idp.ap-northeast-1.amazonaws.com/"
CLIENT_ID = "43gokealbmen6doviustcfh62c"
API_BASE = "https://7orrwwprye.execute-api.ap-northeast-1.amazonaws.com"

# 1. 认证
auth_resp = requests.post(COGNITO_URL, json={
    "AuthFlow": "USER_PASSWORD_AUTH",
    "ClientId": CLIENT_ID,
    "AuthParameters": {
        "USERNAME": "your-admin@email.com",
        "PASSWORD": "your-password"
    }
}, headers={
    "Content-Type": "application/x-amz-json-1.1",
    "X-Amz-Target": "AWSCognitoIdentityProviderService.InitiateAuth"
})
id_token = auth_resp.json()["AuthenticationResult"]["IdToken"]

# 2. 调用管理接口
headers = {"Authorization": f"Bearer {id_token}", "Content-Type": "application/json"}

# 示例：执行抽奖
resp = requests.post(f"{API_BASE}/lottery/draw", json={"count": 1}, headers=headers)
print(resp.json())

# 示例：列出全部账号
resp = requests.get(f"{API_BASE}/admin/users", headers=headers)
print(resp.json())

# 示例：重置统计
resp = requests.post(f"{API_BASE}/admin/reset-stats", headers=headers)
print(resp.json())
```

### Node.js 示例

```javascript
const COGNITO_URL = 'https://cognito-idp.ap-northeast-1.amazonaws.com/';
const CLIENT_ID = '43gokealbmen6doviustcfh62c';
const API_BASE = 'https://7orrwwprye.execute-api.ap-northeast-1.amazonaws.com';

// 1. 获取 token
const authResp = await fetch(COGNITO_URL, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/x-amz-json-1.1',
    'X-Amz-Target': 'AWSCognitoIdentityProviderService.InitiateAuth',
  },
  body: JSON.stringify({
    AuthFlow: 'USER_PASSWORD_AUTH',
    ClientId: CLIENT_ID,
    AuthParameters: { USERNAME: 'admin@email.com', PASSWORD: 'password' },
  }),
});
const { AuthenticationResult } = await authResp.json();
const idToken = AuthenticationResult.IdToken;

// 2. 调用接口
const resp = await fetch(`${API_BASE}/lottery/draw`, {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${idToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ count: 1 }),
});
console.log(await resp.json());
```

### 注意事项

- 外部系统使用的账号必须属于 **admin 组**才能调管理接口（staff 组只能调核验/核销接口）
- 建议**缓存 token**（24h 内有效），不要每次请求都重新认证
- 如果认证返回 `NotAuthorizedException`：检查密码是否正确、账号是否为 CONFIRMED 状态
- 如果认证返回 `NEW_PASSWORD_REQUIRED`：账号需要先改密码（用 admin.html 登录一次，或通过 API 调 `RespondToAuthChallenge`）
