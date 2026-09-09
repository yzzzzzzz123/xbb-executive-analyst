# 销帮帮企业微信 Agent：AI CLI 本地化迁移与一键部署手册

> 文档定位：这是写给 Codex 等具备本机终端和文件操作能力的 AI Agent 阅读的执行手册，不是仅供人类浏览的安装说明。
>
> 适用项目：`xbb-executive-analyst` 1.4.x
>
> 默认仓库：`https://github.com/yzzzzzzz123/xbb-executive-analyst.git`
>
> 默认平台：Windows 10/11、Windows PowerShell 5.1、Node.js 22 或更高版本
>
> 核心目标：在一台本地 Windows 主机上部署“通用 Codex Agent + 按需调用 xbb-executive-analyst Skill + 企业微信长连接”的机器人，并在当前 Windows 用户登录后隐藏自启、掉线自愈。

---

## 1. 给执行 AI 的最高优先级约束

执行本部署任务的 AI 必须遵守以下约束：

1. 先完整读取本文件，再读取项目根目录的 `AGENTS.md`、`README.md`、`SKILL.md`，以及本文件明确引用的脚本；不得只按文件名猜测行为。
2. 以项目自带脚本作为正式部署入口。不得另写一套机器人服务、不得把企业微信连接改成 Webhook、不得绕过访问控制、不得把真实销帮帮查询替换成样例或固定数据。
3. 所有经营数据只允许通过项目现有的只读销帮帮链路访问。不得执行 CRM 写入、修改、删除或批量导出。
4. 不得要求操作者把企业微信 Secret、销帮帮 API Token、Cookie、ChatGPT 登录令牌或其他秘密粘贴到聊天中，也不得把秘密放进命令行参数、Git、日志或最终报告。
5. 需要 Secret 时，只能在操作者本机打开的 PowerShell 交互窗口中使用 `Read-Host -AsSecureString`。AI 应暂停等待本机安全录入，录入结束后继续执行。
6. 新电脑、新 Windows 用户或服务账号上必须重新录入企业微信 Secret 和销帮帮 API Token，并重新完成 Codex 的 ChatGPT 登录。不得复制另一台电脑或另一个用户生成的 DPAPI 密文后假定它可用。
7. 同一个企业微信 Bot ID 任何时刻只能有一个活动长连接实例。迁移切换前必须停止旧主机，禁止新旧主机双活。
8. 不得使用 `git reset --hard`、`git checkout --` 或类似方式覆盖用户修改。发现工作区非干净时，先保存证据并采用全新目录/明确版本部署；只有确实会覆盖用户文件时才请求选择。
9. 不得使用 Codex CLI 的 `--dangerously-bypass-approvals-and-sandbox`。不要使用已经弃用的 `--full-auto`。需要访问项目目录之外的 `%LOCALAPPDATA%\Codex` 或注册计划任务时，应在交互式 Codex 会话中申请必要权限。
10. 不得把“计划任务已创建”当作部署成功。只有新实例的 lease 进入 `running`、状态日志出现同一实例的 `ready`，并完成企业微信真实收发，才可以报告上线成功。
11. 不得为了排障随意杀死所有 `node.exe`。必须使用本项目的安装、卸载和看门狗脚本，让脚本按任务、命令行、PID、创建时间、代际和 lease 证明进程归属。
12. 执行过程中允许自行修复可恢复问题并重试。只在 ChatGPT 登录、秘密录入、企业微信后台配置、Secret 轮换、网络/代理许可或部署版本选择等真正需要人类参与的节点暂停。

### 1.1 秘密与非秘密的边界

| 项目 | 是否秘密 | 是否可写入最终报告 | 是否可跨机器复制 |
|---|---:|---:|---:|
| 仓库地址、Git commit、安装目录 | 否 | 是 | 是 |
| 企业微信 Bot ID | 一般按配置标识处理 | 可只显示末 4 位 | 是 |
| 企业微信 Secret | 是 | 否 | 不直接复制密文；目标机重新录入 |
| 销帮帮 Base URL、Corp ID | 组织配置 | 可按组织规范脱敏 | 是 |
| 销帮帮 API Token | 是 | 否 | 不直接复制密文；目标机重新录入 |
| `wecomBotSecretDpapi`、`apiTokenDpapi` | 是，且绑定 Windows 用户 | 否 | 否 |
| ChatGPT/Codex 登录状态 | 是 | 只报告“已登录/未登录” | 否 |
| access policy | 不含业务秘密，但含 USERID/权限 | 只报告模式和范围 | 建议目标机重建 |
| lease、状态日志、会话状态、缓存 | 运行时状态 | 只报告摘要 | 否 |

---

## 2. 系统边界与部署结果

部署后的正式链路如下：

