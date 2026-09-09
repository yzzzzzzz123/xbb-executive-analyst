"use strict";

const FORMAT_VALUES = Object.freeze(["number", "money", "percent"]);
const COMMON_FIELDS = Object.freeze(["type", "title", "subtitle", "insight", "note", "focus"]);
const PERCENT_TOTAL_TOLERANCE = 0.5;

const LIMITS = Object.freeze({
  title: 100,
  subtitle: 140,
  insight: 160,
  note: 180,
  name: 80,
  category: 80,
  axisLabel: 40,
  centerLabel: 40,
  unit: 20
});

const formatSchema = { type: "string", enum: FORMAT_VALUES };
const commonProperties = {
  title: {
    type: "string",
    minLength: 1,
    maxLength: LIMITS.title,
    description: "说明对象和指标，建议不超过 20 个中文字。"
  },
  subtitle: { type: "string", maxLength: LIMITS.subtitle },
  insight: {
    type: "string",
    minLength: 1,
    maxLength: LIMITS.insight,
    description: "仅陈述图中可见事实支持的一句关键发现，建议不超过 36 个中文字；因果、建议与预测留在文字答复。"
  },
  note: { type: "string", maxLength: LIMITS.note }
};
const categoriesSchema = {
  type: "array",
  minItems: 2,
  items: { type: "string", minLength: 1, maxLength: LIMITS.category }
};
const itemsSchema = {
  type: "array",
  minItems: 2,
  maxItems: 8,
  items: strictObject({
    name: { type: "string", minLength: 1, maxLength: LIMITS.name },
    value: { type: "number", minimum: 0 }
  })
};
const pointsSchema = {
  type: "array",
  minItems: 2,
  maxItems: 40,
  items: strictObject({
    label: { type: "string", minLength: 1, maxLength: LIMITS.name },
    x: { type: "number" },
    y: { type: "number" },
    size: { type: "number", minimum: 0 }
  })
};

const CHART_SCHEMA = deepFreeze({
  anyOf: [
    chartVariant("bar", {
      valueFormat: formatSchema,
      unit: { type: "string", maxLength: LIMITS.unit },
      categories: { ...categoriesSchema, maxItems: 10 },
      series: makeSeriesSchema(10, true)
    }),
    chartVariant("stacked-bar", {
      valueFormat: formatSchema,
      unit: { type: "string", maxLength: LIMITS.unit },
      categories: { ...categoriesSchema, maxItems: 10 },
      series: makeSeriesSchema(10, true)
    }),
    chartVariant("line", {
      valueFormat: formatSchema,
      unit: { type: "string", maxLength: LIMITS.unit },
      categories: { ...categoriesSchema, maxItems: 30 },
      series: makeSeriesSchema(30, false)
    }),
    chartVariant("donut", {
      valueFormat: formatSchema,
      unit: { type: "string", maxLength: LIMITS.unit },
      items: itemsSchema,
      centerLabel: { type: "string", minLength: 1, maxLength: LIMITS.centerLabel }
    }),
    chartVariant("scatter", {
      points: pointsSchema,
      xLabel: { type: "string", minLength: 1, maxLength: LIMITS.axisLabel },
      yLabel: { type: "string", minLength: 1, maxLength: LIMITS.axisLabel },
      xFormat: formatSchema,
      yFormat: formatSchema,
      xUnit: { type: "string", maxLength: LIMITS.unit },
      yUnit: { type: "string", maxLength: LIMITS.unit }
    }),
    chartVariant("funnel", {
      valueFormat: formatSchema,
      unit: { type: "string", maxLength: LIMITS.unit },
      items: itemsSchema
    })
  ]
});

function strictObject(properties) {
  return {
    type: "object",
    additionalProperties: false,
    properties,
    required: Object.keys(properties)
  };
}

