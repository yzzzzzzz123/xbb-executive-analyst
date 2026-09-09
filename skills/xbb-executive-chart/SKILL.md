---
name: xbb-executive-chart
description: Turn already-validated live XBB executive facts into at most one truthful, mobile-readable auxiliary chart specification. This bundled support skill must be used by xbb-executive-analyst whenever a chart is considered. It chooses or refuses the chart, structures the evidence, and emits only the governed chart contract; it never queries CRM, changes facts, runs independently, creates dashboards or HTML, or accepts arbitrary drawing code.
---

# 销帮帮经营辅助图

把 `xbb-executive-analyst` 已经校验的实时事实整理成一张辅助经营图。图只帮助老板更快看出比较关系，不能替代文字结论，也不能成为新的取数或推理入口。企业微信要求每条销帮帮答复都带图片，但本 Skill 仍只决定“是否能画真实经营图”；返回 `chart: null` 时，由可信桥接层从同一文字答复生成不新增经营数字的结论/状态卡。

本 Skill 是主经营 Skill 的同轮依赖，不是第二个 Agent：不调用销帮帮、不访问网络、不读取凭证、不补造事实、不发送消息。图表规格由本 Skill 决定，SVG/PNG 仍由项目内的确定性渲染器生成。

## 生成协议

严格按以下顺序工作：

核心边界：程序只验证图内引用与算术，不能证明数字已绑定完整事实源，也不能证明真实日期、完整分母或同批次对象；主经营 Skill 必须先核实这些条件。`finding` 只填关系与 `{series, category, axis}` 位置；`share` 的 `baseline` 为 `null`，其他关系指向图内基准。

1. **先过事实门槛。** 只接收当前轮 `ready` 事实包中已验证、同口径、同范围的数字。若只有一个数字、比较对象不一致、缺少分母、缺少必要时间点，或展示会暴露电话、邮箱、凭据、客户跟进原文，返回 `chart: null`。
2. **先选要证明的关系及证据，再选图。** 明确老板要比较什么，用结构化 `finding` 选择差值、期间变化、构成占比、阶段留存或流失，并引用图内已有的数据位置；不自行填写计算结果。确定性程序从这些位置计算并生成 `insight`，同时把 `focus` 设为 `finding.subject`。重点可以是低位、回落或非最大值，不能默认最大值就是发现；不从自由文字正则猜测关系或高亮。因果解释、行动建议和预测仍放在主 Skill 的文字答复中。没有适用且可信的关系时填 `finding: null`，此时只生成明确标注“兼容概述”的可见值摘要；若这不能帮助理解，就返回 `chart: null`。
3. **选最简单且诚实的图形。** 使用下表；不能满足门槛时退回更简单的图或 `chart: null`，不得为了有图而改变问题。

| 比较关系 | 首选 | 数据门槛与退路 |
| --- | --- | --- |
| 公司、课程或人员排名 | `bar` | 2—10 个同口径对象；按值降序。长名称使用横向条形图。 |
| 多个对象的课程/咨询/其他构成 | `stacked-bar` | 2—10 个对象、2—4 个组成项；比较总量与结构。若只比较总体构成，改用 `donut` 或文字。 |
| 日度、周度或月度连续变化 | `line` | 至少 4 个有序时间点，8—12 个更适合看形状；只有 2—3 个离散期间时改用 `bar` 或文字。 |
| 单一总体的粗略构成 | `donut` | 2—6 项为宜，最多 8 项，分母必须明确；需要精确比较时优先 `bar`。 |
| 两个连续指标之间的关系 | `scatter` | 各点必须同一观察粒度；至少 8 点为宜，12 点以上更可靠。点过少时改用 `bar` 或文字。 |
| 同一批对象的顺序阶段流失 | `funnel` | 2—8 个真实顺序阶段，数值不得随阶段增加；不满足同一批对象或顺序条件时改用 `bar`。 |

4. **整理数据而不改写事实。** 排名按主指标降序；时间和漏斗保持业务顺序；默认只保留前 10。只有事实包已经提供“其他”或能从同一组完整事实做确定性求和时才可合并“其他”。缺失不是零，不补点、不插值、不把比例当金额。一个坐标轴只放一种单位和口径。
   年度或跨月图直接使用所选域的 `monthlyTrend`、排名或结构字段，并用 `scope.months` / `scope.range` 标注期间；逐月 `provenance` 审计明细、原始日趋势和逐条业务列表都不是成图前提。`detailCoverage.aggregationComplete=true` 时，不得因下钻候选被压缩而拒绝本可生成的管理图。
5. **建立手机端信息层级。** `title` 说明对象和指标，建议不超过 20 个中文字；`subtitle` 说明期间、范围、截至时间以及必要分母；`note` 保留会改变理解的必要口径限制，不为缩短卡片而删掉。标题保持中性，程序生成的 `insight` 承担“图内可计算的发现”，`focus` 指向所选关系的主体。单系列不制造图例，多系列最多 4 个；颜色、字体和强调样式由渲染器控制，规格不得提供 `color`、样式、SVG、HTML 或脚本。
6. **按类型输出最小规格。** 阅读 [chart-contract.md](references/chart-contract.md)，只输出该图形需要的字段，不输出其他图形的空数组或空字符串。每种图均输出 `finding` 和 `focus`；建议模型固定填写 `insight: "由finding生成"`、`focus: null`，由程序生成文案和重点。`finding` 引用必须包含 `series`、`category`、`axis`；非系列图使用空字符串 `series`，散点只允许同一 `x` 或 `y` 坐标比较。百分比统一使用百分点，例如 `37.5` 表示 `37.5%`；百分比差值用“个百分点”，不能混为相对增长率。`percent` 构成的 `share` 必须精确合计 100，不能将舍入差作为真实分母；其他构成分母由图内全部相应组成项求和。`money` 数值统一使用元且 `unit` 留空。零分母、负增长基准、无效引用或不适用于该图的关系不发布。
7. **发布前复核来源与口径。** 逐项对照事实包检查数值、标签、排序、期间、单位、分母及 `finding` 的引用是否一致；确认条形图从零开始、折线时间顺序正确、构成分母完整、漏斗属于同一批对象且非递增、敏感信息未进入规格。程序只能证明图内引用与计算一致；期间关系只检查图示位置先后，不能证明标签是真实日期、漏斗是同一批对象或数字已绑定完整事实源。这些仍是主 Skill 的事实门槛，不得因合同通过而省略。任何一项无法确认就返回 `chart: null`，保留真实文字答复。

## 输出与渲染

- 企业微信模式：在主 Agent 的结构化结果中返回 `chart` 对象或 `null`。模型不运行图表脚本；桥接层按同一合同在内存中生成 PNG。
- Codex 对话模式：把同一最小规格写入 run-scoped JSON，调用主 Skill 规定的 `scripts/render-chart.ps1`，检查实际 SVG 后删除规格文件。
- 经营图渲染失败时保留文字结论，并由桥接层依次退到结论速览图和不含经营数字的内置安全占位图；不得改用样例、旧图、远程图表服务或自由生成的经营位图。
- 历史规格可以缺少 `finding` / `focus`，但未经验证的自由 `insight` 不会原样发布：它会被“兼容概述”覆盖，旧重点清空。明确提供却无效的 `finding` 不走兼容路径，整张图降级为 `null`。

外部方案的取舍和许可记录见 [research-basis.md](references/research-basis.md)。该文件只用于维护本 Skill，不参与每轮经营判断。
