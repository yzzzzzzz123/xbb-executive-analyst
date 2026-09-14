# xbb-executive-analyst

面向国内版企业微信普通员工的通用 Codex Agent，以及按公司经营问题自动调用的真实只读销帮帮经营分析 Skill。

当前版本为 `1.4.0`。本版在不改变销帮帮表单、字段映射和经营计算口径的前提下，继续强化长上下文、范围修正、取数隔离、自动恢复、回复速度和持续在线：静态规则使用分层混合 RAG；所有实时事实在进入模型前投影到严格 96 KiB 预算；持久 Thread 根据 token、累计输入与轮次主动换新；完整事实已就绪时，模型即使输出技术性拒答、无效结构或超时，也由确定性事实回答接管；企微断连、生命周期卡死、计划任务异常和 runner 孤儿分别由硬截止、租约看门狗、产品级 fencing 与可恢复隔离标记处理。两个及以上有效维度或宽泛经营问题需要分析图，明确单一对象与期间的标量问题可免图。主 Agent 保持 gpt-6-astra/xhigh，需要出图时原生委派 gpt-6-astra/ultra 的 xbb_chart；图内以可计算关系展示主发现、差异、集中度和必要口径，综合问题逐项覆盖不同子图。事实不足时说明具体缺口。

无论问什么都必须有可独立阅读的文字答复；需要出图时同时交付图片与文字，复杂问题逐项保留结论、关键数字、依据和限制。正式经营入口唯一是 `skills/xbb-executive-analyst/SKILL.md`；可比较事实的销帮帮经营图由同轮依赖 `skills/xbb-executive-chart/SKILL.md` 判断、选型并生成严格规格，桥接层将合格规格确定性渲染成 PNG，缺数或失败时保留文字并说明原因，通用 Turn 不生成经营图片。企业微信只是对话通道；同一个真实只读 runner 同时服务于 Codex 对话和企微智能客服。项目不提供 HTML、驾驶舱、工作台、固定报告、样例回退或 CRM 写操作。

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
          shared/xbb（受控 query_xbb 精确取数）
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

脚本随后只安全读取企业微信机器人 Secret。模型直接复用本机 Codex 的 ChatGPT 登录，不询问也不保存 OpenAI API Key 或模型接口地址；正式默认使用本机可用 GPT-6 型号 `gpt-6-astra`，主 Agent 采用 `xhigh` 推理强度，不按问题自动降低为 none；需要经营图时原生委派 `ultra` 子 Agent。模型上下文显式配置为 872,000 tokens，自动压缩阈值为 750,000；当前 Codex 实测有效窗口为 828,400 tokens。API 的 1,050,000 规格不能直接覆盖该客户端上限。明确单一对象、期间和指标的问题通常一至三句话直接答；宽泛或多维问题完整覆盖所问维度并分析出图，在同一精确范围内复核口径、比较和解释，禁止为增强分析而扩大取数。推理强度与输出长度分开，不因简单短答降低事实核对要求。

GPT-6 要求兼容的 Codex CLI；本机已用 `0.154.0` 完成实际调用验证。可通过安全配置 `codexCommand` 或 `XBB_CODEX_COMMAND` 指向机器人独立安装的绝对 `codex.exe`/`codex.js` 路径。配置的本机代理还须验证模型服务可达，端口在监听不代表 TLS 连接可用。

Secret 使用 Windows DPAPI CurrentUser 加密，保存到：

```text
%LOCALAPPDATA%\Codex\xbb-executive-analyst\bot-config.json
```

配置文件版本固定为本机 Codex App Server Agent 版 `4.0`。升级已有 3.0 配置，或早期 schema 4.0 配置缺少 `serviceLeasePath` 时，应先运行 `& .\scripts\migrate-app-server-config.ps1`（非默认配置传 `-Path`）；脚本只迁移非敏感字段并原样保留 DPAPI 密文，不要求再次输入 Secret。

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

允许所有能够访问当前机器人的用户使用集团只读经营分析：

