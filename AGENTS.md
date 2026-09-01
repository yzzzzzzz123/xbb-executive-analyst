# 项目边界

- 正式 Skill 唯一入口是 `skills/xbb-executive-analyst/SKILL.md`。
- 销帮帮事实只能由 `skills/xbb-executive-analyst/scripts/query-xbb.ps1` 读取；服务层不得直接访问凭证或 OpenAPI。
- `shared/xbb` 只负责确定性取数、编译与图表渲染；`shared/agent` 负责模型工具循环；`shared/wecom` 负责企业微信协议；`shared/security` 负责授权与隐私校验。
- 生产运行只允许真实只读数据。禁止样例回退、固定结论、伪造 AI 分析、CRM 写操作、HTML、驾驶舱和工作台。
- 明文事实包是单次运行临时文件，必须在成功或失败后删除。运行密钥、访问策略、日志与状态不得写入仓库。
- 企业微信用户必须先通过访问策略授权，再进入模型或销帮帮查询；公司级用户只能查询明确授权的公司。
- 本项目不使用 Git worktree、RAG 或多 Agent 编排。

# 验证要求

- 修改后执行 `npm test` 与 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\verify-skill.ps1`。
- 涉及 runner 路径或事实编译时，再用真实凭证执行一次最小只读冒烟查询，并删除输出事实包。
- Git/GitHub 提交说明使用清晰、具体且不重复的中文。
