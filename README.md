# GitHub Actions 流量监控·封禁系统

> 定时检测流量超标 + GitHub 泄露 + AI 分析，联动 glass.js 执行三层封禁

---

## 目录

- [一、架构概览](#一架构概览)
- [二、仓库结构](#二仓库结构)
- [三、部署步骤](#三部署步骤)
- [四、GitHub Secrets 配置](#四github-secrets-配置)
- [五、Worker 环境变量配置](#五worker-环境变量配置)
- [六、功能说明](#六功能说明)
  - [6.1 流量超标封禁](#61-流量超标封禁)
  - [6.2 GitHub 泄露检测](#62-github-泄露检测)
  - [6.3 AI 智能分析](#63-ai-智能分析)
  - [6.4 三层封禁机制](#64-三层封禁机制)
- [七、TG 通知效果](#七tg-通知效果)
- [八、定时频率修改](#八定时频率修改)
- [九、故障排查](#九故障排查)
- [十、文件清单](#十文件清单)

---

## 一、架构概览

```
flow.js Worker（轻量）
  ├─ 流量监控面板
  ├─ 定时发基本 TG 报告
  └─ 点"推送至 Telegram"时触发 GitHub Actions

GitHub Actions（无 CPU 限制）
  ├─ 查 CF 流量 TOP3 → 超标封禁
  ├─ GitHub 泄露检测 → 发现泄露封禁
  ├─ AI 分析（5 分钟超时，重试 2 次）
  └─ 发 TG 通知

glass.js Worker（被调用执行封禁）
  ├─ 软封（假节点）
  ├─ TG ID 黑名单
  └─ 触发 redirect-block.yml 硬封（CF Redirect Rules）
```

**完整流程：**

```
GitHub Actions (traffic-ban.js)
  │
  ├─ 1. 从 flow.js 获取 CF 账号配置 + 封禁阈值
  │     GET /api/settings, /api/configs
  │
  ├─ 2. 从 glass.js 获取 SaaS/WSaaS/PSaaS 账号
  │     GET /api/saas/profiles 等
  │
  ├─ 3. 并行执行：
  │     ├─ 查 CF GraphQL API 获取 24H 探针流量 TOP3
  │     └─ GitHub 泄露检测（GET /api/github-leak-tg）
  │
  ├─ 4. 超标用户 → 调用 glass.js 封禁 API
  │     POST /api/admin/auto_block_by_traffic
  │
  ├─ 5. 泄露用户 → 同样调用 glass.js 封禁 API
  │
  ├─ 6. AI 分析（从 flow.js /api/ai-prompt 获取 prompt，调 AI API）
  │
  └─ 7. 发送 TG 通知（封禁结果 + 泄露检测 + AI 分析）
```

---

## 二、仓库结构

```
gp-fengsuo/
├── .github/
│   └── workflows/
│       ├── traffic-ban.yml          ← 流量监控+封禁+AI分析（定时触发）
│       └── redirect-block.yml       ← CF Redirect Rules 硬封（被 glass.js 触发）
├── scripts/
│   ├── traffic-ban.js               ← 查流量+泄露检测+封禁+AI分析脚本
│   └── redirect-block.js            ← CF Redirect Rules 硬封脚本
└── README.md
```

| 文件 | 作用 | 触发方式 |
|------|------|---------|
| `traffic-ban.yml` | 流量监控+封禁+泄露检测+AI分析 | 每 2 小时定时 / 手动 / flow.js TG 推送触发 |
| `redirect-block.yml` | CF Redirect Rules 硬封 | glass.js workflow_dispatch 触发 |
| `traffic-ban.js` | 封禁+泄露检测+AI分析主脚本 | 被 traffic-ban.yml 调用 |
| `redirect-block.js` | 硬封执行脚本 | 被 redirect-block.yml 调用 |

---

## 三、部署步骤

### 步骤 1：推送文件到 GitHub 仓库

确保仓库有以下文件：

```
.github/workflows/traffic-ban.yml
.github/workflows/redirect-block.yml
scripts/traffic-ban.js
scripts/redirect-block.js
```

### 步骤 2：配置 GitHub Secrets

见 [第四章](#四github-secrets-配置)

### 步骤 3：配置 Worker 环境变量

见 [第五章](#五worker-环境变量配置)

### 步骤 4：设置流量封禁阈值

在 flow.js 面板的"报警设置"中设置流量封禁阈值（如 40GB），点"写入并重载"。
GitHub Actions 会自动读取这个阈值。

设为 0 则禁用流量封禁（仅做 AI 分析和泄露检测）。

### 步骤 5：测试

在 GitHub 仓库 `Actions` 页面：
1. 找到"流量监控·封禁+AI分析"
2. 点 `Run workflow` 手动触发
3. 查看运行日志确认无报错
4. 检查 Telegram 是否收到通知消息

---

## 四、GitHub Secrets 配置

在仓库 `Settings → Secrets and variables → Actions` 中添加以下 Secrets：

### 4.1 必需 Secrets

| Secret 名 | 说明 | 示例值 |
|-----------|------|--------|
| `FLOW_URL` | flow.js Worker 地址 | `https://flow.xxx.workers.dev` |
| `FLOW_PWD` | flow.js 的 WEB_PASSWORD | `你的密码` |
| `GLASS_URL` | glass.js Worker 地址 | `https://glass.xxx.workers.dev` |
| `GLASS_PWD` | glass.js 的 FRONTEND_PASSWORD | `你的密码` |
| `GLASS_API_URL` | glass.js Worker 地址（硬封用，和 GLASS_URL 相同） | `https://glass.xxx.workers.dev` |
| `REDIRECT_INTERNAL_KEY` | 内部通信密钥（和 glass.js Worker 的同名环境变量一致） | `你自己定的密钥` |

### 4.2 AI 分析 Secrets

| Secret 名 | 说明 | 示例值 |
|-----------|------|--------|
| `AI_API_KEY` | AI API Key | `sk-xxxx` |
| `AI_API_URL` | AI API 地址 | `https://api.xxx.com/v1/chat/completions` |
| `AI_MODEL` | AI 模型名 | `gpt-4o` / `glm-4-flash` 等 |

### 4.3 Telegram 通知 Secrets

| Secret 名 | 说明 | 示例值 |
|-----------|------|--------|
| `TG_TOKEN` | Telegram Bot Token | `123456:ABC-DEF...` |
| `TG_CHATID` | Telegram Chat ID | `-1001234567890` |

---

## 五、Worker 环境变量配置

### 5.1 flow.js Worker 环境变量

在 Cloudflare Dashboard → flow.js Worker → Settings → Variables 中添加：

| 变量名 | 说明 | 示例值 |
|--------|------|--------|
| `GH_TOKEN` | GitHub PAT（需 repo + workflow 权限） | `ghp_xxxxx` |
| `GH_TRAFFIC_BAN_REPO` | GitHub 仓库名 | `snll66/gp-fengsuo` |

**获取 GitHub Token：**

打开 https://github.com/settings/tokens → Generate new token (classic) → 勾选 `repo` + `workflow` → 生成后复制

### 5.2 glass.js Worker 环境变量

确保 glass.js Worker 有以下环境变量（如果之前硬封功能可用，说明已配好）：

| 变量名 | 说明 |
|--------|------|
| `GH_TOKEN` | GitHub PAT（同上） |
| `GH_REPO` | GitHub 仓库名（如 `snll66/gp-fengsuo`） |
| `REDIRECT_INTERNAL_KEY` | 内部通信密钥（和 GitHub Secrets 中的相同） |
| `FRONTEND_PASSWORD` | glass.js 管理密码（和 GitHub Secrets 中的 GLASS_PWD 相同） |

---

## 六、功能说明

### 6.1 流量超标封禁

- 每 2 小时查询 CF GraphQL API，获取 24H 探针路径流量 TOP3
- 超过阈值的路径提取用户名，调用 glass.js 封禁 API
- 阈值在 flow.js 面板"报警设置"中配置，设为 0 则禁用

### 6.2 GitHub 泄露检测

- 调用 flow.js `/api/github-leak-tg` API 获取最近 5 天的泄露用户名
- 搜索 GitHub 公开代码中是否有人泄露了域名/路径
- 发现泄露用户 → 调用 glass.js 封禁 API
- 与流量查询并行执行，不增加额外耗时

### 6.3 AI 智能分析

- 从 flow.js `/api/ai-prompt` 获取构建好的 AI messages（含告警检测+prompt构建）
- 调用 AI API 进行分析，超时 5 分钟，重试 2 次
- 分析全网趋势、节点异常、探针关联、衰退信号
- 超时或失败会在 TG 通知中标注"AI 分析超时或失败，已放弃"

### 6.4 三层封禁机制

glass.js 收到封禁指令后执行：

| 层级 | 作用 | 执行方式 |
|------|------|---------|
| 软封 | 订阅返回假节点 | userData.blocked=true |
| TG 黑名单 | 防换号重注册 | TG ID 加入黑名单 |
| 硬封 | CF Redirect Rules 拦截 | 触发 redirect-block.yml，301 → 127.0.0.1:1 |

---

## 七、TG 通知效果

### 7.1 flow.js Worker 发送（基本报告）

```
☁️ GlassPanel 监控预警
〰️〰️〰️〰️〰️〰️〰️〰️〰️〰️

📊 全网 24H 概览
 ⚡ 总请求：2.22M 次
 ⏱️ 总流量：711.86 GB
 📡 大盘评估：✅ 整体运行平稳

🚨 节点异常报警触发
🔸 001
   └ 🚫 节点滥用

🎯 24H 探针流量 TOP 3
 jilin9519: 38.66 GB
 qq283119720: 34.08 GB
 asd123: 25.84 GB

✅ 探针检测：TOP3 均未超过 100G 阈值，未发现滥用

🚫 规则：24小时流量超 100GB 自动封禁

〰️〰️〰️〰️〰️〰️〰️〰️〰️〰️
🤖 推送时间 · 2026/7/15 22:52:43
```

### 7.2 GitHub Actions 发送（封禁 + 泄露 + AI 分析）

```
🚫 流量监控 · 封禁 + AI 分析
〰️〰️〰️〰️〰️〰️〰️〰️〰️〰️

🎯 24H 探针流量 TOP 3
 🔴 jilin9519: 43.10 GB ⚠️超标
 🟢 qq283119720: 34.08 GB
 🟢 asd123: 25.84 GB

✅ 流量超标封禁（1个）
 🔒 jilin9519

🔔 GitHub 泄露检测（发现 2 个）
 🔒 baduser1 · 2026-07-14 已封禁
 🔒 baduser2 · 2026-07-13 已封禁

🤖 分析结果
1. jilin9519 流量异常偏高，建议关注...

🤖 GitHub Actions · 2026/7/15 23:00:00
```

### 7.3 glass.js 发送（封禁告警）

```
🚫 流量超标自动封禁

👤 用户名: jilin9519
⚠️ 封禁原因: 24H流量超标: 43.10 GB > 阈值40GB
⏰ 封禁时间: 2026/7/15 18:07:39
```

---

## 八、定时频率修改

编辑 `.github/workflows/traffic-ban.yml` 中的 cron 表达式：

```yaml
on:
  schedule:
    - cron: '0 */2 * * *'  # 每 2 小时（默认）
```

常用 cron 表达式（UTC 时间）：

| 表达式 | 含义 |
|--------|------|
| `0 */2 * * *` | 每 2 小时 |
| `0 */6 * * *` | 每 6 小时 |
| `0 8,20 * * *` | 每天 8 点和 20 点（UTC） |
| `0 0 * * *` | 每天 0 点 |

> 注意：UTC 0 点 = 北京时间 8 点。北京时间 8 点 = UTC 0 点。

---

## 九、故障排查

### 9.1 AI 分析失败

| 错误日志 | 原因 | 解决 |
|---------|------|------|
| `获取 AI prompt 失败: 404` | flow.js 没部署最新版或路由没注册 | 重新部署 flow.js |
| `获取 AI prompt 失败: 401` | FLOW_PWD 密码不对 | 检查 GitHub Secrets |
| `获取 AI prompt 失败: 500` | flow.js KV 无缓存数据 | 先在面板点一次 TG 推送 |
| `AI API 错误: 401` | AI_API_KEY 不对 | 检查 GitHub Secrets |
| `AI API 错误: 404` | AI_API_URL 地址不对 | 检查地址是否正确 |
| `AI API 异常: timeout` | AI 响应超时 | 正常，已重试 2 次 |

### 9.2 封禁失败

| 错误日志 | 原因 | 解决 |
|---------|------|------|
| `API错误404` | glass.js 没部署封禁 API | 重新部署 glass.js |
| `API错误401` | GLASS_PWD 和 FRONTEND_PASSWORD 不一致 | 检查两边密码 |
| `未配置GLASS_URL/PWD` | GitHub Secrets 没配 | 添加 GLASS_URL 和 GLASS_PWD |

### 9.3 硬封不执行

| 现象 | 原因 | 解决 |
|------|------|------|
| glass.js 日志无触发记录 | GH_TOKEN 或 GH_REPO 未配置 | 检查 glass.js Worker 环境变量 |
| Actions 运行报错 | REDIRECT_INTERNAL_KEY 不一致 | 确保 glass.js 和 GitHub Secrets 中一致 |
| Actions 找不到脚本 | 文件路径不对 | 确认 scripts/ 目录下有 redirect-block.js |

### 9.4 workflow 文件报 YAML 语法错误

| 原因 | 解决 |
|------|------|
| `.yml` 文件里误放了 `.js` 代码 | 确保 `.yml` 里是 YAML 格式，`.js` 放在 `scripts/` 目录 |
| 脚本路径不对 | 确保 `run: node scripts/traffic-ban.js`（不是 `.github/scripts/`） |

---

## 十、文件清单

| 文件 | 部署位置 | 说明 |
|------|---------|------|
| `traffic-ban.yml` | GitHub 仓库 `.github/workflows/` | 流量监控 workflow |
| `redirect-block.yml` | GitHub 仓库 `.github/workflows/` | 硬封 workflow |
| `traffic-ban.js` | GitHub 仓库 `scripts/` | 封禁+AI分析脚本 |
| `redirect-block.js` | GitHub 仓库 `scripts/` | 硬封脚本 |
| `flow.js` | Cloudflare Worker | 流量监控 Worker |
| `glass.js` | Cloudflare Worker | 订阅管理+封禁 Worker |