```powershell
& .\scripts\configure-access-policy.ps1 -AllowAnyUser
```

该命令必须由部署者显式执行，会写入保留通配规则 `*`。每位用户仍按企微实际 USERID 使用独立 Codex Thread，不共享对话上下文；销帮帮仍然只读，不能写回 CRM。精确 USERID 规则优先于通配规则，因此仍可为个别用户配置更窄的公司范围。

策略默认位于：

```text
%LOCALAPPDATA%\Codex\xbb-executive-analyst\access-policy.json
```

默认情况下，未登记人员在模型或销帮帮查询发生前即被拒绝；显式启用 `-AllowAnyUser` 后，机器人可触达范围内的其他用户获得集团只读权限。公司级精确权限仍会在 runner 调用时二次强制。

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

机器人后端是一个真正的通用 Codex Agent：桥接进程启动仅监听 `127.0.0.1` 的本机 App Server，并按“USERID + 当前授权范围”的不可逆摘要维护隔离 Thread；进程重启后只登记历史 Thread，相关用户第一次发消息时才以 `excludeTurns=true` 懒恢复，授权人数不会拖慢机器人上线。若状态标记显示重启前仍有未完成 Turn，则直接丢弃未知状态 Thread 并新建，绝不继续发布没有调用方或可能带旧事实的结果。普通问答、写作、解释、翻译、方案、代码等问题直接使用 Codex 通用能力，不会注入经营 RAG 或查询销帮帮。只有识别为公司经营、业绩、产品、课程、交付、商机，或已知销帮帮表单/字段的问题，才在同一个 Turn 显式附带 `xbb-executive-analyst` 与 `xbb-executive-chart`、检索相关规则，先校验精确指标、期间和实体，再查询实时事实；纯表单、字段、口径和使用方式说明直接使用版本化 RAG，不做无意义的 CRM 取数。已登记的真实字段 ID 可以独立触发该路由，普通代码变量、SQL 或异常上下文不会被误判。前者指导主 Agent 获取事实并形成经营结论；后者指导按需委派的原生 ultra 子 Agent 逐维分析、选图并生成可校验规格，由主 Agent 复核后统一交付。短数字选择、继续、为什么、要求更真实/客观/直接等追问会继承经营路由；“不要看业绩只看商机”“排除课程仅看交付”等没有标点的明确排除也会切换数据域，规则说明或否定示例不会误触发。连续公司、人员或数据域修正会继承最新范围并立即撤销旧查询，旧范围事实不会进入新问题。这一路由记忆有固定容量，并在鉴权前建立，因此拒绝后的短追问仍按销帮帮问题处理，但不会绕过授权。模型即使在通用轮次误请求 `query_xbb`，桥接层也会拒绝。启动关键路径只校验并缓存本地混合 RAG，不再逐授权用户做模型预热；空闲时使用 `turn/start`，活动 Turn 的同路由追问用 `turn/steer` 接管，跨路由消息自动排队。

静态规则检索由“必需合同层 + 本地词法/TF-IDF 稀疏向量余弦”融合完成，按快速计划的数据域与月份数锁定必须章节，严格限制为 14,000 UTF-8 字节，超大章节按 Unicode 安全切块。它不调用第二个模型、外部 embedding 服务或网络。Thread 创建和恢复均显式传入上下文与压缩配置，并监听 App Server 的 token usage；预计下一轮达到实际有效窗口 90% 或配置压缩阈值的较小值时主动新建 Thread。存在有效 token 计量时不再被旧字节/轮次阈值提前切断；缺少有效计量时才以累计输入 256 KiB 或 24 个 Turn 作为保守回退。经营新轮次另外强制只继承意图，不复用旧经营事实上下文；并携带最多 6 KiB 的用户目标、关键约束与近期修正摘要帮助续接。摘要不是完整历史，不保存完整代码或工具事实，省略内容会明确标记；经营筛选阈值是用户意图，旧经营数字不作为新事实。完整事实包仅在桥接内存中通过安全校验，模型与动态工具只接收不超过 96 KiB 的确定性视图；同参数重复工具请求只返回复用标记，不再重复注入事实。

