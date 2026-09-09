# 项目边界

- 正式经营入口唯一是 `skills/xbb-executive-analyst/SKILL.md`；`skills/xbb-executive-chart/SKILL.md` 只能作为它的同轮辅助经营图依赖，不得独立取数、路由或回答经营问题。每条销帮帮答复必须随附图片：合格经营图优先，否则由可信企微桥接层生成不新增经营事实的结论/状态图。
- 销帮帮事实只能由 `skills/xbb-executive-analyst/scripts/query-xbb.ps1` 读取；服务层不得直接访问凭证或 OpenAPI。
- `shared/xbb` 只负责确定性取数、编译与图表渲染；`shared/codex` 负责回环 App Server、持久 Thread 与动态工具循环；`shared/wecom` 负责企业微信协议；`shared/security` 负责授权与隐私校验。
- 生产运行只允许真实只读数据。禁止样例回退、固定结论、伪造 AI 分析、CRM 写操作、HTML、驾驶舱和工作台。
- 明文事实包是单次运行临时文件，必须在成功或失败后删除。运行密钥、访问策略、日志与状态不得写入仓库。
- 企业微信用户必须先通过访问策略授权，再进入模型或销帮帮查询；访问策略可以逐 USERID 授权，也可以由部署者显式启用保留键 `*`，让机器人可触达范围内的任意用户获得集团只读权限。未显式启用通配规则时继续默认拒绝；公司级用户只能查询明确授权的公司。
- 国内版企业微信正式接入使用普通员工可在客户端创建的智能机器人 WebSocket 长连接，只读取 Bot ID 与 DPAPI 保护的 Secret；不得要求公网回调、管理员自建应用、Token 或 EncodingAESKey。
- 本项目不使用 Git worktree 或多 Agent 编排。企业微信顶层是通用 Codex Agent；只有识别为销帮帮经营问题的 Turn 才能使用 `shared/rag` 的本地内存 Skill RAG、在同一个 Turn 注入 `xbb-executive-analyst` 及其 `xbb-executive-chart` 辅助依赖并调用 `query_xbb`。通用 Turn 不得注入经营/辅助图 Skill、经营 RAG 或查询销帮帮。RAG 只索引 Skill 与合同，不缓存经营事实，也不接入外部向量库。
- 企业微信正式模型链路只允许常驻 Codex App Server + 持久 Thread；禁止恢复每消息一次的 `codex exec`、外部 Chat Completions 或无状态模型 JSON 循环。

# 验证要求

- 修改后执行 `npm test` 与 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\verify-skill.ps1`。
- 涉及 runner 路径或事实编译时，再用真实凭证执行一次最小只读冒烟查询，并删除输出事实包。
- Git/GitHub 提交说明使用清晰、具体且不重复的中文。
