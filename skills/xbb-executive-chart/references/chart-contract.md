# 经营辅助图规格合同

这是 `xbb-executive-chart` 和项目确定性渲染器共同遵守的最小合同。最终 JSON 必须是下列六种判别结构之一；所有对象都拒绝未列出的字段。

## 共同字段

模型新生成的每一种图都必须包含以下字段。运行时兼容历史规格：只有 `focus` 允许省略，省略时归一化为 `null`；其余必填字段和原有长度上限保持不变。

- `type`：`bar`、`stacked-bar`、`line`、`donut`、`scatter` 或 `funnel`。
- `title`：非空，说明对象和指标，不在标题里塞结论；手机阅读建议不超过 20 个中文字。
- `subtitle`：可为空；有值时说明期间、范围、截至时间或必要分母。
- `insight`：非空的一句话事实发现，只能由图中可见数字直接支持；手机阅读建议不超过 36 个中文字。
- `note`：可为空；只写会影响解释的真实口径限制。
- `focus`：`null` 或严格的 `{ "series": string, "category": string }`，指向最能支撑关键发现的一个已展示数据位置。没有单一重点时填 `null`。

文字结论、因果解释与行动建议仍由主 Skill 的 `answer` 承担。图表规格不得包含建议、因果断言、预测、电话、邮箱、凭据、客户跟进原文、颜色、CSS、SVG、HTML、脚本、URL 或文件路径。必要口径 `note` 必须保留，文案长度建议不是删除限制条件的理由。

### 发现与证据位置

- `bar`、`stacked-bar`、`line`：`focus.series` 必须匹配一个已有 `series.name`，`focus.category` 必须匹配一个已有 `categories` 标签。匹配发生在与数据相同的首尾空白清理之后，不使用模糊匹配或自由文字推断。
- `donut`、`funnel`：`focus.series` 必须为空字符串，`focus.category` 必须匹配一个已有 `items.name`。
- `scatter`：`focus.series` 必须为空字符串，`focus.category` 必须匹配一个已有 `points.label`。
- 非空 `focus` 的两个字段均必填，不接受未知字段、未匹配名称或其他值类型。Structured Outputs 的六种 schema 均将 nullable `focus` 列为必填字段；只有旧规格在运行时可省略。
- 选择支持发现的证据，可聚焦低位、回落、异常构成或中间阶段，不自动把最大值当作关键发现。`insight` 与 `focus` 应互相支持；图形样式由确定性渲染器根据显式位置控制，不通过扫描 `insight` 或 `answer` 的文字猜测高亮。

## 分类型字段

### `bar` 与 `stacked-bar`

除共同字段外，必须包含：

- `categories`：2—10 个非空且唯一的标签。
- `series`：1—4 个非空且唯一的系列；每个系列为 `{ "name": string, "values": number[] }`，数值数量必须与 `categories` 相同。
- `valueFormat`：`number`、`money` 或 `percent`。
- `unit`：`number` 的业务单位，例如“家”“人”“单”；`money` 和 `percent` 时必须为空。`money` 原始数值一律以元为单位，由渲染器自动显示元、万或亿。

数值必须有限且不小于零。`bar` 用于排序或类别比较；`stacked-bar` 的各系列必须是同一总量的可加组成项。`stacked-bar` 使用 `percent` 时，每个类别的各系列必须合计 100，只容许 ±0.5 个百分点的舍入差。

### `line`

字段与条形图相同，但 `categories` 可包含 2—30 个按时间升序排列的标签。数值可为负；若 `valueFormat` 是 `percent`，仍必须位于 0—100。2—3 个时间点虽然合同可表达，但本 Skill 默认改用条形图或文字，除非这些点确实构成连续时间比较。

### `donut`

除共同字段外，必须包含：

- `items`：2—8 个 `{ "name": string, "value": number }`；名称非空且唯一，数值有限且不小于零。
- `valueFormat`、`unit`：含义与条形图相同。
- `centerLabel`：环形中心合计的简短名称。

`items` 必须属于同一分母。渲染器会从这些原始数值计算构成占比；若 `valueFormat` 为 `percent`，输入值本身就是百分点，各项必须合计 100（只容许 ±0.5 个百分点的舍入差），图例不重复显示第二份相同百分比。

### `scatter`

除共同字段外，必须包含：

- `points`：2—40 个 `{ "label": string, "x": number, "y": number, "size": number }`；标签非空且唯一，`x`、`y` 必须有限，`size` 必须有限且不小于零。
- `xLabel`、`yLabel`：两个坐标的业务含义。
- `xFormat`、`yFormat`：各自为 `number`、`money` 或 `percent`。
- `xUnit`、`yUnit`：`number` 坐标可用的业务单位；对应格式为 `money` 或 `percent` 时必须为空。

所有点必须使用同一观察粒度、期间、范围和过滤条件。`size` 只有在第三个指标会改变解释时才使用；否则统一填 `0`。

### `funnel`

字段为共同字段，加上 `items`、`valueFormat` 和 `unit`。`items` 包含 2—8 个按真实业务阶段排列的名称和值；值必须有限、非负且从前到后不增加。

## 百分比与空值

- `percent` 一律使用 0—100 的百分点，`37.5` 才表示 `37.5%`。
- `0` 是经过确认的真实零；缺失、未知或未纳入统计不能写成 `0`。
- 不允许 `NaN`、`Infinity`、字符串数字或混合单位。

## 最小示例

```json
{
  "type": "stacked-bar",
  "title": "公司回款结构",
  "subtitle": "2026年9月｜集团｜截至实时刷新时间",
  "insight": "公司乙的咨询占比高于公司甲",
  "note": "仅比较已分类课程与咨询回款",
  "focus": { "series": "咨询", "category": "公司乙" },
  "categories": ["公司甲", "公司乙"],
  "series": [
    { "name": "课程", "values": [100000, 80000] },
    { "name": "咨询", "values": [20000, 60000] }
  ],
  "valueFormat": "money",
  "unit": ""
}
```

不要为这个示例添加 `items`、`points`、坐标字段或其他无关空字段。