全年、最近 12 个月等跨月问题由 bundled runner 按月取数，并在本机确定性汇总成单一管理事实包；模型不会接收或拼接多个月份的原始明细。模型只接收用户所问的指标；请求趋势时保留全部月份，请求排名时保留至少前 10，极端控量时按覆盖元数据明示省略项且不做字符串截断。某实体在部分月份唯一确认、其他月份没有活动时，零活动月会作为零值进入趋势，不再把整段查询误判为实体不存在。并发的完全相同查询使用 single-flight 共用同一个 runner；不同范围默认串行，最多 32 个范围排队且排队窗口为 16 分钟，避免并发放大销帮帮限流。每个经营请求另有不滑动的 20 分钟总截止；主模型生成的5分钟预算在取数和原生图表子 Agent 分析期间暂停，完成后重置；两者均受20分钟不可滑动总截止约束。生产网关通过严格 stdin JSON 向根与固定子进程传递月份、公司、人员、数据域和指标，业务范围不出现在进程命令行。每次取数在进程启动前写入 v2 隔离标记，只记录随机 token、规范化脚本/临时目录与根进程身份，不记录查询实体、经营事实或凭据；正常结束先在内存校验事实包，再删除本次 runner 与网关临时目录。启动恢复、取消、超时或范围被追问替代时均用 `CommandLineToArgvW` 严格解析 token 与固定入口，并按 PID、创建时间和可执行文件为每个候选持有原生进程句柄；根进程先停，迟到子进程经重复快照逐一持柄回收，连续两次健康 CIM 快照确认无残留后才清理标记。若 10 秒内无法确认整树回收或身份不确定，查询网关立即失败关闭并让主进程退出，由计划任务和外部看门狗以新代际恢复，绝不在未知孤儿进程旁启动第二个 runner。API 对 408、429、5xx、网络中断和无效 JSON 做指数退避重试，runner 首次瞬时失败会利用已完成月份的加密缓存自动续跑。

企微等待状态不是笼统进度条：桥接层显示已识别的期间、实体范围和数据域，并根据 runner 的真实 JSONL 事件更新当前月份、已完成月份数、实时/五分钟加密缓存来源、跨月汇总和隐私/完整性校验；数据就绪后显示正在比较的经营维度，结论完成后显示实际图表类型及生成/上传阶段。状态不包含业务数字、事实明细、模型内部推理或虚构百分比。密集事件在企微发送层合并为最新状态，45 秒心跳保留当前具体阶段并追加已用时。

