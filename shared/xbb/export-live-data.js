"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const API_BASE = String(process.env.XBB_API_BASE || "").replace(/\/$/, "");
const CORPID = String(process.env.XBB_CORPID || "");
const API_TOKEN = String(process.env.XBB_API_TOKEN || "");

const FORM = Object.freeze({
  performance: 5614255,
  oppOrder: 6707824,
  course: 7452529,
  booking: 7642173,
  deliveryBooking: 7452855,
  product: 5614247,
  opportunity: 5614253,
  follow: 5614251
});

const ENDPOINT = Object.freeze({
  paas: "/api/paas/list",
  contract: "/api/contract/list",
  opportunity: "/api/opportunity/list",
  follow: "/api/communicate/list",
  product: "/api/product/list",
  user: "/api/user/list",
  form: "/api/form/get"
});

const FIELD_ALLOWLIST = Object.freeze({
  performance: ["date_1", "text_63", "text_28", "num_1", "array_4", "text_3", "text_5", "text_26", "num_3", "num_6"],
  oppOrder: ["date_1", "text_31", "array_4", "text_3", "text_6", "text_10", "num_1", "num_5"],
  course: ["date_1", "date_2", "text_1", "text_5", "text_7", "text_10", "num_3", "num_6", "num_9", "num_10"],
  booking: ["date_1", "date_3", "text_5", "text_22", "text_2", "text_36", "num_1", "num_2"],
  deliveryBooking: ["date_3", "text_2", "text_6", "text_7", "text_8", "text_9", "text_25", "text_26", "text_36", "text_39", "text_40", "num_1", "num_2", "num_3"],
  product: ["text_1", "text_6", "text_15"],
  opportunity: ["creatorId", "ownerId", "text_1", "text_2", "text_3", "text_11", "text_12", "text_17", "text_20", "text_23", "text_24", "array_1", "num_1", "num_14"],
  follow: ["creatorId", "date_1", "text_1", "text_5", "text_6", "text_8", "text_10", "text_15", "text_22", "text_23"]
});

const SUBTABLE_ALLOWLIST = Object.freeze({
  performance: Object.freeze({ array_4: Object.freeze(["text_10", "num_5", "text_1", "num_3"]) }),
  oppOrder: Object.freeze({ array_4: Object.freeze(["text_1", "num_3", "num_5"]) })
});

const RELATION_FIELDS = new Set([
  "performance.text_28",
  "performance.text_26",
  "oppOrder.text_10",
  "booking.text_5",
  "booking.text_2",
  "deliveryBooking.text_2",
  "deliveryBooking.text_8",
  "deliveryBooking.text_9",
  "opportunity.creatorId",
  "opportunity.ownerId",
  "opportunity.text_3",
  "follow.creatorId",
  "follow.text_1",
  "follow.text_5",
  "follow.text_8",
  "follow.text_22"
]);

const REDACTED_TEXT_FIELDS = new Set(["deliveryBooking.text_39", "follow.text_6"]);
const SYSTEM_LABELS = Object.freeze({
  creatorId: "创建人",
  ownerId: "负责人"
});
let xbbRequestChain = Promise.resolve();
let xbbNextRequestAt = 0;

function configured() {
  return Boolean(API_BASE && CORPID && API_TOKEN);
}

function asText(value) {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map(asText).filter(Boolean).join("、");
  return String(value).trim();
}

function parseMaybeArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === "") return [];
  if (typeof value !== "string") return [value];
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    try {
      const parsed = JSON.parse(trimmed);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch (_) {
      return [trimmed];
    }
  }
  return [trimmed];
}

function relationId(value) {
  const first = parseMaybeArray(value)[0];
  if (first && typeof first === "object") {
    return asText(first.dataId || first.id || first.value);
  }
  return asText(first);
}

function flattenRecord(record) {
  return Object.assign({
    dataId: record.dataId,
    formId: record.formId,
    serialNo: record.serialNo,
    addTime: record.addTime,
    updateTime: record.updateTime,
    creatorId: record.creatorId,
    ownerId: record.ownerId
  }, record.data || {});
}

function structuralShape(value, depth = 0) {
  if (Array.isArray(value)) {
    return { type: "array", length: value.length, item: value.length && depth < 8 ? structuralShape(value[0], depth + 1) : null };
  }
  if (!value || typeof value !== "object") return typeof value;
  if (depth >= 8) return "object";
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, structuralShape(child, depth + 1)]));
}

