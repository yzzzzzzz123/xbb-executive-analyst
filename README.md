# xbb-executive-analyst

基于真实只读销帮帮数据的经营分析 Skill，以及面向国内版企业微信普通员工的智能机器人 WebSocket 长连接服务。

正式 Skill 唯一入口：`skills/xbb-executive-analyst/SKILL.md`。企业微信只是对话通道；同一个真实只读 runner 同时服务于 Codex 对话和企微智能客服。项目不提供 HTML、驾驶舱、工作台、固定报告、样例回退或 CRM 写操作。

## 架构

```text
国内版企业微信智能机器人
        ↕ 官方 WebSocket 长连接
shared/wecom
        ↓ USERID 访问控制
shared/codex（回环 App Server + 每授权主体持久 Thread）
        ↓ 每轮显式 xbb-executive-analyst Skill
Codex Agent（ChatGPT 登录，gpt-5.6-sol/max）
        ↓ 唯一动态工具 query_xbb
skills/xbb-executive-analyst/scripts/query-xbb.ps1
        ↓
真实只读销帮帮数据
```

机器人进程主动连接 `wss://openws.work.weixin.qq.com`。不需要企业管理后台、自建应用、公网 IP、域名、HTTPS 回调、Nginx、Token、EncodingAESKey 或入站端口。

## 前置条件

- 国内版企业微信桌面客户端已更新到当前版本。
- 普通员工在“工作台”中能看到“智能机器人”及“创建”按钮；若企业策略隐藏或禁止创建，才需要管理员开放入口。
- Windows PowerShell 5.1。
- Node.js 22 或更高版本。
- 本机已安装 Codex CLI，并在运行机器人的同一 Windows 用户下使用 ChatGPT 登录；执行 `codex login status` 应显示 `Logged in using ChatGPT`。
- 销帮帮只读凭证已存在于 `%LOCALAPPDATA%\Codex\xbb-openapi\credentials.json`。

首次克隆后安装锁定依赖：

```powershell
cd D:\codex\xbb-executive-analyst
npm ci
```

## 1. 普通员工创建国内版企微机器人

在企业微信桌面客户端依次进入：

```text
工作台 → 智能机器人 → 创建 → 手动创建
→ 填写名称、头像、简介
→ 页面底部“API 模式创建”
→ API 配置选择“使用长连接”
```

保存页面显示的 `Bot ID`，并获取只显示一次的 `Secret`。Secret 不要发送到聊天、写入命令行或提交到仓库。

当前正式接入依据：

- 企业微信官方 Node.js SDK：https://github.com/WecomTeam/aibot-node-sdk
- 国内版客户端创建长连接机器人的当前操作指引：https://cloud.tencent.cn/document/product/1831/137051

## 2. 安全配置 Bot 与本地策略路径

```powershell
cd D:\codex\xbb-executive-analyst

& .\scripts\configure-bot.ps1 -WecomBotId '企微页面显示的Bot ID'
```

脚本随后只安全读取企业微信机器人 Secret。模型直接复用本机 Codex 的 ChatGPT 登录，不询问也不保存 OpenAI API Key 或模型接口地址；正式配置固定使用 `gpt-5.6-sol` 与 `max` 推理强度。

Secret 使用 Windows DPAPI CurrentUser 加密，保存到：

```text
%LOCALAPPDATA%\Codex\xbb-executive-analyst\bot-config.json
```

配置文件版本固定为本机 Codex App Server Agent 版 `4.0`。升级已有 3.0 配置时可以运行 `scripts/migrate-app-server-config.ps1`，脚本只迁移非敏感字段并原样保留 DPAPI 密文，不要求再次输入 Secret。

若希望从凭据输入到后台任务一次完成，运行：

```powershell
& .\scripts\deploy-local-owner.ps1
```

脚本会循环验证 Bot ID/Secret；认证成功后生成五分钟绑定口令。完成绑定的 USERID 会自动获得集团只读权限，随后脚本安装并启动登录后后台任务。