模型服务重连时会显示真实的自动重试状态，恢复生成后更新状态；登录失效、网络连接失败、额度受限等终态会明确结束等待并说明原因。日志只保留白名单 `modelErrorCode`，不记录上游错误原文。App Server 沿用 Windows 部署环境的 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`、`NO_PROXY`（兼容小写）网络设置，仍不继承机器人 Secret 或独立模型 API Key。若提示登录失效，请用运行后台任务的同一 Windows 用户执行 `codex login` 完成浏览器登录，再重启机器人任务；`codex login status` 只能确认本地存在登录记录，不能代替一次真实通用问答的连通性验证。

切换本机代理软件后，若旧端口已停止监听，可在仓库外 `bot-config.json` 中设置可选字段 `codexProxyUrl`，指向实际可用的本机 HTTP/HTTPS 代理，再运行 `scripts/install-wecom-task.ps1` 受控重载。该字段只覆盖模型子进程的大小写代理变量，不修改系统代理或企微连接；地址不得包含凭据、路径、查询参数。未配置时继续继承部署环境。非托管前台启动也可使用 `XBB_CODEX_PROXY_URL`；正式计划任务从其 `--managed-config` 指定的文件读取，避免继承旧环境。配置后需用真实通用问答验证模型链路，企微 `ready` 与新鲜租约只证明通道和进程状态。

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

安装脚本会建立主任务和 `-Watchdog` 外部看门狗任务。主任务只在当前 Windows 用户登录时启动，并使用 Windows 原生 `RestartOnFailure` 在进程异常退出后按一分钟间隔重试 3 次，不再用每分钟重复触发制造无效启动请求；企微连续 120 秒未重新认证时进程主动退出，服务启动超过 90 秒、fatal/信号清理或 App Server 终止超过各自 10 秒硬截止时也确定性退出。服务初始化前先写入带随机代际 ID 的 `starting` 租约，运行时就绪后切换为 `running`，并每 30 秒原子刷新；独立看门狗每 5 分钟联合校验任务归属、完整进程命令行、PID、创建时间、代际、状态持续时间和租约新鲜度，仅当租约连续过期 180 秒或形成严格确认的假活时重启主任务，企业微信短暂断连由进程内重连处理，不触发进程重启。所有可能指向本产品配置的主任务变体共用产品级全局维护锁并在安装、卸载、巡检时统一扫描；ScheduledTasks 与 Task Scheduler COM 必须给出一致任务快照，进程快照必须包含维护进程自身，空结果还要跨两轮确认。终止时先恢复活跃 runner，再为主进程及白名单 App Server 后代逐一持有并核验原生句柄，根进程停止后重复扫描迟到后代；连续两次健康空快照后才允许拉起，避免更名任务、PID 复用或短暂查询失败造成误杀/双实例。租约丢失或损坏时，只有唯一进程与当前任务动作完全一致才自动自愈，其他代际继续围栏。启动宽限不依赖计划任务 `LastRunTime`。任务使用 `IgnoreNew`，进程内命名管道锁阻止第二实例抢占连接；升级、回滚和卸载会同时恢复、校验旧版与新版租约目录中的 runner 隔离标记。安装升级会先备份双任务 XML，失败时恢复旧任务定义与启用状态；任务入口仍指向同一个工作区，因此这不是代码版本回滚，代码回退应使用升级前已推送的 Git 基线。若需长期停用，必须同时禁用或卸载两个计划任务。

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

任务以配置凭据的同一个 Windows 用户和有限权限直接运行仓库外生成的 `nodew.exe`。它从当前 `node.exe` 逐字复制后，仅把 PE Subsystem 从 Console 改为 Windows GUI；安装脚本用源文件 SHA-256 跟踪 Node 升级并自动重建。主任务固定传入仓库外安全配置绝对路径，并清除继承的全部 `XBB_*` 覆盖，避免升级或临时环境变量让租约、状态或凭据路径漂移。主任务仍由 Node 本身作为任务根进程，停止任务会连同 App Server 一起结束，不经过长期 PowerShell、WSH 或自定义宿主。外部看门狗也由 `nodew.exe` 启动一个短生命周期 Node 入口，再用 `windowsHide`、禁用 shell 和隔离标准流的方式执行维护 PowerShell；Task Scheduler 不再直接创建控制台型 `powershell.exe`，因此周期巡检不会在桌面闪出黑框。锁屏不影响已登录会话；电脑关机、睡眠、休眠、断网、注销或用户尚未登录时机器人会离线。要求跨注销和重启前持续在线时，应把同一部署迁移到常开 Windows 主机和经过 DPAPI/Codex 登录验证的专用服务账号；同一 Bot ID 不能双活。

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
- `XBB_SERVICE_LEASE_PATH`，默认 `%LOCALAPPDATA%\Codex\xbb-executive-analyst\service-lease.json`，仅保存固定 schema、服务名、进程号、随机代际 ID、运行状态、状态开始时间和最后心跳时间，供外部看门狗核验进程身份、启动代际与卡死状态；不保存用户、凭据或经营数据
- `XBB_CODEX_COMMAND`，仅在无法自动定位 Codex CLI 时指定绝对可执行文件路径
- `XBB_CODEX_MODEL`，正式默认 `gpt-6-astra`
- `XBB_CODEX_REASONING_EFFORT`，正式默认 `xhigh`，统一用于普通与经营轮次；须使用当前模型实际支持的推理强度
- `XBB_CODEX_CONTEXT_WINDOW`，默认 `872000`；当前已验证客户端上限为 872K，实际有效窗口以 token usage 为准
- `XBB_CODEX_AUTO_COMPACT_TOKEN_LIMIT`，默认 `750000`；必须小于配置窗口的 90%，调整为较小窗口时需同时降低压缩阈值
- `XBB_ACCESS_POLICY_PATH`

只要 Bot ID 与 Secret 环境变量不完整，服务就读取 DPAPI 安全配置。普通桌面部署优先使用安全配置脚本，避免 Secret 出现在进程环境中。

正式代码不保留外部 `chat-completions` 或每消息一次的临时 Codex 兼容分支，避免机器人退化为无上下文的模型调用器。

## 验证

```powershell
npm run verify:production
npm run bench:production
npm run bench:reliability
npm run observe:runtime -- --samples=6 --interval-ms=60000
```

统一验收分为 unit、integration、windows 三组；`npm test` 保留全部套件，`npm run verify` 仅做语法与 Skill 合同检查，不再重复执行测试。依赖边界、真实只读探针、复杂任务切分和空闲重载方法见[生产验收与运行手册](docs/production-readiness.md)。

新接受请求共用从接收开始的单调截止预算，排队、模型和图片交付不能逐阶段重新计时；`sessionQueueMs` 与查询排队分别记录。数据库通用任务使用进程内有界检查点管理材料指纹、版本失效、阶段依赖和待验证项，模型上报完成不等于实际执行。SQLite 演练仅使用隔离临时库，正式机器人仍只读。

固定版本的真实模型小样本基线可显式运行 `npm run bench:production -- --live --workload --repeat=4`；首个通用 Thread 不做经营预热，完整报告保留失败和超时。`bench:reliability` 只验证离线替身与真实组件组合行为，禁止把其 P95 当作线上响应速率。`observe:runtime` 只读采样本机租约和认证状态，不发送消息，也不代表长期在线率。

通用长回答支持安全正文预览：仅接受明确的 final-answer 项目，按完整段落脱敏输出，默认每秒合并一次、每请求最多 12 次；预览不进重放缓存，追问或取消使旧归属失效，失败不会冒充完整答复。经营结果仍等事实与最终结构校验完成后发布。运行 `npm run bench:production -- --live --workload --repeat=1 --preview --business` 可记录应用内首段时间与完整答复时间；它不发送企微消息，不代表手机首字或平台送达。

经营图的关键发现使用结构化 `finding` 引用图内主体与基准，程序复算差值、变化、构成、留存或流失，并高亮所选主体。模型自由文案不能直接成为图中数字断言；旧规格仅显示标注的兼容概述，无效证据则降级。该合同证明图内算术一致，不等于已经实现完整事实源绑定或证明因果关系，详见[图表合同](skills/xbb-executive-chart/references/chart-contract.md)。

验证覆盖事实编译、单月/跨月大包压力、零活动月份、96 KiB 模型视图、混合 RAG 的强制规则/向量近邻/硬字节边界、独立字段 ID 路由、无标点域排除、访问控制、App Server token 预算轮换与懒恢复、慢预取即时接管、技术性拒答接管、范围变化后的迟到查询隔离、runner v2 标记/身份/双空快照/临时目录回收与失败关闭、受控工具循环、企微重连看门狗、启动和退出硬截止、代际租约、产品级计划任务 fencing、旧新版标记恢复、孤儿卸载保护、安装回滚、排重缓存容量、未授权消息洪泛、群内 `@` 路由、流式回复、纯图表与复合图、无图和渲染失败时仅保留文字、媒体与内联发送、隐私日志和一次性 USERID 识别。测试构造数据只验证确定性代码，不会进入生产 runner 或作为经营事实回退。

## 运行边界

- 官方 SDK 的 debug 日志被隐私 logger 禁用，不记录消息正文或企微帧。
- 仓库外状态日志只记录时间、白名单状态、重试次数与分段耗时；单请求使用随机观测标识，不记录 USERID、消息正文、线程 ID、Secret 或业务事实。
- 明文事实包只存在于单次临时目录；事实校验成功后或失败恢复时按 v2 隔离标记清除，清理身份或结果不确定时保留标记并失败关闭，绝不静默放行第二个 runner。
- 五分钟业务缓存使用 Windows 当前用户 DPAPI 加密。
- 用户问题和经过预算投影的本轮事实视图会进入该授权主体自己的本机 Codex Thread；完整事实包不会进入 Thread。Thread 达到预算会主动轮换，旧经营数字不得作为当前事实；内容不进入项目仓库、状态 JSONL 或企微 SDK 日志，也不会跨 USERID/授权范围共享。明文 runner 文件在校验后清理；若进程身份或清理结果无法确认，则保留最小隔离标记并失败关闭，等待受控恢复。
- 未脱敏跟进原文、Bot Secret、模型 Key 和销帮帮凭证不进入 Codex Thread 或服务日志。
- 本机 Codex 使用 ChatGPT 登录，不单独配置模型 API Key；调用采用持久 Thread、环境变量白名单和逐轮只读沙箱。通用 Turn 可联网，经营 Turn 关闭网络并只从 `query_xbb` 获取业务事实。
- 机器人只读，不发送 CRM 消息、不创建记录、不推进商机、不写回销帮帮。
- 一个 Bot ID 同时只运行一个正式长连接；新进程会使旧连接离线。

图表按问题生成：同时问两件事就出综合图，宽泛的“今天业绩怎么样”也会分析出图；明确某公司某日单一业绩金额可以免图。最多一张PNG包含2—8个不同面板，逐项覆盖有效问题，每区显示经过计算的发现、证据注释、精确读数与口径。趋势、其次公司表现、图表呈现和综合一点等追问保留原问题仍有效的意图。

需要图时主 Agent 在取得本轮事实后原生委派 `xbb_chart`，模型 `gpt-6-astra`、强度 `ultra`，不继承旧事实也不另行查询。主 Agent 仍为 `xhigh`，等待子 Agent 分析并复核后答复；桥接层核对原生子线程所属主线程、模型、推理配置、完成状态及当前事实/追问版本，不能靠模型自称已委派。取消或改范围会中断旧图任务。子 Agent 分析期间暂停主模型生成预算，端到端20分钟截止保持有效。

出图前使用 `validate_xbb_chart` 校验整张综合图并返回390px手机PNG预览，错误会明确返回给Agent修正；子Agent未暴露该工具时由主Agent完成。校验成功后只返回绑定当前事实与追问版本的图引用，最终按引用发布原规格，防止模型抄写第二遍时改错单位或数字。该工具不读取新业务数据，也不向企业微信发消息。

单日业绩查询使用 `date: YYYY-MM-DD` 和该日所属月份，覆盖上海当日零点至刷新时点；总额和排名使用同一日期，不能将MTD当作今日。当前单日接口限业绩域，不能确认的范围明确说明。离线视觉验收运行 `node scripts/preview-chart-analysis.js`，原生调用验收运行 `node scripts/smoke-chart-agent.js`，实际三维问题运行 `node scripts/smoke-codex-app-server.js --business --multidimensional --skip-warm`，宽泛今日问题运行 `node scripts/smoke-codex-app-server.js --business --daily --skip-warm`；附加 `--save-chart` 可保留本地真实PNG供目视检查，都不向企业微信发消息。

长上下文可单独执行 `node scripts/smoke-context-window.js` 验证：仅向真实 GPT-6 发送内存中的合成非业务材料，要求实际输入超过旧 272K 窗口并验证首段、中段、尾段标记及计算结果；不查询 CRM、不发送企微消息，使用临时 Thread。该测试会消耗模型额度，不属于默认离线测试。
