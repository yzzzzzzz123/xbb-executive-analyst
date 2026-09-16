# 项目边界

- 无论用户问什么都必须有可独立阅读的文字答复；图片只作补充，复杂问题的文字须逐项保留结论、关键数字、依据及限制，不得只贴图或只说见图。正式经营入口唯一是 `skills/xbb-executive-analyst/SKILL.md`；`skills/xbb-executive-chart/SKILL.md` 是它的经营图依赖，不得独立取数、路由或回答经营问题。两个及以上有效分析维度必须出综合图，宽泛经营问题也要出图；明确单一对象、期间、指标的标量问题可只给文字。图中展示真实图形及可验证的发现、差异和口径；数据不足时说明具体缺口，不生成占位图。
- 销帮帮事实只能由 `skills/xbb-executive-analyst/scripts/query-xbb.ps1` 读取；服务层不得直接访问凭证或 OpenAPI。
- `shared/xbb` 只负责确定性取数、编译与图表渲染；`shared/codex` 负责回环 App Server、持久 Thread 与动态工具循环；`shared/wecom` 负责企业微信协议；`shared/security` 负责授权与隐私校验。
- 生产运行只允许真实只读数据。禁止样例回退、固定结论、伪造 AI 分析、CRM 写操作、HTML、驾驶舱和工作台。
- 明文事实包是单次运行临时文件，必须在成功或失败后删除。运行密钥、访问策略、日志与状态不得写入仓库。
- 企业微信用户必须先通过访问策略授权，再进入模型或销帮帮查询；访问策略可以逐 USERID 授权，也可以由部署者显式启用保留键 `*`，让机器人可触达范围内的任意用户获得集团只读权限。未显式启用通配规则时继续默认拒绝；公司级用户只能查询明确授权的公司。
- 国内版企业微信正式接入使用普通员工可在客户端创建的智能机器人 WebSocket 长连接，只读取 Bot ID 与 DPAPI 保护的 Secret；不得要求公网回调、管理员自建应用、Token 或 EncodingAESKey。
- 主 Agent 保持 `gpt-6-astra/xhigh`；经营出图时通过原生子 Agent `xbb_chart`（`.codex/agents/xbb-chart.toml`）按需委派 `gpt-6-astra/ultra` 分析与图表设计，主 Agent 复核后统一答复。子 Agent 只处理本轮已授权事实，不自行查询、不继承旧事实、不再委派。用户已明确授权该工作流；不使用 Git worktree。只有经营 Turn 注入两个 Skill、经营 RAG 并允许主 Agent 调用 `query_xbb`。通用 Turn 不注入经营规则、不查询销帮帮。RAG 只索引规则，不缓存经营事实，不使用外部向量库。
- 主 Agent 与原生图表子 Agent 使用 LangGraph 完成结果与复核分支，内部规则检索、提示、查询工具和输出解析使用 LangChain；入口见 `shared/codex/agent-graph.js`。原生请求准入和接管必须同步，框架不得改变截止时间、取消、权限隔离或最新消息所有权。
- 框架只检索静态规则；不得为经营问题、事实或答案启用 LangSmith/继承回调，所有 Runnable/Graph 必须经 `shared/langchain/local-execution.js` 的隔离执行入口。不得增加第二套会话历史、模型工具循环或业务 checkpoint。
- 企业微信正式模型链路只允许常驻 Codex App Server + 持久 Thread；禁止恢复每消息一次的 `codex exec`、外部 Chat Completions 或无状态模型 JSON 循环。

# 验证要求

- 修改后执行 `npm test` 与 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\verify-skill.ps1`。
- 涉及 runner 路径或事实编译时，再用真实凭证执行一次最小只读冒烟查询，并删除输出事实包。
- Git/GitHub 提交说明使用清晰、具体且不重复的中文。
