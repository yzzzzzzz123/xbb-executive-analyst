# xbb-executive-analyst

面向国内版企业微信普通员工的通用 Codex Agent，以及按公司经营问题自动调用的真实只读销帮帮经营分析 Skill。

当前版本为 `1.3.0`。本版重点强化长上下文、自动恢复、回复速度和持续在线：静态规则使用分层混合 RAG；所有实时事实在进入模型前投影到严格 96 KiB 预算；持久 Thread 根据 token、累计输入与轮次主动换新；完整事实已就绪时，模型即使输出技术性拒答、无效结构或超时，也由确定性事实回答接管；企微断连与进程卡死分别由进程内连接看门狗和独立租约看门狗恢复。所有销帮帮经营答复都同时发送图片：有可比较事实时发送真实经营图，不适合成图、需要消歧或实时链路处于恢复状态时发送不新增经营数字的结论/状态卡。

正式经营入口唯一是 `skills/xbb-executive-analyst/SKILL.md`；可比较事实的销帮帮经营图由同轮依赖 `skills/xbb-executive-chart/SKILL.md` 判断、选型并生成严格规格，桥接层只在没有合格图表规格时生成受控结论/状态卡，通用 Turn 不生成经营图片。企业微信只是对话通道；同一个真实只读 runner 同时服务于 Codex 对话和企微智能客服。项目不提供 HTML、驾驶舱、工作台、固定报告、样例回退或 CRM 写操作。

## 架构

