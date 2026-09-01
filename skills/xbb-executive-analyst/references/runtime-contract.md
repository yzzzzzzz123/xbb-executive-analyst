# 运行、缓存与清理契约

在运行或修改取数、事实包、缓存、图表和验证脚本前阅读本文件。

## 唯一运行路径

- Skill：`xbb-executive-analyst`
- 唯一取数入口：`scripts/query-xbb.ps1`
- 凭据加载与实时导出：项目公共实现 `shared/xbb/export-live-data.ps1` → `shared/xbb/export-live-data.js`
- 确定性事实编译：项目公共实现 `shared/xbb/build-fact-pack.js`
- 按需图表：`scripts/render-chart.ps1` → 项目公共实现 `shared/xbb/render-chart.js`

不存在网页服务、HTML、驾驶舱、工作台、静态发布器、局域网代理或嵌套模型调用。

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

把最小图表规格写入 run-scoped JSON，然后执行：

```powershell
& .\scripts\render-chart.ps1 -SpecPath <absolute-spec-path>
```

生成器只输出自包含 SVG，不允许脚本、外链、远程字体或网络资源。最终 SVG 位于 `%TEMP%\Codex\xbb-executive-analyst\charts`，保留最多 24 小时；规格文件生成后立即删除。

## 安全与失败

- API Token 只在 `shared/xbb/export-live-data.ps1` 调用的导出进程内存中存在，完成后恢复/清除环境变量。
- 来源包和事实包必须通过记录哈希与隐私扫描。电话、邮箱或常见凭据模式命中时失败关闭。
- XBB 限流、网络错误、字段缺失、哈希错误、实体不唯一、缓存错误或图表验证错误都不能触发假数据回退。
- 所有 XBB API 调用均为读取；不得向本 Skill 增加写接口。
