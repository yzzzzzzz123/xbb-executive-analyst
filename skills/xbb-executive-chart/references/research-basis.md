# 外部 Skill 调研与取舍

调研日期：2026-09-03。这里记录设计依据，避免以后把不适合本项目边界的通用图表运行时直接搬入生产。

## 采用的原则

- [OpenAI role-specific-plugins / visualize-data](https://github.com/openai/role-specific-plugins/blob/fe5608d2512a7d6a7b9821ce8a88c48464ecd6e4/plugins/data-analytics/skills/visualize-data/SKILL.md)（MIT）：先定义分析问题和一句话发现，再写紧凑 chart contract；按图形、结构、颜色、最终场景 QA 的顺序构建；图表选择服从比较关系和数据充足性。
- [Anthropic knowledge-work-plugins / data-visualization](https://github.com/anthropics/knowledge-work-plugins/blob/f30dc63b57654ab9b80da56ff2d1645c86f1c2de/data/skills/data-visualization/SKILL.md)（Apache-2.0）：按数据关系选图、保持坐标尺度诚实、长标签使用横向条形图、用中性色和有限强调色，并通过文字或形状补充颜色编码。
- [Karthik Data Visualization Skills](https://github.com/skthewimp/karthik-data-visualization-skill)（MIT）：Skill/Agent 负责问题、证据、选型和视觉判断，确定性能力负责渲染与检查；强调单一主张、直接标签、克制配色和构建后的视觉复核。

本项目据此原创了面向销帮帮实时经营事实、企业微信手机阅读和现有六类 SVG 渲染器的专用协议，没有复制上游代码或原文段落。

## 明确不直接引入

- [onsen-ai/chart-skill](https://github.com/onsen-ai/chart-skill) 的 YAML/Vega-Lite 和主题化输出思路有参考价值，但它需要额外安装约 50 MB 的 Vega 依赖；本项目已有离线、确定性、无远程资源的 SVG→PNG 链路，因此不引入该运行时。
- 通用 ECharts、Recharts 或 HTML dashboard Skill 会扩大依赖和攻击面，并与本项目禁止 HTML、禁止外链、企业微信只发单张辅助图的边界冲突。
- 生成式位图不能保证数字、比例和标签精确，不用于经营辅助图。
