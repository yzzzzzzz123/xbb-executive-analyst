# 运行、缓存与清理契约

在运行或修改取数、事实包、缓存、图表和验证脚本前阅读本文件。

## 唯一运行路径

- Skill：`xbb-executive-analyst`
- 唯一取数入口：`scripts/query-xbb.ps1`
- 凭据加载与实时导出：项目公共实现 `shared/xbb/export-live-data.ps1` → `shared/xbb/export-live-data.js`
- 确定性事实编译：项目公共实现 `shared/xbb/build-fact-pack.js`
- 按需图表：`scripts/render-chart.ps1` → 项目公共实现 `shared/xbb/render-chart.js`
- 企业微信图表预检：`validate_xbb_chart` 只校验已有规格、计算关系并返回手机PNG预览，不取新事实；对本轮主 Agent 及绑定的当前ultra子 Agent 开放，最多8次有界校验。成功引用仅在当前主体、事实版本和追问版本有效，最终直接解析为已验证规格，避免模型重复抄写出错。

不存在网页服务、HTML、驾驶舱、工作台、静态发布器或局域网代理。本机 Codex App Server 承载主 Agent（gpt-6-astra/xhigh）；需要经营图时由主 Agent 原生委派 xbb_chart（gpt-6-astra/ultra，fork_turns=none），仅使用本轮已授权事实。两种模式均不另起 codex exec 或外部模型 API。

## Runner

```powershell
& .\scripts\query-xbb.ps1 `
  -Month 2026-09 `
  -Domains opportunities `
  -Metrics opportunities.count `
  -Person "销售姓名" `
  -OutputPath "$env:TEMP\xbb-facts.json"
