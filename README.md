# 销帮帮经营分析智能客服

这是一个可同时被 Codex 和企业微信智能机器人使用的正式 Skill 项目。它只读取已配置的真实销帮帮数据，根据老板当前的问题最小化输出结论和必要的辅助图表；没有固定报告、样例数据、HTML、驾驶舱、工作台或 CRM 写操作。

## 项目结构

```text
xbb-executive-analyst/
├─ AGENTS.md
├─ README.md
├─ package.json
├─ contracts/
│  ├─ access-policy.schema.json
│  └─ access-policy.example.json
├─ skills/
│  └─ xbb-executive-analyst/
│     ├─ SKILL.md
│     ├─ agents/
│     ├─ assets/
│     ├─ references/
│     └─ scripts/
│        ├─ query-xbb.ps1          # 唯一事实入口
│        └─ render-chart.ps1
├─ shared/
│  ├─ agent/                       # 模型工具循环
│  ├─ security/                    # USERID 与公司权限
│  ├─ wecom/                       # 企业微信回调、加密、流式刷新
│  └─ xbb/                         # 确定性只读取数与事实编译
├─ scripts/                        # 安全配置、启动、验证
└─ tests/
```

这个项目不需要 Git worktree、多 Agent、RAG 或常驻明文事实库。运行时配置、访问策略、加密缓存和临时文件均在仓库外。

## 前置条件

- Windows PowerShell 5.1。
- Node.js 22 或更高版本。
- 已按现有销帮帮只读连接器保存凭证：`%LOCALAPPDATA%\Codex\xbb-openapi\credentials.json`。
- 一个支持工具调用的真实模型端点。端点需兼容 Chat Completions 的 `messages`、`tools`、`tool_calls` 响应结构。
- 企业微信管理端创建的“智能机器人（API 模式）”Token 与 EncodingAESKey。
- 企业微信可访问的公网 HTTPS 回调地址。服务本身默认只监听回环地址，TLS 应由反向代理或可信隧道终止。

## 1. 配置访问策略

访问策略必须使用回调中实际收到的 `from.userid`。如果机器人创建者不是企业超级管理员，企业微信可能给出企业主体下的加密 USERID，此时策略也应填写该实际值。

公司级用户：

```powershell
& .\scripts\configure-access-policy.ps1 `
  -UserId '实际USERID' `
  -Company '准确公司名称'
```

集团级用户：

```powershell
& .\scripts\configure-access-policy.ps1 `
  -UserId '实际USERID' `
  -AllowAll
```

策略默认保存到 `%LOCALAPPDATA%\Codex\xbb-executive-analyst\access-policy.json`，由 [机器契约](contracts/access-policy.schema.json) 校验。

## 2. 安全配置机器人与模型

```powershell
& .\scripts\configure-bot.ps1 `
  -ModelEndpoint 'https://你的模型服务/v1/chat/completions' `
  -ModelName '支持工具调用的模型名称'
```

脚本会交互式读取企业微信 Token、EncodingAESKey 和模型 API Key，不把秘密显示在命令行。秘密使用当前 Windows 用户的 DPAPI 加密并保存到 `%LOCALAPPDATA%\Codex\xbb-executive-analyst\bot-config.json`。本地免鉴权的回环模型端点可以把 API Key 留空。

也可以完全使用进程环境变量部署：

- `XBB_WECOM_TOKEN`
- `XBB_WECOM_ENCODING_AES_KEY`
- `XBB_WECOM_RECEIVE_ID`（企业内部自建智能机器人通常留空）
- `XBB_MODEL_ENDPOINT`
- `XBB_MODEL_API_KEY`
- `XBB_MODEL_NAME`
- `XBB_ACCESS_POLICY_PATH`
- `XBB_WECOM_HOST`、`XBB_WECOM_PORT`、`XBB_WECOM_CALLBACK_PATH`

只要环境变量不是完整配置，服务就会读取 DPAPI 安全配置；不存在固定数据或假模型回退。

## 3. 启动与健康检查

```powershell
& .\scripts\start-wecom-bot.ps1
```

默认监听：

- 健康检查：`http://127.0.0.1:8788/healthz`
- 回调入口：`http://127.0.0.1:8788/wecom/callback`

反向代理对外应提供类似 `https://bot.example.com/wecom/callback` 的地址，并只把该路径转发给本服务。不要直接把 8788 端口暴露到公网。

## 4. 企业微信后台配置

在企业微信“智能机器人”的 API 模式中填写公网 HTTPS 回调 URL、同一组 Token 和 EncodingAESKey。保存时企业微信会发起 GET 校验；服务会校验签名、解密 `echostr` 并在一秒内返回明文。随后单聊机器人或群内 @机器人即可触发真实查询。

协议实现依据企业微信官方文档：[接收消息](https://developer.work.weixin.qq.com/document/path/100719)、[被动回复](https://developer.work.weixin.qq.com/document/path/101031)、[回调加解密](https://developer.work.weixin.qq.com/document/path/101033)。

## 5. 安装为当前用户后台任务

完成真实配置并先手工启动验证后，可安装登录后自动启动的当前用户计划任务：

```powershell
& .\scripts\install-wecom-task.ps1
```

任务以当前用户、有限权限和隐藏窗口运行，因此能够解密同一用户的 DPAPI 配置与销帮帮凭证。移除任务：

```powershell
& .\scripts\uninstall-wecom-task.ps1
```

## 验证

```powershell
npm test
& .\scripts\verify-skill.ps1
```

验证覆盖事实编译、图表安全、访问控制、企业微信 AES/签名、模型工具循环、URL 校验、回调排重与流式刷新。测试中的构造事实只验证确定性编译器，不会进入生产 runner 或作为答复回退。

## 运行边界

- 明文事实包只存在于单次系统临时目录，完成或失败后删除。
- 五分钟缓存使用 Windows 当前用户 DPAPI 加密；超过五分钟不作为查询结果使用。
- 机器人进程重启会结束正在进行的流式会话，用户需要重新提问；业务事实和用户问题不落盘。
- 服务日志不得记录用户问题、事实包、跟进摘录、Token、EncodingAESKey、模型 Key 或销帮帮凭证。
- 当前月问题的最终答复注明月累计（MTD）；跟进记录只转成规则信号，不复述原文。