function monthRange(month) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    throw new Error("月份格式必须为 YYYY-MM");
  }
  const [year, monthNumber] = month.split("-").map(Number);
  const nextYear = monthNumber === 12 ? year + 1 : year;
  const nextMonth = monthNumber === 12 ? 1 : monthNumber + 1;
  const start = Math.floor(Date.parse(`${month}-01T00:00:00+08:00`) / 1000);
  const next = Math.floor(Date.parse(`${nextYear}-${String(nextMonth).padStart(2, "0")}-01T00:00:00+08:00`) / 1000);
  return {
    month,
    start,
    end: next - 1,
    startLabel: `${month}-01`,
    endLabel: new Date((next - 1) * 1000).toLocaleDateString("zh-CN", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).replace(/\//g, "-")
  };
}

function currentMonthShanghai() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit"
  }).formatToParts(new Date());
  const year = parts.find((part) => part.type === "year").value;
  const month = parts.find((part) => part.type === "month").value;
  return `${year}-${month}`;
}

function dateConditions(attr, range) {
  return [
    { attr, value: [range.start], symbol: "greaterequal" },
    { attr, value: [range.end], symbol: "lessequal" }
  ];
}

function inRange(record, attr, range) {
  let value = record[attr];
  if (value === undefined && attr === "addTime") value = record.addTime;
  value = Number(value);
  if (!Number.isFinite(value)) return false;
  if (value > 1e12) value = Math.floor(value / 1000);
  return value >= range.start && value <= range.end;
}

function reserveXbbRequestSlot() {
  const slot = xbbRequestChain.then(async () => {
    const delay = Math.max(0, xbbNextRequestAt - Date.now());
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    xbbNextRequestAt = Date.now() + 80;
  });
  xbbRequestChain = slot.catch(() => {});
  return slot;
}

async function xbbPost(endpoint, payload) {
  if (!configured()) throw new Error("销帮帮接口凭证尚未加载");
  const body = JSON.stringify(Object.assign({ corpid: CORPID }, payload));
  const sign = crypto.createHash("sha256").update(body + API_TOKEN, "utf8").digest("hex");
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await reserveXbbRequestSlot();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);
    let response;
    try {
      response = await fetch(`${API_BASE}/pro/v2${endpoint}`, {
        method: "POST",
        headers: { "content-type": "application/json;charset=UTF-8", sign },
        body,
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }
    if (response.status === 429 && attempt < 5) {
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
      continue;
    }
    if (!response.ok) throw new Error(`销帮帮接口 HTTP ${response.status}`);
    const json = await response.json();
    if (json && json.success === true) return json.result || {};
    const message = asText(json && json.msg) || "未知错误";
    if (/(?:20\s*次\s*\/\s*秒|请求频率|限流)/i.test(message) && attempt < 5) {
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
      continue;
    }
    throw new Error(`销帮帮接口返回失败：${message}`);
  }
  throw new Error("销帮帮接口请求超过限流重试次数");
}

async function listAll(endpoint, payload, listKey = "list") {
  const first = await xbbPost(endpoint, Object.assign({}, payload, { page: 1, pageSize: 100 }));
  const rows = Array.isArray(first[listKey]) ? first[listKey].slice() : [];
  const totalPage = Math.min(Math.max(1, Number(first.totalPage) || 1), 100);
  for (let page = 2; page <= totalPage; page += 1) {
    const result = await xbbPost(endpoint, Object.assign({}, payload, { page, pageSize: 100 }));
    if (Array.isArray(result[listKey])) rows.push(...result[listKey]);
  }
  return rows;
}

function buildSchema(explainList) {
  const schema = new Map();
  const visit = (value, prefix = "") => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, prefix);
      return;
    }
    if (!value || typeof value !== "object") return;
    const attr = asText(value.attr);
    let childPrefix = prefix;
    if (attr) {
      const key = prefix ? `${prefix}.${attr}` : attr;
      const items = new Map();
      for (const item of value.items || []) items.set(String(item.value), asText(item.text));
      schema.set(key, {
        name: asText(value.attrName) || attr,
        items
      });
      if (/^array_\d+$/.test(attr)) childPrefix = key;
    }
    for (const [key, child] of Object.entries(value)) {
      if (["items", "attr", "attrName"].includes(key)) continue;
      if (child && typeof child === "object") visit(child, childPrefix);
    }
  };
  visit(explainList || []);
  return schema;
}

function decode(schema, attr, raw) {
  const values = parseMaybeArray(raw);
  const field = schema && schema.get(attr);
  return values.map((value) => {
    const key = value && typeof value === "object"
      ? asText(value.value || value.id || value.dataId || value.name)
      : asText(value);
    return field && field.items.has(key) ? field.items.get(key) : key;
  }).filter(Boolean).join("、");
}