## 3. 一次性识别实际企业微信 USERID

普通员工创建的机器人回传值不应凭姓名或通讯录显示值猜测。正式机器人未启动时运行：

```powershell
& .\scripts\discover-wecom-user.ps1
```

认证成功后终端会输出类似：

```json
{"status":"waiting","pairingPhrase":"绑定 12AB34CD56EF","expiresInSeconds":300}
```

在五分钟内，用待授权人员自己的企业微信单聊机器人，完整发送终端显示的一次性口令。成功后终端只在本机显示实际 USERID：

```json
{"success":true,"userId":"企微实际回传USERID","chatType":"single"}
```

本流程：

- 只接受随机一次性口令。
- 不把普通消息、问题或 USERID 写入仓库和日志文件。
- 不加载访问策略，不调用模型，不读取销帮帮。
- 识别成功或五分钟超时后立即断开。
- 不得与正式机器人进程同时运行；同一个 Bot ID 只保留一个长连接。

需要识别其他授权人时重复一次。

## 4. 配置访问策略

集团只读权限：

```powershell
& .\scripts\configure-access-policy.ps1 `
  -UserId '上一步识别的实际USERID' `
  -AllowAll
```

公司级只读权限：

```powershell
& .\scripts\configure-access-policy.ps1 `
  -UserId '上一步识别的实际USERID' `
  -Company '销帮帮中的准确公司名称'
```

多家公司：

```powershell
& .\scripts\configure-access-policy.ps1 `
  -UserId '上一步识别的实际USERID' `
  -Company '公司A准确全称','公司B准确全称'
```

策略默认位于：

```text
%LOCALAPPDATA%\Codex\xbb-executive-analyst\access-policy.json
```

未登记人员在模型或销帮帮查询发生前即被拒绝；公司级权限还会在 runner 调用时二次强制。

## 5. 前台启动与企微验收

```powershell
& .\scripts\start-wecom-bot.ps1
```

连接过程只输出不含业务内容的状态 JSON。看到下面状态表示 Bot ID 与 Secret 已通过企业微信认证：

```json
{"status":"ready","transport":"wecom-websocket"}
```

单聊机器人发送：

```text
对集团业绩按照公司名称做个排名，并区分课程和咨询占比
```

群聊中先添加机器人，再通过 `@机器人名称` 提问。正确结果应先显示真实运行状态，随后由完整最终答复覆盖；模型或 runner 失败时只返回失败，不使用固定文案数据、样例或旧结果。

机器人后端是一个真正的专用 Codex Agent：桥接进程启动仅监听 `127.0.0.1` 的本机 App Server，并按“USERID + 当前授权范围”的不可逆摘要维护持久 Thread；进程重启后恢复 Thread，上下文不会跨用户共享。每轮都显式加载 `xbb-executive-analyst` Skill。空闲时使用 `turn/start`，同一用户在当前任务仍处理中继续提问时使用 `turn/steer`。

App Server 使用内存中的随机 capability token；命令行只有 token 的 SHA-256 校验值。模型运行在只读、无网络、永不申请批准的沙箱中。公司权限和 `query_xbb` 执行仍由桥接服务层强制，明文事实包由工具网关在 `finally` 中清除。

至少验证：

- 集团级用户可查询真实集团数据。
- 公司级用户只能查询明确授权公司。
- 未登记用户被拒绝且不触发模型或销帮帮。
- 重复消息不会重复查询。
- 当前月答复注明月累计（MTD）。

## 6. 安装登录后后台任务

前台验收完成后按 `Ctrl+C` 停止，再执行：

```powershell
& .\scripts\install-wecom-task.ps1
```

查看：

```powershell
Get-ScheduledTask -TaskName 'Codex-XBB-Executive-Analyst-WeCom' |
  Select-Object TaskName,State
```

移除：

