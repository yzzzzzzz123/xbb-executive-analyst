"use strict";

// Pure, chart-local arithmetic. This does not authenticate a fact pack, prove
// that a cohort is the same, or establish causality / source completeness.
const RELATIONS_BY_TYPE = Object.freeze({
  bar: Object.freeze(["difference", "period-change", "maximum", "minimum", "share", "top-share"]),
  "stacked-bar": Object.freeze(["difference", "share"]),
  line: Object.freeze(["difference", "period-change", "maximum", "minimum"]),
  donut: Object.freeze(["difference", "share", "top-share"]),
  scatter: Object.freeze(["difference"]),
  funnel: Object.freeze(["difference", "retention", "loss"])
});

function fail(message) { throw new Error(`图表规格无效：finding ${message}`); }
function exactObject(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} 必须是对象`);
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string" || !keys.includes(key))) fail(`${label} 含不支持字段`);
  if (keys.some((key) => !Object.hasOwn(value, key))) fail(`${label} 缺少字段`);
}
function name(value, label) {
  if (typeof value !== "string") fail(`${label} 必须是字符串`);
  return value.trim();
}
function gcd(a, b) { a = a < 0n ? -a : a; while (b) { const next = a % b; a = b; b = next; } return a || 1n; }
function rational(n, d = 1n) {
  if (d === 0n) fail("分母不能为零");
  if (d < 0n) { n = -n; d = -d; }
  const divisor = gcd(n, d);
  return { n: n / divisor, d: d / divisor };
}
function decimal(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) fail("只能引用有限数字");
  const [mantissa, exponent = "0"] = String(value).toLowerCase().split("e");
  const [whole, fraction = ""] = mantissa.split(".");
  const scale = fraction.length - Number(exponent);
  const n = BigInt(`${whole}${fraction}`);
  return scale >= 0 ? rational(n, 10n ** BigInt(scale)) : rational(n * 10n ** BigInt(-scale));
}
const ZERO = rational(0n);
const HUNDRED = rational(100n);
const MAXIMUM = decimal(Number.MAX_VALUE);
const MINIMUM = decimal(Number.MIN_VALUE);
const add = (a, b) => rational(a.n * b.d + b.n * a.d, a.d * b.d);
const subtract = (a, b) => rational(a.n * b.d - b.n * a.d, a.d * b.d);
const multiply = (a, b) => rational(a.n * b.n, a.d * b.d);
const divide = (a, b) => rational(a.n * b.d, a.d * b.n);
const equal = (a, b) => a.n * b.d === b.n * a.d;
const magnitude = (a) => rational(a.n < 0n ? -a.n : a.n, a.d);

function finiteResult(value) {
  const positive = magnitude(value);
  if (positive.n * MAXIMUM.d > MAXIMUM.n * positive.d) fail("计算结果溢出有限数字范围");
  if (positive.n && positive.n * MINIMUM.d < MINIMUM.n * positive.d) fail("计算结果下溢，不能写成零");
  return value;
}

function numericText(value, significantDigits = 8) {
  finiteResult(value);
  if (value.n === 0n) return "0";
  const numerator = magnitude(value).n.toString();
  const denominator = value.d.toString();
  const leading = Number(`${numerator[0]}.${numerator.slice(1, 17)}`) / Number(`${denominator[0]}.${denominator.slice(1, 17)}`);
  const number = Number(`${value.n < 0n ? "-" : ""}${leading}e${numerator.length - denominator.length}`);
  if (!Number.isFinite(number) || number === 0) fail("计算结果不可表示");
  // Keep small values nonzero. Mark every rounded presentation explicitly.
  let displayed = Number(number.toPrecision(significantDigits));
  if (!Number.isFinite(displayed)) displayed = number;
  return `${equal(decimal(displayed), value) ? "" : "约"}${String(displayed)}`;
}

function format(value, valueFormat, unit, { difference = false } = {}) {
  if (valueFormat === "money" && magnitude(value).n >= 10000n * value.d) return `${numericText(divide(value, decimal(10000)))}万元`;
  const suffix = valueFormat === "money" ? "元" : valueFormat === "percent" ? difference ? "个百分点" : "%" : unit;
  return `${numericText(value)}${suffix}`;
}
const clip = (value, max = 10) => { const characters = Array.from(value); return characters.length <= max ? value : `${characters.slice(0, max - 1).join("")}…`; };
const displayName = (ref) => `${ref.series ? `${clip(ref.series, 8)}·` : ""}${clip(ref.category, 10)}`;
function label(ref, spec) {
  const displayed = displayName(ref);
  // Label shortening must not turn distinct evidence cells into the same
  // visible identity. Qualifiers refer to original chart positions; data and
  // normalized references retain their full, unchanged names.
  const candidates = spec.series
    ? spec.series.flatMap((series) => spec.categories.map((category) => ({ series: series.name, category })))
    : (spec.items || spec.points).map((entry) => ({ series: "", category: entry.name ?? entry.label }));
  const collision = candidates.filter((entry) => displayName(entry) === displayed).length > 1;
  let position = "";
  if (collision) {
    position = spec.series ? `〔系列${spec.series.findIndex((entry) => entry.name === ref.series) + 1}/类别${spec.categories.indexOf(ref.category) + 1}〕`
      : `〔${spec.items ? "项目" : "点"}${candidates.findIndex((entry) => entry.category === ref.category) + 1}〕`;
  }
  return `「${displayed}${position}」`;
}

function resolveRef(value, spec, field) {
  exactObject(value, ["series", "category", "axis"], field);
  const ref = { series: name(value.series, `${field}.series`), category: name(value.category, `${field}.category`), axis: value.axis };
  let number, valueFormat, unit, position;
  if (spec.series) {
    if (ref.axis !== "value") fail(`${field}.axis 必须为 value`);
    const series = spec.series.find((entry) => entry.name === ref.series);
    position = spec.categories.indexOf(ref.category);
    if (!series || position < 0) fail(`${field} 必须匹配已有 series/category`);
    number = series.values[position]; valueFormat = spec.valueFormat; unit = spec.unit;
  } else if (spec.items) {
    if (ref.axis !== "value" || ref.series !== "") fail(`${field} 的 axis 必须为 value 且 series 为空`);
    position = spec.items.findIndex((entry) => entry.name === ref.category);
    if (position < 0) fail(`${field} 必须匹配已有 items.name`);
    number = spec.items[position].value; valueFormat = spec.valueFormat; unit = spec.unit;
  } else {
    if (!["x", "y"].includes(ref.axis) || ref.series !== "") fail(`${field} 只允许同一 x/y 坐标且 series 为空`);
    position = spec.points.findIndex((entry) => entry.label === ref.category);
    if (position < 0) fail(`${field} 必须匹配已有 points.label`);
    number = spec.points[position][ref.axis]; valueFormat = spec[`${ref.axis}Format`]; unit = spec[`${ref.axis}Unit`];
  }
  if (valueFormat === "number" && /%|％|百分|百分点/u.test(unit)) fail("百分比单位必须使用 percent 格式，不能混入 number 单位");
  return { ref, number, value: decimal(number), valueFormat, unit, position };
}

function compatibilityOverview(spec) {
  if (spec.series) {
    const series = spec.series[0];
    const first = { series: series.name, category: spec.categories[0] };
    const last = { series: series.name, category: spec.categories.at(-1) };
    return `${label(first, spec)}为${format(decimal(series.values[0]), spec.valueFormat, spec.unit)}；${label(last, spec)}为${format(decimal(series.values.at(-1)), spec.valueFormat, spec.unit)}。`;
  }
  if (spec.items) {
    const first = spec.items[0], last = spec.items.at(-1);
    return `${label({ series: "", category: first.name }, spec)}为${format(decimal(first.value), spec.valueFormat, spec.unit)}；${label({ series: "", category: last.name }, spec)}为${format(decimal(last.value), spec.valueFormat, spec.unit)}。`;
  }
  const point = spec.points[0];
  return `${spec.points.length}个点；${label({ series: "", category: point.label }, spec)}的x轴（${clip(spec.xLabel)}）为${format(decimal(point.x), spec.xFormat, spec.xUnit)}，y轴（${clip(spec.yLabel)}）为${format(decimal(point.y), spec.yFormat, spec.yUnit)}。`;
}

function normalizeFinding(value, spec) {
  if (value === null) return { finding: null, insight: compatibilityOverview(spec), focus: null };
  exactObject(value, ["relation", "subject", "baseline"], "对象");
  if (!RELATIONS_BY_TYPE[spec.type]?.includes(value.relation)) fail("relation 不适用于当前图形");
  const subject = resolveRef(value.subject, spec, "subject");
  const relation = value.relation;
  let baseline = null;
  let insight;
  if (relation === "maximum" || relation === "minimum") {
    if (value.baseline !== null) fail(`${relation}.baseline 必须为 null`);
    const values = spec.series.find((entry) => entry.name === subject.ref.series).values;
    const extreme = (relation === "maximum" ? Math.max : Math.min)(...values);
    if (subject.number !== extreme) fail(`${relation}.subject 必须是该系列的${relation === "maximum" ? "最大" : "最小"}值`);
    if (new Set(values).size < 2) fail("相等序列不存在可强调的峰谷");
    const tied = values.filter((number) => number === extreme).length > 1;
    insight = `${label(subject.ref, spec)}为所示${values.length}项中的${tied ? "并列" : ""}${relation === "maximum" ? "最高" : "最低"}值：${format(subject.value, subject.valueFormat, subject.unit)}。`;
  } else if (relation === "share" || relation === "top-share") {
    if (value.baseline !== null) fail(`${relation}.baseline 必须为 null，分母由全部可见组成项计算`);
    if (relation === "top-share" && spec.type === "bar" && spec.series.length !== 1) fail("top-share 的条形图必须只有一个系列");
    const values = spec.type === "donut" ? spec.items.map((item) => item.value)
      : spec.type === "bar" ? spec.series.find((entry) => entry.name === subject.ref.series).values
        : spec.series.map((series) => series.values[subject.position]);
    const denominator = finiteResult(values.map(decimal).reduce(add, ZERO));
    if (denominator.n <= 0n) fail("构成分母必须大于零");
    if (subject.valueFormat === "percent" && !equal(denominator, HUNDRED)) fail("share 的 percent 构成必须精确合计 100，不能把舍入差当作真实分母");
    let numerator = subject.value;
    let name = label(subject.ref, spec);
    if (relation === "top-share") {
      const ranked = [...values].sort((a, b) => b - a);
      const count = ranked.indexOf(subject.number) + 1;
      if (count < 2 || count > 3 || count >= values.length) fail("top-share.subject 必须指向前2或前3项的最后一项，并保留其他项");
      if (ranked[count] === subject.number) fail("top-share 的排名边界存在并列，不能任意截断");
      numerator = finiteResult(ranked.slice(0, count).map(decimal).reduce(add, ZERO));
      name = `前${count}项（第${count}为${label(subject.ref, spec)}）合计${format(numerator, subject.valueFormat, subject.unit)}，`;
    }
    const percent = finiteResult(multiply(divide(numerator, denominator), HUNDRED));
    insight = `${name}占${spec.type === "stacked-bar" ? "该类别所示合计" : spec.type === "bar" ? "该系列所示合计" : "所示合计"}${numericText(percent, 4)}%（合计${format(denominator, subject.valueFormat, subject.unit)}）。`;
  } else {
    baseline = resolveRef(value.baseline, spec, "baseline");
    if (JSON.stringify(subject.ref) === JSON.stringify(baseline.ref)) fail("subject 与 baseline 不能是同一数据位置");
    if (subject.ref.axis !== baseline.ref.axis || subject.valueFormat !== baseline.valueFormat || subject.unit !== baseline.unit) fail("比较必须使用同一坐标轴、格式及单位");
    const difference = finiteResult(subtract(subject.value, baseline.value));
    const delta = format(magnitude(difference), subject.valueFormat, subject.unit, { difference: true });
    if (relation === "difference") {
      const axis = spec.type === "scatter" ? `${subject.ref.axis}轴（${clip(spec[`${subject.ref.axis}Label`])}）上，` : "";
      insight = difference.n === 0n ? `${axis}${label(subject.ref, spec)}与${label(baseline.ref, spec)}相同，差值为${delta}。`
        : `${axis}${label(subject.ref, spec)}比${label(baseline.ref, spec)}${difference.n > 0n ? "高" : "低"}${delta}。`;
    } else if (relation === "period-change") {
      if (subject.ref.series !== baseline.ref.series || subject.position <= baseline.position) fail("期间变化必须为同一系列，baseline 位于 subject 之前");
      // Scope this guard to the two referenced endpoints. Other categories,
      // subtitles or notes may legitimately disclose a separate MTD point.
      if ([subject.ref, baseline.ref].some((endpoint) => /[Mm][Tt][Dd]|截至|未完月|月累计/u.test(endpoint.category))) {
        fail("period-change 的 subject 或 baseline 标记为未完整期间；须选择两个完整月份，图中其他 MTD 点不影响比较");
      }
      const direction = difference.n > 0n ? "增加" : difference.n < 0n ? "减少" : "变化";
      const change = `从${label(baseline.ref, spec)}到${label(subject.ref, spec)}${direction}${delta}`;
      if (subject.valueFormat === "percent") insight = `${change}。`;
      else {
        if (baseline.value.n <= 0n) fail("相对期间变化的基准必须大于零，零或负基准不计算增长率");
        const percent = finiteResult(multiply(divide(difference, baseline.value), HUNDRED));
        insight = `${change}，变化率${numericText(percent, 4)}%。`;
      }
    } else {
      if (subject.position <= baseline.position || baseline.value.n <= 0n) fail("阶段关系必须从较早的正值阶段到较晚阶段");
      if (subject.number > baseline.number) fail("阶段留存不能大于前序阶段");
      const numerator = relation === "retention" ? subject.value : subtract(baseline.value, subject.value);
      const percent = finiteResult(multiply(divide(numerator, baseline.value), HUNDRED));
      insight = `从${label(baseline.ref, spec)}到${label(subject.ref, spec)}，${relation === "retention" ? "保留" : "流失"}${numericText(percent, 4)}%。`;
    }
  }
  return {
    finding: { relation, subject: subject.ref, baseline: baseline?.ref || null },
    insight, focus: { series: subject.ref.series, category: subject.ref.category }
  };
}

module.exports = { RELATIONS_BY_TYPE, normalizeFinding };