async function loadMetadata() {
  const entries = await Promise.all(Object.entries(FORM).map(async ([name, formId]) => {
    try {
      const result = await xbbPost(ENDPOINT.form, { formId });
      return [name, buildSchema(result.explainList)];
    } catch (error) {
      throw new Error(`读取 ${name} 表单 ${formId} 定义失败：${error.message}`, { cause: error });
    }
  }));
  return Object.fromEntries(entries);
}

async function loadNamedCollection(name, formId, loader) {
  try {
    return await loader();
  } catch (error) {
    throw new Error(`读取 ${name} 表单 ${formId} 数据失败：${error.message}`, { cause: error });
  }
}

async function loadProducts(ids) {
  const unique = Array.from(new Set(ids.map(asText).filter(Boolean)));
  const rows = [];
  for (let index = 0; index < unique.length; index += 50) {
    const batch = unique.slice(index, index + 50).map((value) => /^\d+$/.test(value) ? Number(value) : value);
    rows.push(...await listAll(ENDPOINT.product, {
      conditions: [{ attr: "dataId", value: batch, symbol: "equal" }],
      viewApproval: 0
    }));
  }
  return rows.map(flattenRecord);
}

async function loadPaasByRelation(formId, attr, ids) {
  const unique = Array.from(new Set(ids.map(asText).filter(Boolean)));
  const rows = [];
  for (let index = 0; index < unique.length; index += 50) {
    const batch = unique.slice(index, index + 50).map((value) => /^\d+$/.test(value) ? Number(value) : value);
    rows.push(...await listAll(ENDPOINT.paas, {
      formId,
      conditions: [{ attr, value: batch, symbol: "equal" }],
      viewApproval: 0
    }));
  }
  return rows;
}

async function loadUsers(ids) {
  const unique = Array.from(new Set(ids.map(asText).filter(Boolean)));
  const users = [];
  for (let index = 0; index < unique.length; index += 100) {
    const userIdIn = unique.slice(index, index + 100);
    users.push(...await listAll(ENDPOINT.user, { userIdIn }, "userList"));
  }
  return users.map((user) => ({
    userId: asText(user.userId),
    name: asText(user.name) || "未命名员工",
    departments: (user.departmentList || []).map((department) => ({
      id: department.id,
      name: asText(department.name),
      isLeader: Number(department.isLeader) || 0
    })).filter((department) => department.name)
  }));
}

function publicId(namespace, value) {
  const text = asText(value);
  if (!text) return "";
  return `${namespace}_${crypto.createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16)}`;
}

function redactText(value) {
  return asText(value)
    .replace(/(?<!\d)1[3-9]\d{9}(?!\d)/g, "[手机号已脱敏]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[邮箱已脱敏]")
    .replace(/\b(?:ghp_|github_pat_|sk-)[A-Za-z0-9_-]{16,}\b/g, "[凭据已脱敏]");
}

function normalizeRelation(value) {
  const normalized = parseMaybeArray(value).map((item) => {
    if (item && typeof item === "object") {
      const id = asText(item.dataId || item.id || item.value);
      const name = redactText(item.name || item.text || item.label);
      return {
        id: publicId("rel", id),
        name: name || undefined
      };
    }
    return { id: publicId("rel", item) };
  }).filter((item) => item.id);
  if (!normalized.length) return null;
  return normalized.length === 1 ? normalized[0] : normalized;
}

function normalizeValue(collection, attr, raw, schema) {
  if (raw === undefined || raw === null || raw === "") return null;
  const subfields = SUBTABLE_ALLOWLIST[collection] && SUBTABLE_ALLOWLIST[collection][attr];
  if (subfields) {
    return parseMaybeArray(raw).map((item) => {
      let row = item;
      if (typeof row === "string") {
        try { row = JSON.parse(row); } catch { return null; }
      }
      if (!row || typeof row !== "object" || Array.isArray(row)) return null;
      const values = row.data && typeof row.data === "object" && !Array.isArray(row.data) ? row.data : row;
      const normalized = {};
      for (const subfield of subfields) {
        const value = normalizeValue(collection, `${attr}.${subfield}`, values[subfield], schema);
        if (value === null || value === "" || (Array.isArray(value) && !value.length)) continue;
        normalized[subfield] = value;
      }
      return Object.keys(normalized).length ? normalized : null;
    }).filter(Boolean);
  }
  const key = `${collection}.${attr}`;
  if (RELATION_FIELDS.has(key)) return normalizeRelation(raw);
  if (REDACTED_TEXT_FIELDS.has(key)) return redactText(raw).slice(0, 500);
  const field = schema && schema.get(attr);
  if (field && field.items && field.items.size) return decode(schema, attr, raw);
  if (Array.isArray(raw)) return raw.map((item) => normalizeValue(collection, attr, item, null));
  if (raw && typeof raw === "object") return redactText(raw.name || raw.text || raw.value || raw.dataId || "");
  if (typeof raw === "string") return redactText(raw);
  return raw;
}