```powershell
& .\scripts\uninstall-wecom-task.ps1
```

任务以配置凭据的同一个 Windows 用户、有限权限和隐藏窗口直接执行 Node 服务入口，登录后自动启动。直接执行避免停止计划任务时遗留 Node/App Server 子进程。电脑关机、睡眠、休眠、断网或用户尚未登录时机器人不在线；当前脚本不是开机前运行的 Windows Service。

## 环境变量部署

生产环境也可以提供一组完整进程环境变量：

- `XBB_WECOM_BOT_ID`
- `XBB_WECOM_BOT_SECRET`
- `XBB_WECOM_WS_URL`，国内版默认 `wss://openws.work.weixin.qq.com`
- `XBB_WECOM_MAX_RECONNECT_ATTEMPTS`，默认 `-1` 无限重连
- `XBB_WECOM_HEARTBEAT_MS`
- `XBB_WECOM_REQUEST_TIMEOUT_MS`
- `XBB_MODEL_PROVIDER`，正式运行时只能是 `codex-app-server`
- `XBB_AGENT_TURN_TIMEOUT_MS`，默认 900000 毫秒
- `XBB_AGENT_STATE_PATH`，默认 `%LOCALAPPDATA%\Codex\xbb-executive-analyst\agent-state.json`
- `XBB_STATUS_LOG_PATH`，默认 `%LOCALAPPDATA%\Codex\xbb-executive-analyst\status.jsonl`，只记录固定连接/Agent 状态枚举
- `XBB_CODEX_COMMAND`，仅在无法自动定位 Codex CLI 时指定绝对可执行文件路径
- `XBB_CODEX_MODEL`，正式默认 `gpt-5.6-sol`
- `XBB_CODEX_REASONING_EFFORT`，正式默认 `max`；也支持 `minimal`、`low`、`medium`、`high` 或 `xhigh`
- `XBB_ACCESS_POLICY_PATH`

只要 Bot ID 与 Secret 环境变量不完整，服务就读取 DPAPI 安全配置。普通桌面部署优先使用安全配置脚本，避免 Secret 出现在进程环境中。

正式代码不保留外部 `chat-completions` 或每消息一次的临时 Codex 兼容分支，避免机器人退化为无上下文的模型调用器。

## 验证

```powershell
npm test
& .\scripts\verify-skill.ps1
```

验证覆盖事实编译、图表安全、访问控制、App Server 协议、capability token 边界、持久 Thread 恢复与隔离、`turn/steer`、受控工具循环、长连接消息处理、排重、流式回复、隐私日志、连接配置和一次性 USERID 识别。测试构造数据只验证确定性代码，不会进入生产 runner 或作为答复回退。

## 运行边界

- 官方 SDK 的 debug 日志被隐私 logger 禁用，不记录消息正文或企微帧。
- 仓库外状态日志只记录时间、连接状态和重试次数，不记录 USERID、消息正文、线程 ID、Secret 或业务事实。
- 明文事实包只存在于单次临时目录，成功或失败后删除。
- 五分钟业务缓存使用 Windows 当前用户 DPAPI 加密。
- 为实现持久上下文，用户问题和通过隐私/完整性校验的工具结果会进入该授权主体自己的本机 Codex Thread 历史；它们不进入项目仓库、状态 JSONL 或企微 SDK 日志，也不会跨 USERID/授权范围共享。明文 runner 文件仍会在 `finally` 删除。
- 未脱敏跟进原文、Bot Secret、模型 Key 和销帮帮凭证不进入 Codex Thread 或服务日志。
- 本机 Codex 使用 ChatGPT 登录，不单独配置模型 API Key；调用采用持久 Thread、只读无网络沙箱和环境变量白名单。
- 机器人只读，不发送 CRM 消息、不创建记录、不推进商机、不写回销帮帮。
- 一个 Bot ID 同时只运行一个正式长连接；新进程会使旧连接离线。