```text
国内版企业微信智能机器人
        ↕ 官方 WebSocket 长连接
shared/wecom → USERID 访问控制 → 能力路由
        ├─ 通用问题 → Codex 通用能力（只读；可联网）
        └─ 公司经营问题
             ↓ 同 Turn 注入 xbb-executive-analyst + xbb-executive-chart
          shared/rag（强制合同层 + 本地 TF-IDF/词法混合检索）
             ↓
          shared/xbb（受控 query_xbb 实时预取）
             ↓ 已校验完整事实 → 96 KiB 模型事实视图
          shared/codex（回环 App Server + 隔离 Thread + 预算轮换/事实恢复）
             ↓ 唯一业务动态工具 query_xbb
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

脚本随后只安全读取企业微信机器人 Secret。模型直接复用本机 Codex 的 ChatGPT 登录，不询问也不保存 OpenAI API Key 或模型接口地址；正式配置固定使用旗舰模型 `gpt-5.6-sol`。已由实时事实包确定的汇总、排名、数量、占比和成交率走 `none` 快速生成路径；商机质量、原因、风险、预测、异常诊断和建议走配置的 `medium` 深分析路径，保留完整能力。

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

群聊中先添加机器人，再通过 `@机器人名称` 提问。正确结果应先显示真实运行状态，随后由完整最终答复覆盖。已取得并校验事实时，模型结构错误、技术性拒答或生成超时由确定性事实答案接管；实时源仍不可用时明确进入自动恢复，不使用样例、旧结果或编造数字。

机器人后端是一个真正的通用 Codex Agent：桥接进程启动仅监听 `127.0.0.1` 的本机 App Server，并按“USERID + 当前授权范围”的不可逆摘要维护隔离 Thread；进程重启后只登记历史 Thread，相关用户第一次发消息时才以 `excludeTurns=true` 懒恢复，授权人数不会拖慢机器人上线。若状态标记显示重启前仍有未完成 Turn，则直接丢弃未知状态 Thread 并新建，绝不继续发布没有调用方或可能带旧事实的结果。普通问答、写作、解释、翻译、方案、代码等问题直接使用 Codex 通用能力，不会注入经营 RAG 或查询销帮帮。只有识别为公司经营、业绩、产品、课程、交付、商机，或已知销帮帮表单/字段的问题，才在同一个 Turn 显式附带 `xbb-executive-analyst` 与 `xbb-executive-chart`、检索相关原文规则并按需预取实时事实；纯表单、字段、口径和使用方式说明直接使用版本化 RAG，不做无意义的 CRM 取数。前者负责事实和经营结论，后者负责辅助图的数据充足性、选型、结构和最小规格，二者不是两个 Agent。短数字选择、继续、为什么、要求更真实/客观/直接等追问会继承经营路由。模型即使在通用轮次误请求 `query_xbb`，桥接层也会拒绝。启动关键路径只校验并缓存本地混合 RAG，不再逐授权用户做模型预热；空闲时使用 `turn/start`，活动 Turn 的同路由追问用 `turn/steer` 接管，跨路由消息自动排队。

静态规则检索由“必需合同层 + 本地词法/TF-IDF 稀疏向量余弦”融合完成，按快速计划的数据域与月份数锁定必须章节，严格限制为 14,000 UTF-8 字节，超大章节按 Unicode 安全切块。它不调用第二个模型、外部 embedding 服务或网络。Thread 监听 App Server 的 token usage；达到上下文窗口 70%、累计输入 256 KiB 或 24 个 Turn 前主动新建 Thread，并只携带最多两条脱敏的最近意图帮助理解短追问，旧经营数字不作为新事实。完整事实包仅在桥接内存中通过安全校验，模型与动态工具只接收不超过 96 KiB 的确定性视图；同参数重复工具请求只返回复用标记，不再重复注入事实。

全年、最近 12 个月等跨月问题由 bundled runner 按月取数，并在本机确定性汇总成单一管理事实包；模型不会接收或拼接多个月份的原始明细。聚合包保留汇总、占比、全部月份的核心趋势和至少前 10 的核心排名，极端控量时按覆盖元数据明示省略项且不做字符串截断。某实体在部分月份唯一确认、其他月份没有活动时，零活动月会作为零值进入趋势，不再把整段查询误判为实体不存在。并发的完全相同查询使用 single-flight 共用同一个 runner；不同范围默认串行，最多 32 个范围排队且排队窗口为 12 分钟，避免并发放大销帮帮限流。每个经营请求另有不滑动的 20 分钟总截止；模型生成的 5 分钟预算在工具取数期间暂停并在返回后重置。取消、超时或范围被追问替代时会回收整棵 Windows PowerShell/Node runner 进程树。API 对 408、429、5xx、网络中断和无效 JSON 做指数退避重试，runner 首次瞬时失败会利用已完成月份的加密缓存自动续跑。

企微等待状态不是笼统进度条：桥接层显示已识别的期间、实体范围和数据域，并根据 runner 的真实 JSONL 事件更新当前月份、已完成月份数、实时/五分钟加密缓存来源、跨月汇总和隐私/完整性校验；数据就绪后显示正在比较的经营维度，结论完成后显示实际图表类型及生成/上传阶段。状态不包含业务数字、事实明细、模型内部推理或虚构百分比。密集事件在企微发送层合并为最新状态，45 秒心跳保留当前具体阶段并追加已用时。

App Server 使用内存中的随机 capability token；命令行只有 token 的 SHA-256 校验值。模型始终运行在只读、永不申请批准的沙箱中；通用 Turn 可联网，经营 Turn 关闭网络。公司权限、能力路由和 `query_xbb` 执行仍由桥接服务层强制，明文事实包由工具网关在 `finally` 中清除。

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

安装脚本会建立主任务和 `-Watchdog` 外部看门狗任务。主任务在当前 Windows 用户登录时启动，使用 Windows 原生 `RestartOnFailure` 和每分钟恢复触发；企微连续 120 秒未重新认证时进程主动退出。服务初始化前先写入带随机代际 ID 的 `starting` 租约，运行时就绪后切换为 `running`，并每 30 秒原子刷新；独立看门狗每分钟联合校验任务归属、完整进程命令行、PID、代际、状态持续时间和租约新鲜度，过期或假活时只终止严格确认的旧实例并等待新代际 `running`。启动宽限不依赖会被 `IgnoreNew` 重复触发刷新的 `LastRunTime`。任务使用 `IgnoreNew`，进程内命名管道锁阻止第二实例抢占连接。安装升级会先备份双任务 XML，失败时恢复旧任务；若需长期停用，必须同时禁用或卸载两个计划任务。

查看：

```powershell
Get-ScheduledTask -TaskName 'Codex-XBB-Executive-Analyst-WeCom' |
  Select-Object TaskName,State

Get-ScheduledTask -TaskName 'Codex-XBB-Executive-Analyst-WeCom-Watchdog' |
  Select-Object TaskName,State