```text
企业微信用户
  → 企业微信智能机器人长连接（出站 WSS）
  → shared/wecom：消息、线程、访问控制、进度与图表
  → 本机持久 Codex App Server
      ├─ 普通问题：通用 Codex Agent
      └─ 公司经营问题：按需读取 xbb-executive-analyst Skill / RAG
          → shared/xbb / query-xbb.ps1
          → 销帮帮 OpenAPI（真实、只读）
  → 企业微信文本和辅助图表回复
```

正式后台运行方式不是 Windows Service，而是当前 Windows 用户下的两个隐藏计划任务：

- `Codex-XBB-Executive-Analyst-WeCom`：机器人主任务；用户登录时启动；进程异常退出后按一分钟间隔重试 3 次。
- `Codex-XBB-Executive-Analyst-WeCom-Watchdog`：外部看门狗；每 5 分钟检查一次；仅在严格确认租约持续过期或假活后重启主任务。

主任务和看门狗均通过安装脚本生成的仓库外 `nodew.exe` 隐藏运行，不应周期性弹出黑色终端窗口。机器人在锁屏状态下可以继续工作，但电脑关机、睡眠、休眠、断网、Windows 用户注销或尚未登录时会离线。

部署不需要公网入站端口。企业微信连接是到 `wss://openws.work.weixin.qq.com` 的出站连接；Codex App Server 只允许绑定本机回环地址。

---

## 3. 一条命令把部署任务交给 Codex CLI

### 3.1 项目已经在本机时

在 Windows PowerShell 中执行：

```powershell
$ProjectRoot = 'D:\codex\xbb-executive-analyst'
codex -C $ProjectRoot '完整读取 AGENTS.md、README.md、SKILL.md 和 docs\AI-CLI-本地化迁移与一键部署.md，并严格按部署手册执行。先识别是全新部署、跨机迁移、原机升级还是故障恢复。只在 ChatGPT 登录、企业微信 Secret、销帮帮 API Token、企业微信后台配置或一次性 USERID 绑定确实需要人工时暂停；秘密只能让操作者在本机安全交互窗口输入，不得要求粘贴到聊天或命令行。不得复用其他机器或 Windows 用户的 DPAPI 密文，不得启动相同 Bot ID 的双实例。完成后按手册给出脱敏验收报告。'
```

这是一条“AI 总入口”命令。它会启动交互式 Codex 会话，以便在访问 `%LOCALAPPDATA%\Codex`、注册计划任务或等待安全录入时进行必要的人机交接。

### 3.2 新电脑上还没有项目时

先完成最小引导，再执行上一节的一条命令：

```powershell
$RepositoryUrl = 'https://github.com/yzzzzzzz123/xbb-executive-analyst.git'
$ProjectRoot = 'D:\codex\xbb-executive-analyst'
git clone $RepositoryUrl $ProjectRoot
Set-Location -LiteralPath $ProjectRoot
npm install --global @openai/codex
codex
```

第一次运行 `codex` 时，选择 **Sign in with ChatGPT** 并在浏览器完成登录。登录后退出该空白会话，再执行 3.1 节的一条命令。

如果要固定生产版本，不要直接使用不明确的最新代码。克隆后先切换到操作者确认的 tag 或 commit：

```powershell
Set-Location -LiteralPath 'D:\codex\xbb-executive-analyst'
git fetch --tags --prune
git switch --detach '<APPROVED_TAG_OR_COMMIT>'
```

### 3.3 关于无人值守 CLI

全新部署不应伪装成完全无人值守，因为 ChatGPT 登录、企业微信 Secret 和销帮帮 API Token 都是合法的人类安全门。凭据已在同一台机器、同一 Windows 用户下配置完成后，AI 可以使用 `codex exec` 做升级或恢复；但执行环境必须明确允许访问项目目录、`%LOCALAPPDATA%\Codex` 和当前用户的计划任务。

不要在示例中加入 `--dangerously-bypass-approvals-and-sandbox`，也不要使用已弃用的 `--full-auto`。Codex CLI 的当前安装、登录与命令参数以官方文档为准：

