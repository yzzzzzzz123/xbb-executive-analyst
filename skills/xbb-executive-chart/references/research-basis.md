# 外部 Skill 调研与取舍

当前视觉基准见 [visual-direction.md](visual-direction.md)。开发验收运行 `node scripts/preview-charts.js`，在项目 `test-results/chart-design` 查看六类 PNG 与 390 px 手机预览；其中测试数字只用于离线排版验收，不进入经营运行时。

调研日期：2026-09-03。这里记录设计依据，避免以后把不适合本项目边界的通用图表运行时直接搬入生产。

2026-09-14再次检索并打开OpenAI与Anthropic官方可视化Skill及Datawrapper图表文字指南。采用“问题与证据先于选图、关系决定图型、注释解释发现、最终尺寸实际QA”的原则，改为原生ultra图表子Agent先逐项分析，程序验证多条关系，再形成有编号和阅读顺序的综合图。没有安装通用Skill依赖或复制上游代码。新增 `node scripts/preview-chart-analysis.js`，在 `test-results/chart-analysis-review` 同时检查完整与390px图片；预览均醒目标明离线虚构验收，运行时仍只使用当前真实事实。

## 采用的原则

- [OpenAI role-specific-plugins / visualize-data](https://github.com/openai/role-specific-plugins/blob/fe5608d2512a7d6a7b9821ce8a88c48464ecd6e4/plugins/data-analytics/skills/visualize-data/SKILL.md)（MIT）：先定义分析问题和一句话发现，再写紧凑 chart contract；按图形、结构、颜色、最终场景 QA 的顺序构建；图表选择服从比较关系和数据充足性。
- [Anthropic knowledge-work-plugins / data-visualization](https://github.com/anthropics/knowledge-work-plugins/blob/f30dc63b57654ab9b80da56ff2d1645c86f1c2de/data/skills/data-visualization/SKILL.md)（Apache-2.0）：按数据关系选图、保持坐标尺度诚实、长标签使用横向条形图、用中性色和有限强调色，并通过文字或形状补充颜色编码。
- [Karthik Data Visualization Skills](https://github.com/skthewimp/karthik-data-visualization-skill)（MIT）：Skill/Agent 负责问题、证据、选型和视觉判断，确定性能力负责渲染与检查；强调单一主张、直接标签、克制配色和构建后的视觉复核。

本项目据此原创了面向销帮帮实时经营事实、企业微信手机阅读和现有六类 SVG 渲染器的专用协议，没有复制上游代码或原文段落。

## 手机经营图设计参考

补充检索日期：2026-09-09。以下六个原始来源已实际打开核对，用于维护图形与文字的设计，不参与业务取数或每轮模型调用。

| 原始参考 | 借鉴内容 | 本项目原创实施方向 |
| --- | --- | --- |
| [Datawrapper：横向条形图定制](https://www.datawrapper.de/academy/customizing-your-bar-chart) | 排名排序、标签独立行、紧凑数字和关键行强调 | 中文名称与数值对齐，条形独占下一行；排名保持数据顺序，强调由显式 `focus` 决定；可以参考其[完整 PNG 示例](https://datawrapper.dwcdn.net/FdWeD/full.png)。 |
| [Datawrapper：图表文字设计](https://www.datawrapper.de/blog/text-in-data-visualizations) | 直接标签、重点文字层级、单位靠近数值、注释说明发现 | 一句有证据的 `insight` 先引导阅读，再用高亮数据支持它；标题、数字、口径按层级排布，中文不旋转，长说明左对齐。 |
| [Datawrapper：折线图定制](https://www.datawrapper.de/academy/customizing-your-line-chart) | 颜色和线宽共同强调系列，选择性点标签，末端直接标注 | 控制标签数量并避让；显式证据点可以是回落或低位，不能只标峰值；实际数据和必要刻度保留。 |
| [Reuters Graphics：手机与桌面注释](https://reuters-graphics.github.io/newsroom-datawrapper-guide/next-steps/mobile-annotations/) | 手机需要更短的注释与适合窄屏的位置 | 按手机缩放后检查可读性；图内保留短证据标签，长解释放在图下，必要口径完整展示。 |
| [Observable Plot：Bar mark](https://observablehq.github.io/plot/marks/bar) | 横向条、排序，以及表达整体组成的一维堆叠条 | 用基础 SVG 几何组合组成比例和对齐数值；细小分段的文字放在外侧，分母与单位保持明确。只参考表达原则，不新增合同图形类型。 |
| [Financial Times：Visual Vocabulary 模板](https://github.com/ft-interactive/visual-vocabulary-templates) | 按排名、变化、构成与偏离问题选择图形 | 在现有六种合同内按真实比较关系选图，结合[在线模板图库](https://ft-interactive.github.io/visual-vocabulary-templates/)评估标签、留白和尺度；不扩展为仪表盘。 |

以上转化为本项目的 SVG 布局、证据位置合同与手机文案建议，没有复制网站图片、品牌元素或上游代码。网上图形仅作为设计参考，经营图仍使用当前轮已验证事实和本地确定性 SVG→PNG 链路。

许可范围：FT 模板仓库声明软件采用 MIT，明确排除 FT 内容与品牌；不能据此复用 FT 标识或新闻图内容。Observable Plot 的 [LICENSE](https://github.com/observablehq/plot/blob/main/LICENSE) 允许使用、修改与分发软件，并要求保留版权及许可说明；本次没有引入该软件。Datawrapper 和 Reuters 的文章图片未核验到可任意复制的许可，保留出处链接而不将原图用于产品输出。图形表达原则由本项目自行实现，不产生对远程字体、图库或图表服务的运行时依赖。

## 明确不直接引入

- [onsen-ai/chart-skill](https://github.com/onsen-ai/chart-skill) 的 YAML/Vega-Lite 和主题化输出思路有参考价值，但它需要额外安装约 50 MB 的 Vega 依赖；本项目已有离线、确定性、无远程资源的 SVG→PNG 链路，因此不引入该运行时。
- 通用 ECharts、Recharts 或 HTML dashboard Skill 会扩大依赖和攻击面，并与本项目禁止 HTML、禁止外链、企业微信只发单张辅助图的边界冲突。
- 生成式位图不能保证数字、比例和标签精确，不用于经营辅助图。
