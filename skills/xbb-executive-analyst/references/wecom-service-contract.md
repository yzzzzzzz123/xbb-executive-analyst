# 企业微信智能机器人服务合同

## 正式接入方式

- 使用企业微信“智能机器人”的 API 模式，不使用群机器人 webhook 代替智能客服。
- 回调 URL 必须是企业微信能够访问的 HTTPS 地址。Node 服务默认只监听 `127.0.0.1:8788`，应由反向代理或可信隧道终止公网 TLS，再转发到本机。
- 企业内部自建智能机器人的 `ReceiveId` 使用空字符串，除非企业微信后台的实际接入类型明确要求其他值。
- URL 校验必须在一秒内完成签名校验和 `echostr` 解密，并原样返回无 BOM、无引号、无换行的明文。

## 消息与流式回复

- 接收 JSON 密文包装 `{ "encrypt": "..." }`，使用回调 URL 的 `msg_signature`、`timestamp`、`nonce` 校验。
- 用户消息以 `msgid` 排重；只接受已登记 USERID。访问控制失败发生在模型和销帮帮查询之前。
- 文字、语音转文字和图文混排中的文字可进入分析；图片、文件、视频本身不进入模型。
- 首次响应生成唯一 `stream.id`，可先返回真实运行状态且 `finish=false`。企业微信后续以 `msgtype=stream` 和同一 `stream.id` 刷新，服务返回当前完整内容；最终结果设置 `finish=true`。
- `stream.content` 是覆盖式完整内容，不是增量片段；UTF-8 长度不得超过 20480 字节。
- 服务只输出文字分析，不上传事实包、跟进证据或 CRM 附件。反馈 id 只用于关联回答，不含用户标识或业务数据。

## 加解密

- 签名为 Token、timestamp、nonce、encrypt 四个字符串排序拼接后的 SHA-1。
- AESKey 是 EncodingAESKey 补 `=` 后 Base64 解码所得 32 字节；AES-256-CBC 的 IV 是 AESKey 前 16 字节。
- 明文为 16 字节随机数、4 字节网络序消息长度、UTF-8 JSON 消息、ReceiveId，再按 32 字节块执行 PKCS#7 填充。
- 被动回复密文包装字段为 `encrypt`、`msgsignature`、`timestamp`、`nonce`；回复 nonce 使用当前回调 URL 的 nonce。

## 模型与工具

- 模型端点必须支持兼容 Chat Completions 的 `messages`、`tools`、`tool_calls` 协议。生产运行没有 mock、样例或固定答复回退。
- 模型只拥有 `query_xbb` 一个业务工具。工具参数经过白名单校验，且事实包在传给模型前再次验证实时只读来源、隐私标志和 SHA-256 完整性。
- 模型失败或 runner 失败只返回失败状态，不使用陈旧数据；明文事实包在 `finally` 中删除。

## 官方协议依据

- 智能机器人接收消息：https://developer.work.weixin.qq.com/document/path/100719
- 智能机器人接收事件：https://developer.work.weixin.qq.com/document/path/101027
- 智能机器人被动回复：https://developer.work.weixin.qq.com/document/path/101031
- 回调与回复加解密：https://developer.work.weixin.qq.com/document/path/101033
- 智能机器人主动回复：https://developer.work.weixin.qq.com/document/path/101138