function fieldCatalog(collection, schema) {
  const catalog = {};
  for (const attr of FIELD_ALLOWLIST[collection] || []) {
    const field = schema && schema.get(attr);
    catalog[attr] = {
      label: field ? field.name : (SYSTEM_LABELS[attr] || attr),
      options: field ? Object.fromEntries(field.items) : {}
    };
    for (const subfield of (SUBTABLE_ALLOWLIST[collection] && SUBTABLE_ALLOWLIST[collection][attr]) || []) {
      const nestedAttr = `${attr}.${subfield}`;
      const nested = schema && schema.get(nestedAttr);
      catalog[nestedAttr] = {
        label: nested ? nested.name : nestedAttr,
        options: nested ? Object.fromEntries(nested.items) : {}
      };
    }
  }
  return catalog;
}

function normalizeRecord(collection, record, schema) {
  const rawId = asText(record.dataId || record.serialNo || `${record.addTime}:${record.updateTime}`);
  const evidenceRef = publicId(collection, `${FORM[collection] || collection}:${rawId}`);
  const fields = {};
  for (const attr of FIELD_ALLOWLIST[collection] || []) {
    const value = normalizeValue(collection, attr, record[attr], schema);
    if (value === null || value === "" || (Array.isArray(value) && !value.length)) continue;
    fields[attr] = value;
  }
  return {
    evidenceRef,
    entityId: publicId("rel", rawId),
    recordId: publicId("record", rawId),
    serialNo: redactText(record.serialNo),
    addTime: Number(record.addTime) || null,
    updateTime: Number(record.updateTime) || null,
    fields
  };
}

function normalizeUser(user) {
  return {
    evidenceRef: publicId("user", user.userId),
    userId: publicId("rel", user.userId),
    name: redactText(user.name),
    departments: user.departments.map((department) => ({
      id: publicId("department", department.id),
      name: redactText(department.name),
      isLeader: department.isLeader
    }))
  };
}

async function buildLiveDataset(month) {
  const range = monthRange(month);
  const [metadata, performanceRaw, oppOrdersRaw, coursesRaw, deliveryBookingsRaw, opportunitiesRaw, followsRaw] = await Promise.all([
    loadMetadata(),
    loadNamedCollection("performance", FORM.performance, () => listAll(ENDPOINT.contract, { formId: FORM.performance, conditions: dateConditions("date_1", range), viewApproval: 0 })),
    loadNamedCollection("oppOrder", FORM.oppOrder, () => listAll(ENDPOINT.paas, { formId: FORM.oppOrder, conditions: dateConditions("date_1", range), viewApproval: 0 })),
    loadNamedCollection("course", FORM.course, () => listAll(ENDPOINT.paas, { formId: FORM.course, conditions: dateConditions("date_1", range), viewApproval: 0 })),
    loadNamedCollection("deliveryBooking", FORM.deliveryBooking, () => listAll(ENDPOINT.paas, { formId: FORM.deliveryBooking, conditions: dateConditions("date_3", range), viewApproval: 0 })),
    loadNamedCollection("opportunity", FORM.opportunity, () => listAll(ENDPOINT.opportunity, { formId: FORM.opportunity, conditions: dateConditions("addTime", range), viewApproval: 0 })),
    loadNamedCollection("follow", FORM.follow, () => listAll(ENDPOINT.follow, { conditions: dateConditions("date_1", range), viewApproval: 0 }))
  ]);

  if (process.env.XBB_DIAGNOSTIC_SHAPE === "1") {
    process.stderr.write(`${JSON.stringify({ performanceRaw: structuralShape(performanceRaw), courseRaw: structuralShape(coursesRaw) })}\n`);
  }

  const courseIds = coursesRaw.map((row) => row.dataId).filter(Boolean);
  const bookingsRaw = courseIds.length
    ? await loadNamedCollection("booking", FORM.booking, () => loadPaasByRelation(FORM.booking, "text_5", courseIds))
    : [];

  const performance = performanceRaw.map(flattenRecord).filter((row) => inRange(row, "date_1", range));
  const oppOrder = oppOrdersRaw.map(flattenRecord).filter((row) => inRange(row, "date_1", range));
  const course = coursesRaw.map(flattenRecord).filter((row) => inRange(row, "date_1", range));
  const courseIdSet = new Set(courseIds.map(asText));
  const booking = bookingsRaw.map(flattenRecord).filter((row) => courseIdSet.has(relationId(row.text_5)));
  const deliveryBooking = deliveryBookingsRaw.map(flattenRecord).filter((row) => inRange(row, "date_3", range));
  const opportunity = opportunitiesRaw.map(flattenRecord).filter((row) => inRange(row, "addTime", range));
  const follow = followsRaw.map(flattenRecord).filter((row) => inRange(row, "date_1", range));

  const productIds = [
    ...performance.map((row) => relationId(row.text_26)),
    ...oppOrder.map((row) => relationId(row.text_10))
  ];
  const userIds = [];
  for (const row of opportunity) userIds.push(asText(row.creatorId), ...parseMaybeArray(row.ownerId).map(asText));
  for (const row of follow) userIds.push(asText(row.creatorId));
  const [product, users] = await Promise.all([loadProducts(productIds), loadUsers(userIds)]);

  return {
    month,
    range,
    loadedAt: new Date().toISOString(),
    metadata,
    collections: { performance, oppOrder, course, booking, deliveryBooking, product, opportunity, follow },
    users
  };
}

