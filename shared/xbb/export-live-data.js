"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { validateMetrics, sourceCollections, sourceFields } = require("./data-demand.js");
const { validateRequestedDate, validateDateScope } = require("./fast-query-plan.js");
const { resolveEntity } = require("./build-fact-pack.js");

const API_BASE = String(process.env.XBB_API_BASE || "").replace(/\/$/, "");
const CORPID = String(process.env.XBB_CORPID || "");
const API_TOKEN = String(process.env.XBB_API_TOKEN || "");

const FORM = Object.freeze({
  performance: 5614255,
  courseOrders: 5614255,
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
  contractDetail: "/api/contract/detail",
  opportunity: "/api/opportunity/list",
  follow: "/api/communicate/list",
  product: "/api/product/list",
  user: "/api/user/list",
  department: "/api/department/list",
  form: "/api/form/get"
});

const FIELD_ALLOWLIST = Object.freeze({
  performance: ["date_1", "text_63", "text_28", "num_1", "array_4"],
  courseOrders: ["date_1", "text_28", "num_1"],
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
  "courseOrders.text_28",
  "performance.array_4.text_1",
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
const LIST_PAGE_SIZE = 100;
const MAX_LIST_PAGES = 1000;
const ALLOWED_DOMAINS = new Set(["performance", "product-sales", "courses", "delivery", "opportunities"]);
const DOMAIN_COLLECTIONS = Object.freeze({
  performance: Object.freeze(["performance", "product"]),
  "product-sales": Object.freeze(["performance", "oppOrder", "product"]),
  courses: Object.freeze(["course", "booking", "deliveryBooking", "courseOrders"]),
  delivery: Object.freeze(["course", "deliveryBooking", "courseOrders"]),
  opportunities: Object.freeze(["opportunity", "follow", "user"])
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

function monthRange(month, now = new Date()) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    throw new Error("月份格式必须为 YYYY-MM");
  }
  const [year, monthNumber] = month.split("-").map(Number);
  if (year < 1900) throw new Error("月份年份不得早于 1900");
  const currentMonth = currentMonthShanghai(now);
  if (month > currentMonth) throw new Error(`不能查询晚于当前上海月份 ${currentMonth} 的月份`);
  const nextYear = monthNumber === 12 ? year + 1 : year;
  const nextMonth = monthNumber === 12 ? 1 : monthNumber + 1;
  const start = Math.floor(Date.parse(`${month}-01T00:00:00+08:00`) / 1000);
  const next = Math.floor(Date.parse(`${nextYear}-${String(nextMonth).padStart(2, "0")}-01T00:00:00+08:00`) / 1000);
  if (!Number.isFinite(start) || !Number.isFinite(next)) throw new Error("月份超出可处理的日期范围");
  const end = Math.min(next - 1, Math.floor(now.getTime() / 1000));
  return {
    month,
    start,
    end,
    startLabel: `${month}-01`,
    endLabel: new Date(end * 1000).toLocaleDateString("zh-CN", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).replace(/\//g, "-")
  };
}

function dateRange(date, now = new Date()) {
  validateRequestedDate(date, now);
  const start = Date.parse(`${date}T00:00:00+08:00`) / 1000;
  return {
    month: date.slice(0, 7), start,
    end: Math.min(start + 86400 - 1, Math.floor(now.getTime() / 1000)),
    startLabel: date, endLabel: date
  };
}

function currentMonthShanghai(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit"
  }).formatToParts(now);
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

function apiIdValue(id) {
  const text = asText(id);
  const number = Number(text);
  return /^\d+$/.test(text) && Number.isSafeInteger(number) ? number : text;
}

function relationEqualCondition(attr, id) {
  return { attr, value: [apiIdValue(id)], symbol: "equal" };
}

function followOpportunityConditions(range, opportunityId) {
  if (!asText(opportunityId)) throw new Error("查询商机跟进时必须提供商机 dataId");
  return [...dateConditions("date_1", range), relationEqualCondition("text_5", opportunityId)];
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

function retryBackoffMs(attempt, random = Math.random) {
  return Math.min(5000, 250 * (2 ** Math.max(0, Number(attempt) || 0))) + Math.floor(random() * 200);
}

function isRetryableHttpStatus(status) {
  return [408, 425, 429, 500, 502, 503, 504].includes(Number(status));
}

function isRetryableApiMessage(message) {
  return /(?:20\s*次\s*\/\s*秒|请求频率|限流|系统繁忙|服务暂不可用|请求超时)/i.test(String(message || ""));
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
    } catch (error) {
      if (attempt < 5) {
        await new Promise((resolve) => setTimeout(resolve, retryBackoffMs(attempt)));
        continue;
      }
      throw new Error("销帮帮接口网络请求持续失败", { cause: error });
    } finally {
      clearTimeout(timer);
    }
    if (isRetryableHttpStatus(response.status) && attempt < 5) {
      await new Promise((resolve) => setTimeout(resolve, retryBackoffMs(attempt)));
      continue;
    }
    if (!response.ok) throw new Error(`销帮帮接口 HTTP ${response.status}`);
    let json;
    try {
      json = await response.json();
    } catch (error) {
      if (attempt < 5) {
        await new Promise((resolve) => setTimeout(resolve, retryBackoffMs(attempt)));
        continue;
      }
      throw new Error("销帮帮接口持续返回无效 JSON", { cause: error });
    }
    if (json && json.success === true) return json.result || {};
    const message = asText(json && json.msg) || "未知错误";
    if (isRetryableApiMessage(message) && attempt < 5) {
      await new Promise((resolve) => setTimeout(resolve, retryBackoffMs(attempt)));
      continue;
    }
    throw new Error(`销帮帮接口返回失败：${message}`);
  }
  throw new Error("销帮帮接口请求超过限流重试次数");
}

function optionalPaginationInteger(result, key) {
  const raw = result && result[key];
  if (raw === undefined || raw === null || raw === "") return null;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`分页字段 ${key} 不是有效的非负整数`);
  return value;
}

