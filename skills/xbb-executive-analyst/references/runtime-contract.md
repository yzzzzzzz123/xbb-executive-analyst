# 运行、缓存与清理契约

在运行或修改取数、事实包、缓存、图表和验证脚本前阅读本文件。

## 唯一运行路径

- Skill：`xbb-executive-analyst`
- 唯一取数入口：`scripts/query-xbb.ps1`
- 凭据加载与实时导出：项目公共实现 `shared/xbb/export-live-data.ps1` → `shared/xbb/export-live-data.js`
- 确定性事实编译：项目公共实现 `shared/xbb/build-fact-pack.js`
- 按需图表：`scripts/render-chart.ps1` → 项目公共实现 `shared/xbb/render-chart.js`

不存在网页服务、HTML、驾驶舱、工作台、静态发布器、局域网代理或嵌套模型调用。企业微信服务中的本机 Codex App Server 是顶层分析 Agent；Codex 对话模式仍禁止启动第二个 Codex。

## Runner

```powershell
& .\scripts\query-xbb.ps1 `
  -Month 2026-09 `
  -Domains opportunities `
  -Person "销售姓名" `
  -OutputPath "$env:TEMP\xbb-facts.json"
```

- `Month` 可传一个或最多 12 个 `YYYY-MM`；省略时使用当前上海自然月。
- `Domains` 支持 `performance`、`product-sales`、`courses`、`delivery`、`opportunities` 和 `all`。
- `Company`、`Person` 为可选确定性过滤。多个相似候选返回 `needs_disambiguation`，不能自行选一个。
- `ForceRefresh` 仅在用户要求立即刷新或缓存验证时使用。
- 事实包可能很大，应写入 run-scoped 路径并在当前回答前删除，不要把完整 JSON 粘贴进答案。

## 五分钟加密缓存

- 缓存位于 `%LOCALAPPDATA%\Codex\xbb-executive-analyst\cache`。
- 来源包使用 Windows DPAPI CurrentUser 加密；磁盘缓存没有明文业务 JSON。
- 相同月份在五分钟内复用；五分钟后重新实时导出。缓存损坏、无法解密或 schema 变化时删除并重新取数。
- 每次调用清除超过 24 小时的遗留加密缓存。
- 解密后的来源包只存在于 `%TEMP%\Codex\xbb-executive-analyst\runs\run-*`，runner 的 `finally` 必须删除整个 run 目录。

## 事实包状态

- `ready`：可直接回答。
- `needs_disambiguation`：查看 `entityResolution` 中真实候选，只让用户选择，不输出其他分析。
- 命令失败：报告真实错误。不得使用旧页面快照、测试 fixture、样例或固定文案作为回退。

`provenance` 必须包含实时只读状态、来源刷新时点、来源记录哈希、表单 ID、记录量和隐私标志；`integrity.factPackSha256` 用于验证确定性输出。

## 图表

Codex 对话模式把最小图表规格写入 run-scoped JSON，然后执行：

```powershell
& .\scripts\render-chart.ps1 -SpecPath <absolute-spec-path>
```

生成器只输出自包含 SVG，不允许脚本、外链、远程字体或网络资源。最终 SVG 位于 `%TEMP%\Codex\xbb-executive-analyst\charts`，保留最多 24 小时；规格文件生成后立即删除。

企业微信 Agent 模式不得在模型沙箱中运行图表脚本。模型按结构化输出合同返回一张可选图表规范；桥接层使用同一确定性 SVG 渲染器并在内存中转成 PNG，以最终 `replyStream(..., finish=true, msg_item)` 图文消息发送。不得把 Base64、SVG、临时路径或图表规范正文发给用户或写入状态日志。

## 安全与失败

- API Token 只在 `shared/xbb/export-live-data.ps1` 调用的导出进程内存中存在，完成后恢复/清除环境变量。
- 来源包和事实包必须通过记录哈希与隐私扫描。电话、邮箱或常见凭据模式命中时失败关闭。
- XBB 限流、网络错误、字段缺失、哈希错误、实体不唯一、缓存错误或图表验证错误都不能触发假数据回退。
- 所有 XBB API 调用均为读取；不得向本 Skill 增加写接口。
- 企业微信桥接拥有唯一一个本机 Codex App Server 子进程，必须只监听动态分配的 `127.0.0.1` WebSocket 端口，使用内存中的随机 capability token 连接；进程参数只允许出现 token 的 SHA-256 校验值，原始 token 不得进入命令行、状态文件或日志。
- App Server 只继承启动和 ChatGPT 登录所需的环境变量白名单，不得继承企微 Secret、销帮帮凭证、模型 API Key 或其他业务 Secret。每轮使用只读沙箱、关闭网络并固定 `approvalPolicy=never`。
- 每个已授权 USERID 与授权范围组合只能映射到自己的不可逆 principal 摘要和持久 Thread；状态保存在仓库外。Thread 在进程重启后通过 `thread/resume` 恢复，合约变化或授权范围变化时必须新建；不同用户上下文不得合并。
- 持久 Thread 会在当前 Windows 用户的 Codex 本地历史中保存用户问题与已通过隐私/完整性校验的工具结果，这是提供连续上下文的必要数据；不得声称这些内容完全不落盘。仓库外 Agent 状态文件只保存 principal 摘要、Thread ID 和合约摘要，不保存问题或事实包。
- 企业微信问题通过 `turn/start` 进入空闲 Thread。同一用户已有问题仍在处理时，新消息不得通过 `turn/steer` 改写当前经营问题；应立即告知当前忙碌，并让原消息继续完成。桥接进程重启时发现未完成 Turn，应先中断再接收新问题，不能把无调用方的旧任务继续发布。
- App Server Thread 注册且只注册 `query_xbb` 这一项业务动态工具。Codex 不得用内置 shell、文件、网络、MCP 或 Skill 直接读取业务数据；授权与 bundled runner 调用必须留在桥接服务层。
- Codex 0.151.x 的 `dynamicTools` 协议要求客户端声明 `experimentalApi=true`；该声明只用于注册受控 `query_xbb`，不能借此增加其他业务工具、运行时工作区或未验收的实验能力。
- 工具网关最多接受四轮调用，逐次校验参数、USERID 授权范围、事实包实时只读来源、隐私标志与 SHA-256 完整性，并在 `finally` 删除明文事实包。