function buildSourceBundle(dataset) {
  const records = {};
  const fields = {};
  for (const [collection, rows] of Object.entries(dataset.collections)) {
    const schema = dataset.metadata[collection];
    records[collection] = rows.map((row) => normalizeRecord(collection, row, schema));
    fields[collection] = fieldCatalog(collection, schema);
  }
  records.user = dataset.users.map(normalizeUser);
  fields.user = {
    userId: { label: "用户标识", options: {} },
    name: { label: "姓名", options: {} },
    departments: { label: "所属部门", options: {} }
  };

  const recordCounts = Object.fromEntries(Object.entries(records).map(([name, rows]) => [name, rows.length]));
  const canonicalRecords = JSON.stringify(records);
  return {
    schemaVersion: "3.0",
    skill: "xbb-executive-analyst",
    mode: "live-readonly-source",
    month: dataset.month,
    range: dataset.range,
    refreshedAt: dataset.loadedAt,
    provenance: {
      live: true,
      readOnly: true,
      dataSource: "xbb-openapi",
      fetchedBy: "xbb-executive-analyst/scripts/export-live-data.js",
      formIds: FORM,
      endpoints: [
        "/pro/v2/api/paas/list",
        "/pro/v2/api/contract/list",
        "/pro/v2/api/opportunity/list",
        "/pro/v2/api/communicate/list",
        "/pro/v2/api/product/list",
        "/pro/v2/api/user/list",
        "/pro/v2/api/form/get"
      ],
      recordCounts,
      credentialBoundary: "凭据仅在本机导出进程内存中使用，未写入来源包"
    },
    privacy: {
      telephoneFieldsExported: false,
      credentialFieldsExported: false,
      freeTextRedaction: "手机号、邮箱和常见凭据模式在进入来源包前脱敏",
      outputRule: "模型不得在对话答案或图表中逐字复制跟进正文"
    },
    fieldCatalog: fields,
    records,
    integrity: {
      algorithm: "sha256",
      recordsSha256: crypto.createHash("sha256").update(canonicalRecords, "utf8").digest("hex")
    }
  };
}

function parseArguments(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--month" || key === "--output") {
      parsed[key.slice(2)] = argv[index + 1];
      index += 1;
    } else {
      throw new Error(`不支持的参数：${key}`);
    }
  }
  parsed.month = parsed.month || currentMonthShanghai();
  if (!parsed.output) throw new Error("必须提供 --output");
  return parsed;
}

function atomicWriteJson(outputPath, payload) {
  const resolved = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const temporary = `${resolved}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(payload)}\n`, { encoding: "utf8", flag: "wx" });
    fs.renameSync(temporary, resolved);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch (_) { /* no temporary file */ }
    throw error;
  }
  return resolved;
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const dataset = await buildLiveDataset(args.month);
  const bundle = buildSourceBundle(dataset);
  const output = atomicWriteJson(args.output, bundle);
  const sourceSha256 = crypto.createHash("sha256").update(fs.readFileSync(output)).digest("hex");
  process.stdout.write(`${JSON.stringify({
    success: true,
    mode: bundle.mode,
    month: bundle.month,
    refreshedAt: bundle.refreshedAt,
    recordCounts: bundle.provenance.recordCounts,
    sourceSha256
  })}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error && error.message ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  buildLiveDataset,
  buildSourceBundle,
  monthRange,
  redactText
};