function paginationRows(result, listKey, page) {
  if (!result || typeof result !== "object" || !Array.isArray(result[listKey])) {
    throw new Error(`分页第 ${page} 页缺少数组字段 ${listKey}`);
  }
  return result[listKey];
}

function paginationPlan(result, listKey = "list", requestedPageSize = LIST_PAGE_SIZE, maxPages = MAX_LIST_PAGES) {
  if (!Number.isSafeInteger(requestedPageSize) || requestedPageSize <= 0) throw new Error("分页 pageSize 必须为正整数");
  if (!Number.isSafeInteger(maxPages) || maxPages <= 0) throw new Error("分页安全上限必须为正整数");
  const firstRows = paginationRows(result, listKey, 1);
  const totalCount = optionalPaginationInteger(result, "totalCount");
  const declaredTotalPage = optionalPaginationInteger(result, "totalPage");
  const declaredPageSize = optionalPaginationInteger(result, "pageSize");
  if (declaredPageSize === 0) throw new Error("分页字段 pageSize 不能为 0");
  if (declaredTotalPage === 0 && (firstRows.length || (totalCount !== null && totalCount > 0))) {
    throw new Error("分页元数据 totalPage=0 与返回记录不一致");
  }

  let totalPages = null;
  let effectivePageSize = declaredPageSize || requestedPageSize;
  if (declaredTotalPage !== null) {
    totalPages = Math.max(1, declaredTotalPage);
  } else if (totalCount !== null) {
    if (totalCount > 0 && firstRows.length === 0) throw new Error("分页元数据显示存在记录，但第 1 页为空");
    if (totalCount > firstRows.length && firstRows.length > 0 && firstRows.length < effectivePageSize) {
      effectivePageSize = firstRows.length;
    }
    totalPages = Math.max(1, Math.ceil(totalCount / effectivePageSize));
  }
  if (totalPages !== null && totalPages > maxPages) {
    throw new Error(`分页总页数 ${totalPages} 超过安全上限 ${maxPages}，拒绝返回可能截断的数据`);
  }
  if (totalCount !== null && firstRows.length > totalCount) {
    throw new Error(`分页第 1 页返回 ${firstRows.length} 条，超过 totalCount=${totalCount}`);
  }
  return { firstRows, totalCount, declaredTotalPage, totalPages, effectivePageSize, maxPages };
}