function makeSeriesSchema(maxValues, nonnegative) {
  return {
    type: "array",
    minItems: 1,
    maxItems: 4,
    items: strictObject({
      name: { type: "string", minLength: 1, maxLength: LIMITS.name },
      values: {
        type: "array",
        minItems: 2,
        maxItems: maxValues,
        items: nonnegative ? { type: "number", minimum: 0 } : { type: "number" }
      }
    })
  };
}

function chartVariant(type, specificProperties) {
  const hasSeries = ["bar", "stacked-bar", "line"].includes(type);
  return strictObject({
    type: { type: "string", enum: [type] },
    ...commonProperties,
    focus: {
      description: "选择最能支撑 insight 的已展示数据位置，可为低位、回落或非最大值；没有单一重点时为 null。不得从自由文字猜测。",
      anyOf: [
        strictObject({
          series: hasSeries
            ? { type: "string", minLength: 1, maxLength: LIMITS.name }
            : { type: "string", enum: [""] },
          category: { type: "string", minLength: 1, maxLength: LIMITS.category }
        }),
        { type: "null" }
      ]
    },
    ...specificProperties
  });
}

function validateSpec(spec) {
  ensureObject(spec, "图表");
  if (!Object.prototype.hasOwnProperty.call(spec, "type")) fail("缺少 type");
  if (typeof spec.type !== "string") fail("type 必须是字符串");

  const validators = {
    bar: validateSeriesChart,
    "stacked-bar": validateSeriesChart,
    line: validateSeriesChart,
    donut: validateDonut,
    scatter: validateScatter,
    funnel: validateFunnel
  };
  const validator = Object.prototype.hasOwnProperty.call(validators, spec.type)
    ? validators[spec.type]
    : null;
  if (!validator) fail("type 不受支持");

  const normalized = validator(spec);
  const focus = Object.prototype.hasOwnProperty.call(spec, "focus") ? spec.focus : null;
  normalized.focus = normalizeFocus(focus, normalized);
  return deepFreeze(normalized);
}

function validateSeriesChart(spec) {
  const maxCategories = spec.type === "line" ? 30 : 10;
  ensureExactFields(spec, [
    ...COMMON_FIELDS,
    "valueFormat", "unit", "categories", "series"
  ], "图表", ["focus"]);
  const common = normalizeCommon(spec);
  const valueFormat = normalizeFormat(spec.valueFormat, "valueFormat");
  const unit = normalizeUnit(spec.unit, valueFormat, "unit");
  const categories = normalizeStringArray(spec.categories, "categories", 2, maxCategories, LIMITS.category);
  const series = normalizeSeries(spec.series, categories.length, valueFormat, spec.type !== "line");
  if (spec.type === "stacked-bar") {
    categories.forEach((category, categoryIndex) => {
      const total = finiteSum(series.map((entry) => entry.values[categoryIndex]), `stacked-bar ${category} 合计`);
      if (valueFormat === "percent") ensurePercentTotal(total, `stacked-bar ${category}`);
    });
  }
  return { ...common, valueFormat, unit, categories, series };
}

function validateDonut(spec) {
  ensureExactFields(spec, [
    ...COMMON_FIELDS,
    "valueFormat", "unit", "items", "centerLabel"
  ], "图表", ["focus"]);
  const common = normalizeCommon(spec);
  const valueFormat = normalizeFormat(spec.valueFormat, "valueFormat");
  const items = normalizeItems(spec.items, valueFormat, false);
  const total = finiteSum(items.map((item) => item.value), "环形图 items.value 合计");
  if (total === 0) fail("环形图 items.value 不能全部为 0");
  if (valueFormat === "percent") ensurePercentTotal(total, "环形图 items.value");
  return {
    ...common,
    valueFormat,
    unit: normalizeUnit(spec.unit, valueFormat, "unit"),
    items,
    centerLabel: normalizeString(spec.centerLabel, "centerLabel", LIMITS.centerLabel, false)
  };
}