- [Codex CLI 使用说明](https://learn.chatgpt.com/docs/codex/cli)
- [Codex CLI 命令参考](https://learn.chatgpt.com/docs/developer-commands?surface=cli)

---

## 4. AI 的部署状态机

AI 必须先选择且只选择一种主路径：

| 模式 | 判定 | 主路径 |
|---|---|---|
| `fresh-install` | 目标 Windows 用户下没有本项目安全配置和计划任务 | 环境 → 登录 → 新建凭据 → 配置机器人 → 配权限 → 安装任务 |
| `cross-host-migration` | Bot ID 正从另一台电脑迁到本机 | 目标机预配置 → 停旧机 → 目标机重录秘密 → 安装上线 → 验收 |
| `same-host-upgrade` | 同一电脑、同一 Windows 用户，只更新代码或 schema | 记录基线 → 安全更新代码 → `npm ci` → 配置迁移 → 重装任务 → 验收 |
| `repair` | 代码和配置仍在，但任务、登录、连接或 lease 异常 | 只读诊断 → 修复根因 → 重跑正式安装入口 → 验收 |

执行顺序必须遵守：

```text
读取规则
  → 识别模式
  → 采集非秘密输入
  → 只读预检
  → 必要的人类安全门
  → 配置或迁移
  → 注册隐藏自启
  → ready 验活
  → 企业微信真人收发验收
  → 脱敏报告
```

---

## 5. 部署输入清单

AI 开始执行前应从当前环境自动发现能发现的内容，不要反复询问。只有缺少且无法安全推断时才请操作者提供。

### 5.1 非秘密输入

- 部署模式：`fresh-install` / `cross-host-migration` / `same-host-upgrade` / `repair`
- 仓库地址：默认 `https://github.com/yzzzzzzz123/xbb-executive-analyst.git`
- 目标 tag 或 commit：生产环境建议固定；未指定时由操作者确认是否使用当前检出版本
- 安装路径：默认 `D:\codex\xbb-executive-analyst`
- 企业微信 Bot ID
- 销帮帮 OpenAPI Base URL
- 销帮帮 Corp ID
- 权限模式：
  - `any-user`：机器人可触达的企业微信用户均获得集团只读权限；当前通用老板机器人推荐此模式
  - `named-all`：指定 USERID 获得集团只读权限
  - `named-companies`：指定 USERID 只允许查询准确公司名列表
- 可选代理：`HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`、`NO_PROXY`

### 5.2 只能本机安全录入的输入

- 企业微信智能机器人 Secret
- 销帮帮 API Token
- ChatGPT 账号登录

AI 的提示语应当是：

> 现在需要你在本机 PowerShell 的安全输入框中录入 Secret。输入内容不会回显。请不要把 Secret 发到聊天中；录入完成后告诉我继续。

如果 Secret 曾经出现在聊天、日志、截图、脚本参数或 Git 中，应要求操作者先在对应管理端轮换，不能继续沿用已暴露值。

---

## 6. 阶段一：只读预检

AI 在修改系统前执行以下只读检查，并保存摘要。不要输出任何环境变量的完整值。

```powershell
$ErrorActionPreference = 'Stop'
$ProjectRoot = 'D:\codex\xbb-executive-analyst'

[pscustomobject]@{
    WindowsUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    PowerShell = $PSVersionTable.PSVersion.ToString()
    ProjectExists = Test-Path -LiteralPath $ProjectRoot -PathType Container
    LocalAppData = [Environment]::GetFolderPath('LocalApplicationData')
}

git --version
node --version
npm --version
codex --version
codex login status
```

然后在项目目录中检查版本和工作区：

```powershell
Set-Location -LiteralPath $ProjectRoot
git remote -v
git rev-parse HEAD
git status --short
Get-Content -LiteralPath '.\package.json' -Raw -Encoding UTF8
```

最低要求：

- Windows PowerShell 5.1 可用。
- Git 可用。
- Node.js 版本满足 `package.json` 的 `>=22`。
- npm 可用。
- Codex CLI 可用，且同一个 Windows 用户的 `codex login status` 显示 ChatGPT 登录有效。
- 目标目录中的仓库来源和待部署 commit 可确认。

如需采集 Codex 的脱敏诊断摘要，可执行：

```powershell
codex doctor --summary
```

不得把 Codex 的登录文件、浏览器 Cookie 或令牌复制到目标机。跨机迁移时在目标 Windows 用户下重新运行 `codex` 并选择 ChatGPT 登录。

### 6.1 环境缺失时的处理

AI 可以在操作者授权后使用 Windows 包管理器安装 Git 和当前 Node.js LTS，但安装后必须重新打开 PowerShell 或刷新 PATH，并再次检查实际版本。Codex CLI 可通过 npm 安装：

```powershell
npm install --global @openai/codex
```

不要仅凭安装命令退出码判断环境就绪；必须再次执行 `git --version`、`node --version`、`npm --version`、`codex --version` 和 `codex login status`。

---

## 7. 阶段二：准备代码与依赖

### 7.1 全新安装或跨机迁移

优先使用新的、空的目标目录：

```powershell
$RepositoryUrl = 'https://github.com/yzzzzzzz123/xbb-executive-analyst.git'
$ProjectRoot = 'D:\codex\xbb-executive-analyst'

git clone $RepositoryUrl $ProjectRoot
Set-Location -LiteralPath $ProjectRoot
git fetch --tags --prune
git switch --detach '<APPROVED_TAG_OR_COMMIT>'
npm ci
```

`<APPROVED_TAG_OR_COMMIT>` 必须替换为实际批准版本。若操作者明确要求跟随某个分支，可以切换该分支，但最终报告仍要记录实际 `git rev-parse HEAD`。

不要从旧电脑复制以下内容：

- `node_modules`
- `%LOCALAPPDATA%\Codex\xbb-executive-analyst\bot-config.json`
- `%LOCALAPPDATA%\Codex\xbb-openapi\credentials.json`
- agent state、message store、缓存、图表临时文件、runner isolation、lease、状态日志
- Codex 登录目录或浏览器登录数据

### 7.2 原机升级

先记录当前已知可用 commit 和工作区状态：

```powershell
Set-Location -LiteralPath 'D:\codex\xbb-executive-analyst'
$KnownGoodCommit = git rev-parse HEAD
git status --short
git remote -v
```

如果工作区有未提交变更，不得强制覆盖。AI 应优先在新的版本目录部署，或者在操作者明确决定后再处理变更。工作区干净时才执行批准的更新方式，例如：

```powershell
git fetch --tags --prune
git switch --detach '<APPROVED_TAG_OR_COMMIT>'
npm ci
```

如果目标 Windows 用户下已经存在 schema 3.0，或早期 schema 4.0 缺少当前字段，运行项目自带迁移脚本：

```powershell
& '.\scripts\migrate-app-server-config.ps1'
```

该脚本只适用于同一台电脑、同一 Windows 用户下可解密的现有 DPAPI Secret。跨电脑或更换 Windows 用户时不得使用它“迁移”密文，必须重新执行安全配置。

---

## 8. 阶段三：在目标用户下创建销帮帮只读凭据

项目正式读取的销帮帮凭据路径是：

```text
%LOCALAPPDATA%\Codex\xbb-openapi\credentials.json
```

在目标 Windows 用户的 PowerShell 中执行下面的安全引导。API Token 必须由操作者直接在隐藏输入框中录入；AI 不得代填来自聊天记录的 Token。

```powershell
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$CredentialRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Codex\xbb-openapi'
[IO.Directory]::CreateDirectory($CredentialRoot) | Out-Null

$BaseUrl = (Read-Host '销帮帮 OpenAPI Base URL').Trim().TrimEnd('/')
$CorpId = (Read-Host '销帮帮 Corp ID').Trim()
$ApiToken = Read-Host '销帮帮 API Token（输入不回显）' -AsSecureString

if ([string]::IsNullOrWhiteSpace($BaseUrl)) { throw 'Base URL 不能为空。' }
if ($BaseUrl -notmatch '^https://') { throw '生产 Base URL 必须使用 HTTPS。' }
if ([string]::IsNullOrWhiteSpace($CorpId)) { throw 'Corp ID 不能为空。' }

$Payload = [ordered]@{
    version = 'app'
    baseUrl = $BaseUrl
    corpid = $CorpId
    apiTokenDpapi = ConvertFrom-SecureString $ApiToken
    createdAt = [DateTimeOffset]::UtcNow.ToString('o')
}

$Target = Join-Path $CredentialRoot 'credentials.json'
$Temporary = "$Target.tmp-$PID-$([Guid]::NewGuid().ToString('N'))"
$Backup = "$Target.bak-$PID-$([Guid]::NewGuid().ToString('N'))"

[IO.File]::WriteAllText(
    $Temporary,
    (($Payload | ConvertTo-Json -Depth 5) + [Environment]::NewLine),
    [Text.UTF8Encoding]::new($false)
)

try {
    if ([IO.File]::Exists($Target)) {
        [IO.File]::Replace($Temporary, $Target, $Backup)
    } else {
        [IO.File]::Move($Temporary, $Target)
    }
} finally {
    if ([IO.File]::Exists($Temporary)) { [IO.File]::Delete($Temporary) }
    if ([IO.File]::Exists($Backup)) { [IO.File]::Delete($Backup) }
    $ApiToken = $null
}

[pscustomobject]@{
    success = $true
    credentialPath = $Target
    tokenProtection = 'DPAPI CurrentUser'
}
```

AI 只可以报告文件存在、JSON schema 正确以及 `apiTokenDpapi` 非空；不得打印该字段内容，也不得尝试还原并显示明文 Token。

---

## 9. 阶段四：配置企业微信长连接机器人

### 9.1 企业微信管理端前置条件

操作者需要在国内版企业微信中创建或管理智能机器人，启用长连接接收消息，并取得 Bot ID 和当前 Secret。企业微信后台界面属于外部系统，AI 无法从本机仓库替代完成的操作应作为人类安全门。

目标机必须能够出站访问：

```text
wss://openws.work.weixin.qq.com
```

企业微信管理端配置的机器人可见范围决定哪些员工能够找到或使用机器人；项目本地 access policy 再决定这些用户是否获得经营分析权限。两层都要满足。

### 9.2 本机安全配置

在项目根目录执行：

```powershell
Set-Location -LiteralPath 'D:\codex\xbb-executive-analyst'
& '.\scripts\configure-bot.ps1' -WecomBotId '<BOT_ID>'
```

不要把 Secret 写到命令行。脚本会在当前窗口以 SecureString 提示输入，并将 Secret 以 Windows DPAPI CurrentUser 方式保存到：

```text
%LOCALAPPDATA%\Codex\xbb-executive-analyst\bot-config.json
```

配置同时固定正式模型入口为本机 Codex App Server，正式模型为 `gpt-5.6-sol`，经营分析问题按需调用项目 Skill；这里不存在外部 OpenAI API Key 配置。

### 9.3 跨机迁移的停机切换点

跨机迁移时，目标机可以先完成代码、依赖、Codex 登录和销帮帮凭据准备，但在目标机启动企业微信认证或安装正式任务之前，必须在旧机项目根目录执行：

```powershell
& '.\scripts\uninstall-wecom-task.ps1'
```

旧机输出 `success: true`，并确认主任务、看门狗任务和归属明确的机器人进程均已停止后，才允许继续目标机上线。若企业微信 Secret 在旧机外已经无法取得，应在企业微信管理端轮换 Secret，再在目标机安全录入。

---

## 10. 阶段五：配置谁可以使用经营分析

访问策略文件位于：

```text
%LOCALAPPDATA%\Codex\xbb-executive-analyst\access-policy.json
```

更改策略后应重跑安装脚本，让正式进程重新加载配置。

### 10.1 对机器人可触达员工开放集团只读查询

老板机器人需要开放给企业微信可见范围内的其他人员时，使用：

```powershell
& '.\scripts\configure-access-policy.ps1' -AllowAnyUser
```

这会创建通配规则 `*`，范围为集团只读。它不会给用户 CRM 写权限，也不会绕过 runner 对公司范围的二次约束。

### 10.2 只给指定 USERID 开放集团只读查询

```powershell
& '.\scripts\configure-access-policy.ps1' -UserId '<WECOM_USERID>' -AllowAll
```

### 10.3 指定 USERID 只允许查询部分公司

```powershell
& '.\scripts\configure-access-policy.ps1' `
    -UserId '<WECOM_USERID>' `
    -Company @('准确公司名称A', '准确公司名称B')
```

### 10.4 不知道 USERID 时的一次性绑定

USERID 发现器不能与生产机器人同时连接同一 Bot ID。先确保正式任务已卸载或停止，再执行：

```powershell
& '.\scripts\discover-wecom-user.ps1'
```

按终端显示的一次性短语，在企业微信私聊机器人发送；脚本只在本机显示实际 USERID，不查询销帮帮。绑定后配置 named policy，再安装正式任务。

只部署给单个本地所有者时，也可以使用项目封装入口：

```powershell
& '.\scripts\deploy-local-owner.ps1'
```

该入口会认证配置、发现一个 USERID、授予该用户集团只读权限并安装任务；它不等价于 `-AllowAnyUser`。面向全员或机器人可见范围开放时，应显式使用 10.1 节流程。

---

## 11. 阶段六：安装隐藏自启和自愈任务

配置、登录和权限都准备好后，在项目根目录执行唯一正式安装入口：

```powershell
& '.\scripts\install-wecom-task.ps1'
```

安装脚本负责：

- 校验安全配置和固定入口；
- 生成或更新 `%LOCALAPPDATA%\Codex\xbb-executive-analyst\bin\nodew.exe`；
- 注册主任务和 `-Watchdog` 任务；
- 清理同产品的旧任务变体和可验证旧进程；
- 启动新代际；
- 等待新 lease 和同代际 `ready`；
- 安装失败时恢复原计划任务定义与启用状态。

安装脚本的计划任务回滚不等于代码版本回滚。代码回滚必须依赖部署前记录并已存在于 Git 的已知可用 commit。

成功后，机器人会在当前 Windows 用户登录时隐藏启动。不要额外建立每分钟启动机器人、桌面启动脚本、可见 PowerShell 窗口或第二套守护进程。

---

## 12. 部署验收：健康检查，不是项目测试套件

下面是部署上线必须完成的运行验收。它不等同于执行 `npm test` 或修改代码；AI 不应因为部署而擅自运行整个开发测试套件。

### 12.1 检查计划任务

```powershell
$MainTask = 'Codex-XBB-Executive-Analyst-WeCom'
$WatchdogTask = "$MainTask-Watchdog"

Get-ScheduledTask -TaskName $MainTask, $WatchdogTask |
    Select-Object TaskName, State

Get-ScheduledTaskInfo -TaskName $MainTask |
    Select-Object LastRunTime, LastTaskResult, NextRunTime

Get-ScheduledTaskInfo -TaskName $WatchdogTask |
    Select-Object LastRunTime, LastTaskResult, NextRunTime
```

允许计划任务显示 `Running` 或在不同调度阶段显示合理状态，但不能仅凭状态名称判定业务就绪。

### 12.2 检查 lease 和同代际 ready

```powershell
$RuntimeRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Codex\xbb-executive-analyst'
$LeasePath = Join-Path $RuntimeRoot 'service-lease.json'
$StatusPath = Join-Path $RuntimeRoot 'status.jsonl'

$Lease = Get-Content -LiteralPath $LeasePath -Raw -Encoding UTF8 | ConvertFrom-Json
$RecentStatus = Get-Content -LiteralPath $StatusPath -Encoding UTF8 -Tail 100 |
    ForEach-Object {
        try { $_ | ConvertFrom-Json } catch { $null }
    } |
    Where-Object { $null -ne $_ }

$Ready = $RecentStatus |
    Where-Object {
        $_.status -eq 'ready' -and
        $_.instanceId -eq $Lease.instanceId
    } |
    Select-Object -Last 1

[pscustomobject]@{
    LeaseState = $Lease.state
    LeaseUpdatedAt = $Lease.updatedAt
    InstanceId = $Lease.instanceId
    SameGenerationReady = $null -ne $Ready
    ReadyTimestamp = if ($null -ne $Ready) { $Ready.timestamp } else { $null }
}
```

通过条件：

- lease schema 可解析；
- `state` 为 `running`；
- `updatedAt` 持续刷新而不是陈旧时间；
- 状态日志存在与当前 `instanceId` 完全相同的 `ready`；
- 没有第二台机器或第二个本地进程占用相同 Bot ID。

不要在报告中复制完整状态日志；只报告最后的脱敏状态、时间和实例 ID。

### 12.3 企业微信真实验收

至少完成以下真实消息检查：

1. 在私聊中发送“你好”，应得到通用 Agent 的简洁回复，而不是错误地进入经营分析失败兜底。
2. 发送一个明确经营问题，例如“本月集团业绩按公司排名，并区分课程和咨询占比”，应读取真实销帮帮只读数据并返回结论；禁止样例数据和旧结果替代。
3. 发送一个非经营问题，确认机器人仍是通用 Codex Agent，只在公司经营问题上调用经营分析 Skill。
4. 如果采用 `any-user`，由第二个处于机器人可见范围内的企业微信账号发起一次查询，确认不会出现“当前企业微信账号尚未获准使用经营分析服务”。
5. 对较长查询确认先有清楚的分阶段进度，再有最终结果；不能只停留在“正在分析”。
6. 需要图表的经营问题应在结论之后返回辅助图表；图表只辅助结论，不能替代文字答案。

无法代替人类点击企业微信客户端的 AI，应把这些列为“待人工确认”，不能谎报已验收。

---

## 13. 跨电脑迁移的完整切换顺序

AI 必须按以下顺序执行，避免同 Bot ID 双活：

### A. 在目标机预配置，但暂不连接企微

1. 安装/验证 Git、Node.js、npm、Codex CLI。
2. 在目标 Windows 用户下完成 ChatGPT 登录。
3. 克隆并固定批准的 Git commit。
4. 执行 `npm ci`。
5. 在目标 Windows 用户下重新创建销帮帮 DPAPI 凭据。
6. 准备 Bot ID、当前 Secret 和权限模式，但不要启动 USERID 发现器、认证探针或正式任务。

### B. 停止旧机

1. 在旧机运行 `scripts\uninstall-wecom-task.ps1`。
2. 确认旧机主任务和看门狗已删除。
3. 确认旧机没有本产品归属的机器人进程。
4. 旧机保持停机或断开该机器人部署，直到迁移完成。

### C. 在目标机上线

1. 安全运行 `configure-bot.ps1`，重新录入 Secret。
2. 运行 `configure-access-policy.ps1` 建立目标权限。
3. 运行 `install-wecom-task.ps1`。
4. 验证当前代际 lease 为 `running` 且出现 `ready`。
5. 完成企业微信真实消息验收。

### D. 失败回退

如果目标机未能 `ready`：

1. 在目标机运行 `uninstall-wecom-task.ps1`，确认目标实例完全停止。
2. 修复目标机时保持旧机离线，或决定回退旧机。
3. 如回退旧机，必须先确认目标机已经没有活动连接，再在旧机已知可用 commit 上重新运行 `install-wecom-task.ps1`。
4. 同一时刻只恢复一端。

---

## 14. 原机升级与快速恢复

### 14.1 原机升级

```powershell
Set-Location -LiteralPath 'D:\codex\xbb-executive-analyst'

$KnownGoodCommit = git rev-parse HEAD
git status --short
git fetch --tags --prune
git switch --detach '<APPROVED_TAG_OR_COMMIT>'
npm ci

if (Test-Path -LiteralPath (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Codex\xbb-executive-analyst\bot-config.json')) {
    & '.\scripts\migrate-app-server-config.ps1'
}

& '.\scripts\install-wecom-task.ps1'
```

如果 `git status --short` 非空，不得继续执行可能覆盖文件的 Git 操作。采用全新目录或请求操作者决定如何保留变更。

### 14.2 机器人挂起、任务丢失或终端闪窗

不要手工创建额外计划任务。先检查根因，再重新执行正式安装入口：

```powershell
Set-Location -LiteralPath 'D:\codex\xbb-executive-analyst'
codex login status
& '.\scripts\install-wecom-task.ps1'
```

安装脚本会重新建立隐藏 `nodew.exe` 和双任务。如果桌面仍每隔几分钟闪现 PowerShell 窗口，检查计划任务动作是否被其他软件改写；正式看门狗入口应由隐藏 `nodew.exe` 启动，而不是直接周期运行可见的 `powershell.exe`。

### 14.3 临时前台启动

仅在排障、且正式任务已停止时使用：

```powershell
& '.\scripts\start-wecom-bot.ps1'
```

关闭该终端会结束前台机器人。生产上线必须回到 `install-wecom-task.ps1` 的隐藏任务方式。

---

## 15. 常见故障的确定性处理

### 15.1 “当前企业微信账号尚未获准使用经营分析服务”

含义：该账号没有匹配本地 access policy，不是销帮帮 OpenAPI 没权限。

对机器人可触达人员统一开放集团只读：

```powershell
& '.\scripts\configure-access-policy.ps1' -AllowAnyUser
& '.\scripts\install-wecom-task.ps1'
```

如果仍被拒绝，检查企业微信管理端的机器人可见范围，以及服务是否已经重启并加载新 policy。

### 15.2 Codex 登录失效或普通问题也返回经营分析失败

1. 在运行计划任务的同一个 Windows 用户下执行 `codex login status`。
2. 未登录时运行 `codex`，选择 ChatGPT 登录。
3. 登录完成后重跑 `install-wecom-task.ps1`。
4. 用“你好”和一个非经营问题验证通用 Agent 路由。

不要配置假的模型接口，也不要把机器人改成只有固定经营问答的模板程序。

### 15.3 企业微信一直没有 `ready`

依次检查：

1. 目标机能否访问 `wss://openws.work.weixin.qq.com`。
2. 企业微信机器人是否启用了长连接接收消息。
3. Bot ID 与 Secret 是否匹配且为当前有效版本。
4. 是否有另一台电脑仍在使用相同 Bot ID。
5. 代理变量是否影响 Node 或 Codex App Server；需要时为回环地址配置 `NO_PROXY`。
6. `service-lease.json` 和 `status.jsonl` 的最新脱敏事件。

Secret 错误时重新运行 `configure-bot.ps1` 安全录入，再运行安装脚本。不得打印解密后的 Secret 排查。

### 15.4 销帮帮凭据无法解密

通常表示 `credentials.json` 来自另一台电脑、另一个 Windows 用户，或用户配置损坏。删除/覆盖凭据属于敏感操作，先向操作者确认，然后在目标用户下按第 8 节重新创建；不得尝试搬运旧 DPAPI 密文。

### 15.5 全年或大范围经营查询失败、被截断

这不是部署失败的充分证据。机器人应使用项目现有的分段事实包、汇总和结果压缩逻辑，不应一次把全部原始明细塞进企微消息。先确认最小经营查询成功，再检查项目状态日志中的失败阶段；禁止用旧数据或样例数据补齐。

### 15.6 机器人只回复“正在分析”后无结果

检查同一会话的 Codex turn 是否超时、App Server 是否仍存活、状态日志是否记录 `agent_failed`、`message_failed` 或连接重建。修复后通过正式安装入口重启；不要新建第二个 Bot 实例。

### 15.7 电脑重启后没有上线

本部署触发条件是“当前 Windows 用户登录”，不是无人登录的系统启动。确认：

- 运行配置和 Codex 登录属于当前用户；
- 用户已经登录而非仅开机停在登录界面；
- 主任务与看门狗均存在且启用；
- 电脑没有睡眠/休眠；
- 网络已连接；
- 当前代际出现 `ready`。

需要跨注销持续在线时，应迁移到常开 Windows 主机和专用服务账号，并在该账号下重新完成 DPAPI 配置与 ChatGPT 登录。

---

## 16. 停用、卸载与残留数据

长期停用时必须同时移除主任务和看门狗，使用项目自带入口：

```powershell
Set-Location -LiteralPath 'D:\codex\xbb-executive-analyst'
& '.\scripts\uninstall-wecom-task.ps1'
```

该操作会停止并注销可验证归属的机器人任务与进程，但默认保留：

- 企业微信 DPAPI 配置
- 销帮帮 DPAPI 凭据
- access policy
- agent state、message store、状态日志、lease 和缓存
- Git 工作区

删除上述残留数据是不可逆或会导致重新登录/重新配密的破坏性操作，不属于普通卸载。只有操作者明确要求清除，并在 AI 解析出精确绝对路径后，才可以单独执行。

---

## 17. AI 的最终报告格式

AI 完成或暂停部署时，应使用下面的固定字段报告事实。秘密字段永远不得输出。

```text
部署结论：成功 / 失败并已安全回退 / 等待人工安全门
部署模式：fresh-install / cross-host-migration / same-host-upgrade / repair
项目绝对路径：<PATH>
仓库来源：<REMOTE_URL>
部署 Git commit：<FULL_COMMIT>
Windows 运行用户：<DOMAIN\USER>
Node.js 版本：<VERSION>
Codex CLI 版本：<VERSION>
Codex 登录：已登录 / 未登录（不得输出令牌）
模型入口：本机 Codex App Server
经营分析：xbb-executive-analyst Skill，销帮帮真实只读数据
访问模式：any-user / named-all / named-companies
主任务：<TASK_NAME>，<STATE>
看门狗：<TASK_NAME>，<STATE>
当前 lease：running / starting / missing / invalid
当前实例 ID：<INSTANCE_ID>
同代际 ready：是 / 否，<TIMESTAMP>
企业微信真实收发：已验收 / 待人工确认
经营查询真实数据：已验收 / 待人工确认
第二账号权限：已验收 / 不适用 / 待人工确认
旧主机状态：已停止 / 不适用 / 未确认
自动启动：当前用户登录后隐藏启动
运行限制：关机、睡眠、休眠、断网、注销或用户未登录时离线
仍需用户确认：<ONLY_REAL_HUMAN_ACTIONS>
秘密处理：未在聊天、命令行、日志或报告中输出
```

不得报告“已部署成功”却把 `ready`、真实企业微信收发或旧机停用写成未知。如果只能完成本机自动化部分，应明确写“自动化安装完成，等待企业微信真人验收”。

---

## 18. AI 执行清单

AI 可使用以下清单控制执行，不得跳过安全门：

- [ ] 已完整读取 `AGENTS.md`、`README.md`、`SKILL.md` 和本手册
- [ ] 已识别且记录部署模式
- [ ] 已确认目标 Windows 用户
- [ ] 已确认 Git 远程、实际 commit 和工作区状态
- [ ] 已验证 Windows PowerShell 5.1、Git、Node.js >= 22、npm、Codex CLI
- [ ] 已在目标 Windows 用户下确认 ChatGPT 登录
- [ ] 已执行 `npm ci`
- [ ] 已在目标用户下安全创建/确认销帮帮 DPAPI 凭据
- [ ] 已在目标用户下安全创建/确认企业微信 DPAPI 配置
- [ ] 跨机迁移时已确认旧实例停止
- [ ] 已明确权限模式并生成 access policy
- [ ] 已通过 `install-wecom-task.ps1` 注册隐藏主任务和看门狗
- [ ] 已确认 lease 为 `running`
- [ ] 已确认当前 instance ID 的 `ready`
- [ ] 已完成或明确列出企业微信真人收发验收
- [ ] `any-user` 模式已由第二个账号验证，或明确列为待人工确认
- [ ] 最终报告没有 Secret、Token、Cookie、DPAPI 密文或经营明细泄漏

---

## 19. 项目内正式依据

执行 AI 发现本手册与当前代码不一致时，以当前仓库的正式规则和脚本为准，并在不擅自改代码的前提下报告文档漂移：

- `AGENTS.md`：项目级硬约束、正式入口、数据真实性和协作边界
- `README.md`：架构、运行要求、配置、访问控制、后台任务和运维说明
- `SKILL.md`：经营分析 Skill 总入口
- `package.json`：Node.js 版本与锁定依赖
- `scripts/configure-bot.ps1`：企业微信 Secret 的安全配置入口
- `scripts/configure-access-policy.ps1`：用户和公司范围授权入口
- `scripts/deploy-local-owner.ps1`：单一所有者本地部署入口
- `scripts/discover-wecom-user.ps1`：一次性 USERID 发现入口
- `scripts/migrate-app-server-config.ps1`：同机同用户配置 schema 迁移入口
- `scripts/install-wecom-task.ps1`：生产隐藏任务安装、升级、回滚与 ready 验活入口
- `scripts/uninstall-wecom-task.ps1`：生产任务安全停用入口
- `scripts/start-wecom-bot.ps1`：仅供前台排障的服务入口
- `shared/wecom/`：企微长连接、Codex App Server、状态、会话、图表和安全路由
- `shared/xbb/`：销帮帮真实只读数据访问

本手册本身不包含任何真实 Bot ID、Secret、销帮帮 Token、ChatGPT 凭据或固定经营分析结果，因此可以随项目安全迁移；所有机器相关的秘密和运行态仍必须保存在仓库之外。