```

移除：

```powershell
& .\scripts\uninstall-wecom-task.ps1
```

任务以配置凭据的同一个 Windows 用户和有限权限直接运行仓库外生成的 `nodew.exe`。它是当前 `node.exe` 的逐字副本，只把 PE Subsystem 从 Console 改为 Windows GUI；安装脚本用源文件 SHA-256 跟踪 Node 升级并自动重建。计划任务固定传入仓库外安全配置绝对路径，并清除继承的全部 `XBB_*` 覆盖，避免升级或临时环境变量让租约、状态或凭据路径漂移。任务仍由 Node 本身作为根进程，因此桌面不出现可关闭的黑框，同时停止任务会连同 App Server 一起结束，不经过长期 PowerShell、WSH 或自定义启动器宿主。锁屏不影响已登录会话；电脑关机、睡眠、休眠、断网、注销或用户尚未登录时机器人会离线。要求跨注销和重启前持续在线时，应把同一部署迁移到常开 Windows 主机和经过 DPAPI/Codex 登录验证的专用服务账号；同一 Bot ID 不能双活。

## 环境变量部署

生产环境也可以提供一组完整进程环境变量：

- `XBB_WECOM_BOT_ID`
- `XBB_WECOM_BOT_SECRET`
- `XBB_WECOM_WS_URL`，国内版默认 `wss://openws.work.weixin.qq.com`
- `XBB_WECOM_MAX_RECONNECT_ATTEMPTS`，默认 `-1` 无限重连
- `XBB_WECOM_HEARTBEAT_MS`
- `XBB_WECOM_REQUEST_TIMEOUT_MS`
- `XBB_MODEL_PROVIDER`，正式运行时只能是 `codex-app-server`
- `XBB_AGENT_TURN_TIMEOUT_MS`，销帮帮经营 Turn 超时，默认 300000 毫秒
- `XBB_GENERAL_TURN_TIMEOUT_MS`，通用 Codex Turn 超时，默认 900000 毫秒；复杂证明、长文和代码任务不会再套用经营查询的 5 分钟限制
- `XBB_AGENT_STATE_PATH`，默认 `%LOCALAPPDATA%\Codex\xbb-executive-analyst\agent-state.json`
- `XBB_STATUS_LOG_PATH`，默认 `%LOCALAPPDATA%\Codex\xbb-executive-analyst\status.jsonl`，只记录固定连接/Agent 状态枚举和阶段耗时，不记录用户或业务内容
- `XBB_SERVICE_LEASE_PATH`，默认 `%LOCALAPPDATA%\Codex\xbb-executive-analyst\service-lease.json`，仅保存进程号、运行状态和最后心跳时间，供外部看门狗判断卡死
- `XBB_CODEX_COMMAND`，仅在无法自动定位 Codex CLI 时指定绝对可执行文件路径
- `XBB_CODEX_MODEL`，正式默认 `gpt-5.6-sol`
- `XBB_CODEX_REASONING_EFFORT`，正式默认 `medium`，作为复杂问题的深分析强度；已完成事实计算的简单问题固定走 `none`；配置仍支持 `none`、`minimal`、`low`、`high`、`xhigh` 或 `max`
- `XBB_ACCESS_POLICY_PATH`

只要 Bot ID 与 Secret 环境变量不完整，服务就读取 DPAPI 安全配置。普通桌面部署优先使用安全配置脚本，避免 Secret 出现在进程环境中。

正式代码不保留外部 `chat-completions` 或每消息一次的临时 Codex 兼容分支，避免机器人退化为无上下文的模型调用器。

## 验证

```powershell
npm test
& .\scripts\verify-skill.ps1
```

验证覆盖事实编译、单月/跨月大包压力、零活动月份、96 KiB 模型视图、混合 RAG 的强制规则/向量近邻/硬字节边界、访问控制、App Server token 预算轮换与懒恢复、技术性拒答接管、范围变化后的迟到查询隔离、受控工具循环、企微重连看门狗、代际租约、外部计划任务看门狗、安装回滚、排重缓存容量、未授权消息洪泛、群内 `@` 路由、流式回复、经营图/结论图/应急图三级降级、媒体与内联发送、隐私日志和一次性 USERID 识别。测试构造数据只验证确定性代码，不会进入生产 runner 或作为经营事实回退。

## 运行边界

- 官方 SDK 的 debug 日志被隐私 logger 禁用，不记录消息正文或企微帧。
- 仓库外状态日志只记录时间、连接状态和重试次数，不记录 USERID、消息正文、线程 ID、Secret 或业务事实。
- 明文事实包只存在于单次临时目录，成功或失败后删除。
- 五分钟业务缓存使用 Windows 当前用户 DPAPI 加密。
- 用户问题和经过预算投影的本轮事实视图会进入该授权主体自己的本机 Codex Thread；完整事实包不会进入 Thread。Thread 达到预算会主动轮换，旧经营数字不得作为当前事实；内容不进入项目仓库、状态 JSONL 或企微 SDK 日志，也不会跨 USERID/授权范围共享。明文 runner 文件仍会在 `finally` 删除。
- 未脱敏跟进原文、Bot Secret、模型 Key 和销帮帮凭证不进入 Codex Thread 或服务日志。
- 本机 Codex 使用 ChatGPT 登录，不单独配置模型 API Key；调用采用持久 Thread、环境变量白名单和逐轮只读沙箱。通用 Turn 可联网，经营 Turn 关闭网络并只从 `query_xbb` 获取业务事实。
- 机器人只读，不发送 CRM 消息、不创建记录、不推进商机、不写回销帮帮。
- 一个 Bot ID 同时只运行一个正式长连接；新进程会使旧连接离线。