function validateFunnel(spec) {
  ensureExactFields(spec, [
    ...COMMON_FIELDS,
    "valueFormat", "unit", "items"
  ], "图表", ["focus"]);
  const common = normalizeCommon(spec);
  const valueFormat = normalizeFormat(spec.valueFormat, "valueFormat");
  const items = normalizeItems(spec.items, valueFormat, true);
  if (items[0].value === 0) fail("漏斗图首阶段必须大于 0");
  return {
    ...common,
    valueFormat,
    unit: normalizeUnit(spec.unit, valueFormat, "unit"),
    items
  };
}

function validateScatter(spec) {
  ensureExactFields(spec, [
    ...COMMON_FIELDS,
    "points", "xLabel", "yLabel", "xFormat", "yFormat", "xUnit", "yUnit"
  ], "图表", ["focus"]);
  const common = normalizeCommon(spec);
  const xFormat = normalizeFormat(spec.xFormat, "xFormat");
  const yFormat = normalizeFormat(spec.yFormat, "yFormat");
  ensureArrayRange(spec.points, "points", 2, 40);
  const points = spec.points.map((point, index) => {
    const path = `points[${index}]`;
    ensureExactFields(point, ["label", "x", "y", "size"], path);
    return {
      label: normalizeString(point.label, `${path}.label`, LIMITS.name, false),
      x: normalizeNumber(point.x, `${path}.x`, { percent: xFormat === "percent" }),
      y: normalizeNumber(point.y, `${path}.y`, { percent: yFormat === "percent" }),
      size: normalizeNumber(point.size, `${path}.size`, { nonnegative: true })
    };
  });
  ensureUnique(points.map((point) => point.label), "points.label");
  return {
    ...common,
    points,
    xLabel: normalizeString(spec.xLabel, "xLabel", LIMITS.axisLabel, false),
    yLabel: normalizeString(spec.yLabel, "yLabel", LIMITS.axisLabel, false),
    xFormat,
    yFormat,
    xUnit: normalizeUnit(spec.xUnit, xFormat, "xUnit"),
    yUnit: normalizeUnit(spec.yUnit, yFormat, "yUnit")
  };
}

function normalizeCommon(spec) {
  return {
    type: spec.type,
    title: normalizeString(spec.title, "title", LIMITS.title, false),
    subtitle: normalizeString(spec.subtitle, "subtitle", LIMITS.subtitle, true),
    insight: normalizeString(spec.insight, "insight", LIMITS.insight, false),
    note: normalizeString(spec.note, "note", LIMITS.note, true)
  };
}

function normalizeFocus(value, spec) {
  if (value === null) return null;
  ensureExactFields(value, ["series", "category"], "focus");
  const hasSeries = ["bar", "stacked-bar", "line"].includes(spec.type);
  const series = normalizeString(value.series, "focus.series", LIMITS.name, !hasSeries);
  const category = normalizeString(value.category, "focus.category", LIMITS.category, false);
  if (hasSeries) {
    if (!spec.series.some((entry) => entry.name === series)) fail("focus.series 必须匹配已有系列名称");
    if (!spec.categories.includes(category)) fail("focus.category 必须匹配已有类别");
  } else {
    if (series !== "") fail("focus.series 在 donut、funnel、scatter 中必须为空字符串");
    const labels = spec.type === "scatter"
      ? spec.points.map((point) => point.label)
      : spec.items.map((item) => item.name);
    if (!labels.includes(category)) fail("focus.category 必须匹配已有项目名称或散点标签");
  }
  return { series, category };
}

function normalizeSeries(value, categoryCount, format, nonnegative) {
  ensureArrayRange(value, "series", 1, 4);
  const series = value.map((entry, seriesIndex) => {
    const path = `series[${seriesIndex}]`;
    ensureExactFields(entry, ["name", "values"], path);
    if (!Array.isArray(entry.values) || entry.values.length !== categoryCount) {
      fail(`${path}.values 必须与 categories 等长`);
    }
    return {
      name: normalizeString(entry.name, `${path}.name`, LIMITS.name, false),
      values: entry.values.map((number, valueIndex) => normalizeNumber(
        number,
        `${path}.values[${valueIndex}]`,
        { nonnegative, percent: format === "percent" }
      ))
    };
  });
  ensureUnique(series.map((entry) => entry.name), "series.name");
  return series;
}