function assertStablePagination(result, plan, page) {
  const totalCount = optionalPaginationInteger(result, "totalCount");
  const totalPage = optionalPaginationInteger(result, "totalPage");
  if (plan.totalCount !== null && totalCount !== null && totalCount !== plan.totalCount) {
    throw new Error(`分页过程中 totalCount 从 ${plan.totalCount} 变为 ${totalCount}`);
  }
  if (plan.declaredTotalPage !== null && totalPage !== null && totalPage !== plan.declaredTotalPage) {
    throw new Error(`分页过程中 totalPage 从 ${plan.declaredTotalPage} 变为 ${totalPage}`);
  }
  return paginationRows(result, plan.listKey, page);
}

async function listAll(endpoint, payload, listKey = "list") {
  const requestPage = (page) => xbbPost(endpoint, Object.assign({}, payload, { page, pageSize: LIST_PAGE_SIZE }));
  const first = await requestPage(1);
  const plan = Object.assign(paginationPlan(first, listKey), { listKey });
  const rows = plan.firstRows.slice();

  if (plan.totalPages !== null) {
    for (let page = 2; page <= plan.totalPages; page += 1) {
      const pageRows = assertStablePagination(await requestPage(page), plan, page);
      if (!pageRows.length) throw new Error(`分页元数据显示共 ${plan.totalPages} 页，但第 ${page} 页为空`);
      rows.push(...pageRows);
    }
  } else {
    let page = 1;
    let pageRows = plan.firstRows;
    while (pageRows.length) {
      if (page >= plan.maxPages) {
        throw new Error(`分页未提供 totalPage/totalCount，且达到安全上限 ${plan.maxPages} 页，拒绝返回可能截断的数据`);
      }
      page += 1;
      pageRows = paginationRows(await requestPage(page), listKey, page);
      rows.push(...pageRows);
    }
  }

  if (plan.totalCount !== null && rows.length !== plan.totalCount) {
    throw new Error(`分页完整性校验失败：返回 ${rows.length} 条，totalCount=${plan.totalCount}`);
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

function normalizeDomains(value) {
  const requested = (Array.isArray(value) ? value : asText(value).split(",")).map(asText).filter(Boolean);
  if (!requested.length) return [...ALLOWED_DOMAINS];
  const domains = [...new Set(requested)];
  for (const domain of domains) if (domain !== "all" && !ALLOWED_DOMAINS.has(domain)) throw new Error(`不支持的数据域：${domain}`);
  if (domains.includes("all") && domains.length !== 1) throw new Error("all 不能与其他数据域同时使用");
  if (domains[0] === "all") return [...ALLOWED_DOMAINS];
  return domains;
}

function collectionsForDomains(value) {
  const domains = normalizeDomains(value);
  return new Set(domains.flatMap((domain) => DOMAIN_COLLECTIONS[domain]));
}

async function loadMetadata(collections = new Set(Object.keys(FORM))) {
  const entries = await Promise.all(Object.entries(FORM).filter(([name]) => collections.has(name)).map(async ([name, formId]) => {
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

async function loadContractDetails(records) {
  return Promise.all(records.map((record) => xbbPost(ENDPOINT.contractDetail, {
    dataId: record.dataId,
    queryFlag: 0
  })));
}

function uniqueRecordsByDataId(records) {
  const seen = new Set();
  return records.filter((record) => {
    const id = asText(record && record.dataId);
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

async function loadContractsByRelation(attr, ids) {
  const unique = Array.from(new Set(ids.map(asText).filter(Boolean)));
  const rows = [];
  for (const id of unique) {
    rows.push(...await listAll(ENDPOINT.contract, {
      formId: FORM.courseOrders,
      conditions: [relationEqualCondition(attr, id)],
      viewApproval: 0
    }));
  }
  return uniqueRecordsByDataId(rows);
}

async function loadProducts(ids) {
  const unique = Array.from(new Set(ids.map(asText).filter(Boolean)));
  const rows = [];
  for (let index = 0; index < unique.length; index += 50) {
    const batch = unique.slice(index, index + 50).map(apiIdValue);
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
  for (const id of unique) {
    rows.push(...await listAll(ENDPOINT.paas, {
      formId,
      conditions: [relationEqualCondition(attr, id)],
      viewApproval: 0
    }));
  }
  return rows;
}

async function loadFollowsByOpportunity(range, opportunityIds) {
  const unique = Array.from(new Set(opportunityIds.map(asText).filter(Boolean)));
  const rows = [];
  for (const opportunityId of unique) {
    rows.push(...await listAll(ENDPOINT.follow, {
      conditions: followOpportunityConditions(range, opportunityId),
      viewApproval: 0
    }));
  }
  return uniqueRecordsByDataId(rows);
}

function normalizeUsers(users) {
  const seen = new Set();
  return users.filter((user) => {
    const id = asText(user && user.userId);
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  }).map((user) => ({
    userId: asText(user.userId),
    name: asText(user.name) || "未命名员工",
    departments: (user.departmentList || []).map((department) => ({
      id: department.id,
      name: asText(department.name),
      isLeader: Number(department.isLeader) || 0
    })).filter((department) => department.name)
  }));
}

async function loadUserDirectory() {
  return normalizeUsers(await listAll(ENDPOINT.user, {}, "userList"));
}

async function loadDepartments(ids) {
  const unique = Array.from(new Set(ids.map(asText).filter(Boolean)));
  const departments = [];
  for (let index = 0; index < unique.length; index += 100) {
    const departmentIdIn = unique.slice(index, index + 100).map(apiIdValue);
    departments.push(...await listAll(ENDPOINT.department, { departmentIdIn }, "depList"));
  }
  return departments.map((department) => ({
    id: asText(department.id),
    name: asText(department.name)
  })).filter((department) => department.id && department.name);
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

function normalizeValue(collection, attr, raw, schema, selectedFields = null) {
  if (raw === undefined || raw === null || raw === "") return null;
  const subfields = selectedFields?.[`${collection}.${attr}`] || SUBTABLE_ALLOWLIST[collection]?.[attr];
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
        const value = normalizeValue(collection, `${attr}.${subfield}`, values[subfield], schema, selectedFields);
        if (value === null || value === "" || (Array.isArray(value) && !value.length)) continue;
        normalized[subfield] = value;
      }
      return Object.keys(normalized).length ? normalized : null;
    }).filter(Boolean);
  }
  const key = `${collection}.${attr}`;
  if (key === "performance.array_4.text_1" && typeof raw === "string" && !/^\d+$/.test(raw.trim())) return redactText(raw);
  if (RELATION_FIELDS.has(key)) return normalizeRelation(raw);
  if (REDACTED_TEXT_FIELDS.has(key)) return redactText(raw).slice(0, 500);
  const field = schema && schema.get(attr);
  if (field && field.items && field.items.size) return decode(schema, attr, raw);
  if (Array.isArray(raw)) return raw.map((item) => normalizeValue(collection, attr, item, null));
  if (raw && typeof raw === "object") return redactText(raw.name || raw.text || raw.value || raw.dataId || "");
  if (typeof raw === "string") return redactText(raw);
  return raw;
}

function fieldCatalog(collection, schema, selectedFields = null) {
  const catalog = {};
  for (const attr of selectedFields?.[collection] || FIELD_ALLOWLIST[collection] || []) {
    const field = schema && schema.get(attr);
    catalog[attr] = {
      label: field ? field.name : (SYSTEM_LABELS[attr] || attr),
      options: field ? Object.fromEntries(field.items) : {}
    };
    for (const subfield of selectedFields?.[`${collection}.${attr}`] || SUBTABLE_ALLOWLIST[collection]?.[attr] || []) {
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

function normalizeRecord(collection, record, schema, selectedFields = null) {
  const rawId = asText(record.dataId || record.serialNo || `${record.addTime}:${record.updateTime}`);
  const evidenceRef = publicId(collection, `${FORM[collection] || collection}:${rawId}`);
  const fields = {};
  for (const attr of selectedFields?.[collection] || FIELD_ALLOWLIST[collection] || []) {
    const value = normalizeValue(collection, attr, record[attr], schema, selectedFields);
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

function resolveLabelCondition(schema, attr, label) {
  const options = [...(schema?.get(attr)?.items || [])];
  if (!options.length) return relationEqualCondition(attr, label);
  let matches = options.filter(([, text]) => text === label);
  if (!matches.length) matches = options.filter(([, text]) => text.includes(label));
  if (matches.length !== 1) throw new Error("指定公司未能唯一识别，请提供准确公司名称；未扩大查询范围。");
  return relationEqualCondition(attr, matches[0][0]);
}

async function buildLiveDataset(month, domains = "all", demand = {}) {
  const date = validateDateScope(demand.date, [month], normalizeDomains(domains));
  const range = date ? dateRange(date) : monthRange(month);
  const metrics = demand.metrics ? validateMetrics(demand.metrics, normalizeDomains(domains)) : null;
  const required = metrics ? sourceCollections(metrics) : collectionsForDomains(domains);
  const metadata = await loadMetadata(required);
  let resolvedCompany = null;
  const identityUsers = demand.person ? await loadUserDirectory() : [];
  const personResolution = resolveEntity(demand.person, identityUsers.map((user) => ({ ...user, id: user.userId })), "person");
  const personMatches = personResolution.status === "resolved"
    ? identityUsers.filter((user) => user.userId === personResolution.resolved.id) : [];
  if (demand.person && personResolution.status !== "resolved") {
    // Return directory evidence for clarification before reading any business
    // records. A misspelled/ambiguous name is not a transport failure or zero sales.
    const candidateIds = new Set(personResolution.candidates.map((user) => user.id));
    return {
      month, ...(date ? { date } : {}), range, loadedAt: new Date().toISOString(), metadata, metrics,
      collections: Object.fromEntries([...required].filter((name) => name !== "user").map((name) => [name, []])),
      users: identityUsers.filter((user) => candidateIds.has(user.userId))
    };
  }
  if (demand.person && !required.has("opportunity")) throw new Error("当前数据口径不支持按此销售筛选，未扩大查询。");
  let organizerCondition = null;
  let knownDepartments = [];
  if (demand.company && required.has("course")) {
    const departments = await listAll(ENDPOINT.department, {}, "depList");
    knownDepartments = departments.map((department) => ({ id: asText(department.id), name: asText(department.name) }));
    let matches = departments.filter((department) => department.name === demand.company);
    if (!matches.length) matches = departments.filter((department) => asText(department.name).includes(demand.company));
    if (matches.length !== 1) throw new Error("课程举办方未能唯一识别，请提供准确公司名称；未读取集团课程。");
    organizerCondition = relationEqualCondition("text_5", matches[0].id);
    resolvedCompany = matches[0].name;
  }
  const conditions = (collection, attr) => {
    const result = dateConditions(attr, range);
    if (demand.company) {
      const companyField = collection === "performance" ? "text_63" : collection === "oppOrder"
        ? (metadata.oppOrder?.get("text_6")?.name === "所属公司" && !metadata.oppOrder?.has("text_31") ? "text_6" : "text_31")
          : collection === "opportunity" ? "text_11" : null;
      if (companyField) {
        const condition = resolveLabelCondition(metadata[collection], companyField, demand.company);
        result.push(condition);
        const label = metadata[collection]?.get(companyField)?.items?.get(String(condition.value[0]));
        if (label) resolvedCompany = label;
      }
      if (collection === "course") result.push(organizerCondition);
    }
    if (collection === "opportunity" && demand.person) result.push(relationEqualCondition("creatorId", personMatches[0].userId));
    if (collection === "opportunity" && metrics?.length === 1 && metrics[0] === "opportunities.wins") result.push(relationEqualCondition("text_17", "5738a7bf4bed4cdb95ea862f0a58934e"));
    return result;
  };
  const loadIf = (collection, loader) => required.has(collection) ? loader() : Promise.resolve([]);
  const [performanceListRaw, oppOrdersRaw, coursesRaw, opportunitiesRaw] = await Promise.all([
    loadIf("performance", () => loadNamedCollection("performance", FORM.performance, () => listAll(ENDPOINT.contract, { formId: FORM.performance, conditions: conditions("performance", "date_1"), viewApproval: 0 }))),
    loadIf("oppOrder", () => loadNamedCollection("oppOrder", FORM.oppOrder, () => listAll(ENDPOINT.paas, { formId: FORM.oppOrder, conditions: conditions("oppOrder", "date_1"), viewApproval: 0 }))),
    loadIf("course", () => loadNamedCollection("course", FORM.course, () => listAll(ENDPOINT.paas, { formId: FORM.course, conditions: conditions("course", "date_1"), viewApproval: 0 }))),
    loadIf("opportunity", () => loadNamedCollection("opportunity", FORM.opportunity, () => listAll(ENDPOINT.opportunity, { formId: FORM.opportunity, conditions: conditions("opportunity", "addTime"), viewApproval: 0 })))
  ]);

  // Reject out-of-scope base responses before any dependent detail or join.
  // Missing scalar list fields can legitimately require contract/detail.
  const checkBaseScope = (rows, collection, dateAttr) => {
    if (!metrics && !date) return;
    for (const item of rows) {
      const row = flattenRecord(item);
      if (row[dateAttr] != null && !inRange(row, dateAttr, range)) throw new Error("来源返回了范围外日期，已停止关联查询。");
      for (const condition of conditions(collection, dateAttr).filter((c) => c.symbol === "equal")) {
        if (row[condition.attr] != null && relationId(row[condition.attr]) !== String(condition.value[0])) throw new Error("来源未遵守实体或阶段过滤，已停止关联查询。");
      }
    }
  };
  checkBaseScope(performanceListRaw, "performance", "date_1");
  checkBaseScope(coursesRaw, "course", "date_1");
  checkBaseScope(oppOrdersRaw, "oppOrder", "date_1");
  checkBaseScope(opportunitiesRaw, "opportunity", "addTime");
  const performanceRaw = performanceListRaw.length
    ? await loadNamedCollection("performance-detail", FORM.performance, () => loadContractDetails(performanceListRaw))
    : [];
  if (date) {
    checkBaseScope(performanceRaw, "performance", "date_1");
    if (performanceRaw.some((item) => !inRange(flattenRecord(item), "date_1", range))) throw new Error("来源详情缺少有效单日日期，无法确认查询范围。");
  }
  const courseBase = coursesRaw.map(flattenRecord).filter((row) => inRange(row, "date_1", range));
  const courseIds = courseBase.map((row) => row.dataId).filter(Boolean);
  const courseIdSet = new Set(courseIds.map(asText));
  const opportunity = uniqueRecordsByDataId(opportunitiesRaw).map(flattenRecord).filter((row) => inRange(row, "addTime", range));
  const opportunityIds = opportunity.map((row) => row.dataId).filter(Boolean);
  const [bookingsRaw, deliveryBookingsRaw, courseOrderListRaw] = await Promise.all([
    required.has("booking") && courseIds.length
      ? loadNamedCollection("booking", FORM.booking, () => loadPaasByRelation(FORM.booking, "text_5", courseIds))
      : Promise.resolve([]),
    required.has("deliveryBooking") && courseIds.length
      ? loadNamedCollection("deliveryBooking", FORM.deliveryBooking, () => loadPaasByRelation(FORM.deliveryBooking, "text_2", courseIds))
      : Promise.resolve([]),
    required.has("courseOrders") && courseIds.length
      ? loadNamedCollection("courseOrders", FORM.courseOrders, () => loadContractsByRelation("text_28", courseIds))
      : Promise.resolve([])
  ]);
  const courseOrderDetailsRaw = courseOrderListRaw.length
    ? await loadNamedCollection("courseOrders-detail", FORM.courseOrders, () => Promise.all(courseOrderListRaw.map(async (record) => {
      const row = flattenRecord(record);
      if (metrics && row.num_1 != null && row.text_28 != null) return record;
      return (await loadContractDetails([record]))[0];
    })))
    : [];

  const performance = performanceRaw.map(flattenRecord).filter((row) => inRange(row, "date_1", range));
  const courseOrders = courseOrderDetailsRaw.map(flattenRecord).filter((row) => courseIdSet.has(relationId(row.text_28)));
  const oppOrder = oppOrdersRaw.map(flattenRecord).filter((row) => inRange(row, "date_1", range));
  const booking = uniqueRecordsByDataId(bookingsRaw).map(flattenRecord).filter((row) => courseIdSet.has(relationId(row.text_5)));
  const deliveryBooking = uniqueRecordsByDataId(deliveryBookingsRaw).map(flattenRecord).filter((row) => courseIdSet.has(relationId(row.text_2)));
  const followsRaw = required.has("follow") && opportunityIds.length
    ? await loadNamedCollection("follow", FORM.follow, () => loadFollowsByOpportunity(range, opportunityIds))
    : [];
  const follow = followsRaw.map(flattenRecord).filter((row) => inRange(row, "date_1", range));

  const productIds = [
    ...performance.flatMap((row) => parseMaybeArray(row.array_4).map((item) => relationId(item && item.text_1))),
    ...oppOrder.map((row) => relationId(row.text_10))
  ];
  const courseOrganizerIds = courseBase.map((row) => asText(row.text_5)).filter((value) => /^\d+$/.test(value));
  const [product, users, departments] = await Promise.all([
    required.has("product") ? loadProducts(productIds) : [],
    demand.person ? personMatches : required.has("user") ? loadUserDirectory() : [],
    required.has("course") ? loadDepartments(courseOrganizerIds.filter((id) => !knownDepartments.some((department) => department.id === id))) : []
  ]);
  const departmentById = new Map([...knownDepartments, ...departments].map((department) => [department.id, department.name]));
  const course = courseBase.map((row) => {
    const organizerId = asText(row.text_5);
    return departmentById.has(organizerId) ? { ...row, text_5: departmentById.get(organizerId) } : row;
  });

  const available = { performance, courseOrders, oppOrder, course, booking, deliveryBooking, product, opportunity, follow };
  const collections = Object.fromEntries([...required].filter((name) => name !== "user").map((name) => [name, available[name] || []]));
  return {
    month,
    ...(date ? { date } : {}),
    range,
    loadedAt: new Date().toISOString(),
    metadata,
    metrics,
    resolvedScope: { company: resolvedCompany },
    collections,
    users
  };
}

function buildSourceBundle(dataset) {
  const records = {};
  const fields = {};
  const selectedFields = dataset.metrics ? sourceFields(dataset.metrics) : null;
  for (const [collection, rows] of Object.entries(dataset.collections)) {
    const schema = dataset.metadata[collection];
    records[collection] = rows.map((row) => normalizeRecord(collection, row, schema, selectedFields));
    fields[collection] = fieldCatalog(collection, schema, selectedFields);
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
    schemaVersion: "3.1",
    skill: "xbb-executive-analyst",
    mode: "live-readonly-source",
    month: dataset.month,
    ...(dataset.date ? { date: dataset.date } : {}),
    ...(dataset.resolvedScope ? { resolvedScope: dataset.resolvedScope } : {}),
    range: dataset.range,
    refreshedAt: dataset.loadedAt,
    provenance: {
      live: true,
      readOnly: true,
      dataSource: "xbb-openapi",
      fetchedBy: "xbb-executive-analyst/scripts/export-live-data.js",
      formIds: Object.fromEntries(Object.entries(FORM).filter(([name]) => Object.hasOwn(records, name))),
      endpoints: [
        "/pro/v2/api/paas/list",
        "/pro/v2/api/contract/list",
        "/pro/v2/api/contract/detail",
        "/pro/v2/api/opportunity/list",
        "/pro/v2/api/communicate/list",
        "/pro/v2/api/product/list",
        "/pro/v2/api/user/list",
        "/pro/v2/api/department/list",
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
    if (key === "--request-stdin") {
      if (parsed["request-stdin"] === true) throw new Error("--request-stdin 不能重复提供");
      parsed["request-stdin"] = true;
    } else if (key === "--month" || key === "--output" || key === "--domains" || key === "--isolation-token") {
      if (index + 1 >= argv.length || String(argv[index + 1]).startsWith("--")) throw new Error(`参数缺少值：${key}`);
      if (Object.hasOwn(parsed, key.slice(2))) throw new Error(`参数不能重复：${key}`);
      parsed[key.slice(2)] = argv[index + 1];
      index += 1;
    } else {
      throw new Error(`不支持的参数：${key}`);
    }
  }
  if (!parsed.output) throw new Error("必须提供 --output");
  if (parsed["request-stdin"] && (parsed.month !== undefined || parsed.domains !== undefined)) {
    throw new Error("--request-stdin 不能与 --month 或 --domains 同时使用");
  }
  if (parsed["isolation-token"] !== undefined && !/^[a-f0-9]{64}$/.test(parsed["isolation-token"])) {
    throw new Error("runner isolation token 格式无效。");
  }
  return parsed;
}

function readScopeRequestFromStdin() {
  const raw = fs.readFileSync(0);
  if (!raw.length || raw.length > 8192) throw new Error("stdin 查询范围缺失或超过安全大小");
  let request;
  try { request = JSON.parse(raw.toString("utf8")); } catch (_) { throw new Error("stdin 查询范围不是有效 JSON"); }
  if (!request || typeof request !== "object" || Array.isArray(request)
      || Object.keys(request).some((key) => !["domains", "month", "date", "metrics", "company", "person"].includes(key))) {
    throw new Error("stdin 查询范围不符合精确 schema");
  }
  if (typeof request.month !== "string" || !Array.isArray(request.domains)
      || request.domains.some((value) => typeof value !== "string")) {
    throw new Error("stdin 查询范围字段类型无效");
  }
  if (request.metrics) validateMetrics(request.metrics, request.domains);
  if ([request.company, request.person].some((value) => value !== undefined && value !== null && typeof value !== "string")) throw new Error("公司或人员字段类型无效");
  return request;
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
  const request = args["request-stdin"]
    ? readScopeRequestFromStdin()
    : { month: args.month || currentMonthShanghai(), domains: args.domains || "all" };
  const dataset = await buildLiveDataset(request.month, request.domains, request);
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
  apiIdValue,
  collectionsForDomains,
  buildLiveDataset,
  buildSourceBundle,
  followOpportunityConditions,
  normalizeDomains,
  monthRange,
  dateRange,
  paginationPlan,
  isRetryableApiMessage,
  isRetryableHttpStatus,
  relationEqualCondition,
  retryBackoffMs,
  uniqueRecordsByDataId,
  redactText
};