```

- `Month` 可传一个或最多 120 个 `YYYY-MM`；省略时使用当前上海自然月。
- `Date` 可选，上海 `YYYY-MM-DD`，仅限业绩域，且 `Month` 必须只有该日所属月。今天、昨日或明确单日查询必须传入，不允许改查月累计。源端与详情同时校验日期；日期参与缓存摘要、网关参数及事实包范围绑定。
- `Domains` 支持 `performance`、`product-sales`、`courses`、`delivery`、`opportunities` 和 `all`。
- 正式动态工具必须指定 `metrics`，与 domains 完全对应。`Company`、`Person` 在源端加过滤条件；仅依靠必要元数据识别实体，无法唯一识别就停止，不读取集团业务记录。
- `ForceRefresh` 仅在用户要求立即刷新或缓存验证时使用。
- 单月事实包可能很大，应写入 run-scoped 路径并在当前回答前删除，不要把完整 JSON 粘贴进答案。企业微信桥接会在完整性与隐私校验后生成严格不超过 96 KiB 的 `xbb-live-readonly-model-fact-view`，只保留所请求指标及必要覆盖量；完整单月包不进入 Thread。2 至 120 个月的 runner 输出不是单月包拼接，而是 `xbb-live-readonly-multi-period-aggregate`：完整管理汇总与月度趋势在本机确定性生成。
- 企业微信工具网关可为 runner 传入 run-scoped `ProgressPath`。runner 只写 JSONL 阶段事件，包括启动、当前月份、来源就绪、月份事实完成、跨月聚合和输出就绪；事件不得包含公司/人员、业务数字、事实内容、路径、凭证或用户标识。工具网关轮询并校验事件后才映射为企微进度，结束时随单次请求目录一并清理。

## 五分钟加密缓存

- 缓存位于 `%LOCALAPPDATA%\Codex\xbb-executive-analyst\cache`。
- 来源包使用 Windows DPAPI CurrentUser 加密；磁盘缓存没有明文业务 JSON。
- 缓存键包含 source-v7、租户、月份/单日日期以及数据域/指标/公司/人员的摘要；只有完全相同范围在五分钟内复用，五分钟后重新实时导出。缓存损坏、无法解密或 schema 变化时删除并重新取数。
- 每次调用清除超过 24 小时的遗留加密缓存。
- 解密后的来源包只存在于 `%TEMP%\Codex\xbb-executive-analyst\runs\run-*`，runner 的 `finally` 必须删除整个 run 目录。

## 事实包状态

- `ready`：可直接回答。
- `needs_disambiguation`：查看 `entityResolution` 中真实候选，只让用户选择，不输出其他分析。
- 命令异常：先对只读网络/429/5xx/无效 JSON 做有界退避，对 runner 瞬时失败利用已完成月份缓存自动再执行；仍异常时报告恢复状态。不得使用旧页面快照、测试 fixture、样例或固定经营数字作为回退。

单月 `provenance` 必须包含实时只读状态、来源刷新时点、来源记录哈希、表单 ID、记录量和隐私标志；跨月包可把逐月哈希和逐月记录量压缩为月份刷新边界与总记录量。两种包都用 `integrity.factPackSha256` 验证确定性输出。

## 图片与图表

图表判断和最小规格由 `skills/xbb-executive-chart/SKILL.md` 负责；判别 Schema、严格验证和规范化实现由该 Skill 的 `scripts/chart-contract.js` 单一维护，公共响应合同与渲染器不得复制另一套字段规则。Codex 对话模式把通过合同的规格写入 run-scoped JSON，然后执行：

```powershell
& .\scripts\render-chart.ps1 -SpecPath <absolute-spec-path>
```

生成器只接受受控字段并输出自包含 SVG，不允许模型提供颜色、样式、脚本、外链、远程字体或网络资源。最终 SVG 位于 `%TEMP%\Codex\xbb-executive-analyst\charts`，保留最多 24 小时；规格文件生成后立即删除。

企业微信 Agent 模式不得在模型沙箱中运行图表脚本。模型按结构化输出合同返回一张可选经营图规范；桥接层使用同一确定性 SVG 渲染器并在内存中转成 PNG。`chart` 可为单图或含2—8个不同子图的 composite；图片展示图形、精确读数与通过 findings 验证的主发现和证据注释。`chart: null` 或图表渲染失败时只保留文字，不生成结论速览、状态卡或占位 PNG。桥接层对渲染、上传和主动图片发送做有界重试，优先通过官方 `uploadMedia` 与 `sendMediaMessage` 发送独立图片，失败时以最终 `replyStream(..., finish=true, msg_item)` 回退。不得把 Base64、SVG、临时路径或图表规范正文作为文字发给用户或写入状态日志。

## 安全与失败

- API Token 只在 `shared/xbb/export-live-data.ps1` 调用的导出进程内存中存在，完成后恢复/清除环境变量。
- 来源包和事实包必须通过记录哈希与字段级隐私扫描。扫描只检查可能进入模型的字符串事实；哈希、已哈希证据引用、数字金额、时间戳和不透明 ID 不得被手机号规则误报。普通名称、摘要或其他语义文本命中电话、邮箱或常见凭据模式时仍必须失败关闭。
- XBB 限流、网络错误、字段缺失、哈希错误、实体不唯一、缓存错误或图表验证错误都不能触发假数据回退。完全相同的并发查询必须通过 single-flight 共用一个 runner；不同范围默认只允许一个 runner 执行，并使用最多 32 项、默认 16 分钟的有界 FIFO 排队，避免并发放大限流。订阅者取消后必须立即退出排队。Windows 每次启动 runner 前必须原子写入 v2 隔离标记：仅含随机 token、时间、规范化旧项目根、固定 query/子脚本、run root、gateway work directory 与根进程身份，禁止写入月份、公司、人员、事实或凭据；生产根进程和固定 Node 子进程必须通过严格 stdin schema 接收业务范围，命令行只保留固定入口、token 与无业务含义的临时路径。query 根进程必须回绑 PID、创建时间、绝对可执行文件及完整参数，token 必须严格传给固定子进程。启动恢复、最后一个订阅者取消、请求绝对截止或范围被追问替代时，必须以标记中的旧项目根和 token 探测进程，用 `CommandLineToArgvW` 核对实际入口和唯一 flag/value，并为每个实际终止候选持有已核验 PID、创建时间与可执行文件的原生句柄；先停根进程，再重复快照并逐一持柄回收迟到子进程，防止 PID 复用、动态树误杀和错误脚本伪匹配。连续两次健康、带恢复进程 sentinel 的 CIM 快照都确认零候选后，才可删除 token 对应的 run/gateway 临时目录及标记。正常完成先只确认进程树安全，读取并在内存校验事实包后再做完整清理。空或不可读快照、错误脚本携带 token、身份不确定、清理失败，或整树终止未在 10 秒硬截止内确认，都必须保留恢复证据、使查询网关失败关闭、拒绝队列和后续 runner，并通知服务生命周期退出后由计划任务重启，不能把未确认终止当作普通取消。
- 所有 XBB API 调用均为读取；不得向本 Skill 增加写接口。
- 企业微信桥接拥有唯一一个本机 Codex App Server 子进程，必须只监听动态分配的 `127.0.0.1` WebSocket 端口，使用内存中的随机 capability token 连接；进程参数只允许出现 token 的 SHA-256 校验值，原始 token 不得进入命令行、状态文件或日志。
- App Server 只继承启动和 ChatGPT 登录所需的环境变量白名单，不得继承企微 Secret、销帮帮凭证、模型 API Key 或其他业务 Secret。每轮固定 `approvalPolicy=never` 并使用只读沙箱；通用 Turn 可启用网络以支持正常知识检索，经营 Turn 必须关闭网络，且经营事实只能来自受控 `query_xbb`。
- 每个已授权 USERID 与授权范围组合只能映射到自己的不可逆 principal 摘要和隔离 Thread；状态保存在仓库外。进程启动只登记历史 Thread，对应用户首条消息才以 `excludeTurns=true` 懒恢复；合约变化或授权范围变化时必须新建，不同用户上下文不得合并。
- 桥接创建和恢复 Thread 时均显式传入 `model_context_window=872000` 与 `model_auto_compact_token_limit=750000`，模型上下文、原生子 Agent 默认模型/ultra强度及专职角色文件均参与合同哈希。当前部署实测有效窗口为 828,400 tokens，必须监听 `thread/tokenUsage/updated` 并以实际回报为准。预计下一轮达到实际窗口 90% 或压缩阈值的较小值时，在用户 Turn 前换新 Thread；已有可靠 token 计量时不再额外套用旧字节/轮次阈值。缺少有效计量时才回退到累计输入 256 KiB 或 24 轮。经营新问题仍强制只继承意图，不携带旧事实；服务重启后首个携带事实的大经营问题也换新。轮换只可携带有界最近意图帮助理解指代，旧经营数字必须重新查询。
- Codex 本地历史保存用户问题与经过预算投影的模型事实视图，不保存完整事实包。不得声称这些内容完全不落盘。仓库外 Agent 状态只保存 principal 摘要、Thread ID、合约摘要和上下文预算计数，不保存问题、答案或经营事实。
- 企业微信问题通过 `turn/start` 进入空闲 Thread。同一用户已有问题仍在处理且新消息能力路由一致时，桥接层必须通过 `turn/steer` 和匹配的 `expectedTurnId` 把它追加为当前 Turn 的用户追问/修正；桥接层在 steer 请求确认期间暂存可能同时到达的 `turn/completed`，避免最新消息错过最终答复。若实时预取仍在进行且尚未启动 Turn，改变查询范围的新消息必须立即撤销旧订阅并接管最新答复所有权，不等待旧 runner；短句修正可携带有界且不含旧经营事实的原问题语义用于消歧，但旧月份、旧公司或旧域事实不得进入模型。成功后旧消息只收到交接说明，最新消息成为唯一最终答复接收者；多次追问继续向最新消息移交。能力路由不同的消息等待当前 Turn 完成后自动以新 Turn 处理，因为 `turn/steer` 不能改变本轮 Skill、沙箱或输出 Schema。桥接进程重启时若持久标记显示旧 Turn 未完成，必须直接作废该 Thread 并新建，不依赖恢复结果继续无调用方的旧任务。
- App Server Thread 只注册 `query_xbb`。生产经营轮次不自动预取；模型先提交明确指标与实体，桥接层根据当前用户意图校验月份、域和指标，然后源端按日期、公司、人员和关联 ID 查询。数量问题不附带质量记录，门票不附带业绩订单。上游列表接口若返回完整记录，不猜造字段选择参数；在导出边界立即按指标白名单裁剪，不写入或注入未问字段。无可靠过滤能力时说明限制，不静默扩大范围。模型不得用 shell、文件、网络或其他 Skill 直接获取业务数据。
- 已验证 Codex 0.154.0 的 `dynamicTools` 协议要求客户端声明 `experimentalApi=true`；该声明只用于注册受控 `query_xbb`，不能借此增加其他业务工具、运行时工作区或未验收的实验能力。
- 工具网关最多接受四轮调用，逐次校验参数、USERID 授权范围、事实包实时只读来源、隐私标志与 SHA-256 完整性，并在 `finally` 删除明文事实包。
- 进度回调失败不得中断真实 runner，也不得写入状态日志；事实包读取完成后必须额外产生“隐私与完整性校验中”和“数据已就绪”两个真实阶段。缓存命中导致事件密集时，企微层只保留尚未发送的最新阶段。
- 当前 Turn 已按相同月份、数据域、指标、公司、人员和刷新参数完成查询时，动态 `query_xbb` 只返回小型复用标记；不得重复运行或再次注入同一事实视图。动态补查也必须先投影到剩余事实预算，本轮全部事实视图累计不得超过 128 KiB。新动态查询的范围与当前可恢复事实不同时，必须在查询开始前撤销旧事实恢复资格；查询期间收到改变范围的 `turn/steer` 后，旧查询即使迟到完成也只能返回无事实的 `superseded` 标记，不能把旧月份、旧公司或旧数据域注入最新问题。年度范围在查询前展开；后续期间修正覆盖旧期间，不能把原问题与修正中的月份求并集。
- Codex Turn 的模型生成超时不得累计 bundled runner 的实时取数耗时。动态工具开始时暂停 5 分钟经营生成计时，取数完成后重新获得完整生成窗口；runner 按月份数量获得 5—15 分钟的有界执行窗口。同时每个经营请求从进入 active 起受不滑动的 20 分钟端到端绝对截止约束，通用请求默认 15 分钟；绝对截止覆盖预取、排队、动态工具和模型生成，并主动撤销真实查询订阅。
- 当事实视图为 `ready` 时，桥接层必须拦截“上下文/大小限制所以不能分析”“请拆主题或重发”等技术性拒答。模型结构无效、生成超时或上述拒答时，直接从同一已校验视图生成最小管理答案并丢弃失效 Thread；不能要求用户重新查询已取得的事实。

## LangGraph 与 LangChain 运行合同

- 主 Agent + `xbb_chart` 按多 Agent 项目采用 LangGraph；`agent-graph.js` 的主图等待原生 Turn 并检查交付，完成子图负责解析、条件性子 Agent 完成校验和版本复核。
- LangChain 的 BaseRetriever、PromptTemplate、DynamicStructuredTool 与 BaseOutputParser 分别承接静态规则、变量提示、精确查询和文字/图合同。它们位于真实生产调用路径，不另建模型 API。
- 原生持久 Thread 继续独占历史、steer 和委派。请求进入框架前同步登记接管，不能延迟最新范围更正。LangGraph 不启用业务 checkpoint；环境即使误开云追踪，也必须由隔离执行入口禁止上传经营内容。