function normalizeItems(value, format, requireDescending) {
  ensureArrayRange(value, "items", 2, 8);
  const items = value.map((entry, index) => {
    const path = `items[${index}]`;
    ensureExactFields(entry, ["name", "value"], path);
    return {
      name: normalizeString(entry.name, `${path}.name`, LIMITS.name, false),
      value: normalizeNumber(entry.value, `${path}.value`, {
        nonnegative: true,
        percent: format === "percent"
      })
    };
  });
  ensureUnique(items.map((entry) => entry.name), "items.name");
  if (requireDescending) {
    for (let index = 1; index < items.length; index += 1) {
      if (items[index].value > items[index - 1].value) fail("漏斗 items.value 必须非递增");
    }
  }
  return items;
}

function normalizeStringArray(value, path, min, max, stringLimit) {
  ensureArrayRange(value, path, min, max);
  const normalized = value.map((entry, index) => normalizeString(entry, `${path}[${index}]`, stringLimit, false));
  ensureUnique(normalized, path);
  return normalized;
}

function normalizeString(value, path, maxLength, allowEmpty) {
  if (typeof value !== "string") fail(`${path} 必须是字符串`);
  const normalized = value.trim();
  const length = Array.from(normalized).length;
  if (!allowEmpty && length === 0) fail(`${path} 不能为空`);
  if (length > maxLength) fail(`${path} 最长 ${maxLength} 字符`);
  if (/[\u0000-\u001F\u007F]/u.test(normalized)) fail(`${path} 不能包含控制字符或换行`);
  if (/(?:https?:\/\/|data:|file:|javascript:)/iu.test(normalized)) fail(`${path} 不能包含 URL`);
  return normalized;
}

function normalizeFormat(value, path) {
  if (!FORMAT_VALUES.includes(value)) fail(`${path} 仅支持 number、money、percent`);
  return value;
}

function normalizeUnit(value, format, path) {
  const unit = normalizeString(value, path, LIMITS.unit, true);
  if (format !== "number" && unit) fail(`${path} 在 ${format} 格式下必须为空`);
  return unit;
}

function finiteSum(values, path) {
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!Number.isFinite(total)) fail(`${path} 超出有限数字范围`);
  return total;
}

function ensurePercentTotal(total, path) {
  if (Math.abs(total - 100) > PERCENT_TOTAL_TOLERANCE + 1e-9) {
    fail(`${path} 使用 percent 时合计必须为 100（允许 ±${PERCENT_TOTAL_TOLERANCE} 个百分点的舍入差）`);
  }
}

function normalizeNumber(value, path, options = {}) {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`${path} 必须是有限数字`);
  if (options.nonnegative && value < 0) fail(`${path} 不能为负数`);
  if (options.percent && (value < 0 || value > 100)) fail(`${path} 百分比必须为 0–100 的百分点`);
  return value;
}

function ensureArrayRange(value, path, min, max) {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    fail(`${path} 必须包含 ${min}–${max} 项`);
  }
}

function ensureUnique(values, path) {
  const seen = new Set();
  for (const value of values) {
    const key = value.normalize("NFKC").toLocaleLowerCase("zh-CN");
    if (seen.has(key)) fail(`${path} 不能重复`);
    seen.add(key);
  }
}

function ensureObject(value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${path} 必须是对象`);
}

function ensureExactFields(value, fields, path, optionalFields = []) {
  ensureObject(value, path);
  const allowed = new Set(fields);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) fail(`${path} 不支持字段 ${String(key)}`);
  }
  for (const field of fields) {
    if (!optionalFields.includes(field) && !Object.prototype.hasOwnProperty.call(value, field)) {
      fail(`${path} 缺少字段 ${field}`);
    }
  }
}

function fail(message) {
  throw new Error(`图表规格无效：${message}`);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

module.exports = { CHART_SCHEMA, validateSpec };
