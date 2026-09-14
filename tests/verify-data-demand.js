"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const { inferMetrics, validateMetrics, bindQueryDemand, sourceCollections, projectFacts } = require("../shared/xbb/data-demand.js");
const { buildModelFactView } = require("../shared/xbb/model-fact-view.js");
const { validateRequest, createToolGatewayForTest } = require("../shared/xbb/tool-gateway.js");
const { buildFactPack } = require("../shared/xbb/build-fact-pack.js");
const { parseDate, parseMonths, planFastQuery, shanghaiDate } = require("../shared/xbb/fast-query-plan.js");

async function run() {
  const cases = [
    ["今天业绩怎么样", ["performance"], ["performance.total", "performance.ranking"], ["performance"]],
    ["今天业绩如何", ["performance"], ["performance.total", "performance.ranking"], ["performance"]],
    ["本月业绩怎么样及走势", ["performance"], ["performance.total", "performance.ranking", "performance.trend"], ["performance"]],
    ["佛山公司今天业绩怎么样", ["performance"], ["performance.total"], ["performance"]],
    ["佛山分公司今天业绩怎么样", ["performance"], ["performance.total"], ["performance"]],
    ["佛山分公司今天业绩多少", ["performance"], ["performance.total"], ["performance"]],
    ["今天业绩金额怎么样", ["performance"], ["performance.total"], ["performance"]],
    ["今天业绩数量怎么样", ["performance"], ["performance.total"], ["performance"]],
    ["今天业绩怎么样，只要总数", ["performance"], ["performance.total"], ["performance"]],
    ["集团本月业绩按公司排名并区分课程和咨询占比", ["performance"], ["performance.ranking", "performance.mix"], ["performance"]],
    ["集团各公司当月门票数量排名", ["product-sales"], ["tickets.ranking"], ["oppOrder"]],
    ["集团各公司当月商业操盘和复训数量排名", ["product-sales"], ["commercial.ranking"], ["performance", "product"]],
    ["佛山公司这个月开了多少堂课", ["courses"], ["courses.count"], ["course"]],
    ["佛山公司这个月开了多少堂课，参课老板多少，成交金额多少", ["courses"], ["courses.count", "courses.bosses", "courses.amount"], ["course", "booking", "courseOrders"]],
    ["集团本月创建多少商机", ["opportunities"], ["opportunities.count"], ["opportunity"]],
    ["集团本月赢单商机数量是多少，不要跟进", ["opportunities"], ["opportunities.wins"], ["opportunity"]],
    ["集团本月商机跟进质量和重新激活建议", ["opportunities"], ["opportunities.quality"], ["opportunity", "follow"]]
  ];
  for (const [question, domains, expected, collections] of cases) {
    const metrics = inferMetrics(question, domains);
    assert.deepEqual(metrics, [...expected].sort());
    assert.deepEqual([...sourceCollections(metrics)].sort(), [...collections].sort());
  }
  assert.throws(() => validateMetrics(["tickets.ranking"], ["product-sales", "performance"]), /完全对应/);
  const input = { months: ["2026-09"], domains: ["opportunities"], metrics: ["opportunities.quality"] };
  assert.throws(() => bindQueryDemand(input, "2026年9月集团创建多少商机"), /超出用户所问/);
  assert.throws(() => bindQueryDemand({ ...input, months: ["2026-08"], metrics: ["opportunities.count"] }, "2026年9月集团创建多少商机"), /月份/);
  assert.throws(() => bindQueryDemand({ months: ["2026-09"], domains: ["performance"] }, "2026年9月佛山公司业绩"), /指定了公司/);
  assert.deepEqual(bindQueryDemand({ months: ["2026-09"], domains: ["performance"] }, "今年公司的业绩怎么样").metrics, ["performance.ranking", "performance.total"]);
  assert.throws(() => bindQueryDemand({ months: ["2026-09"], domains: ["opportunities"], metrics: ["opportunities.count"] }, "2026年9月集团创建多少商机\n改成8月", { months: ["2026-08"], domains: ["opportunities"] }), /月份/);
  assert.throws(() => bindQueryDemand(input, "2026年9月集团创建多少商机并分析跟进质量\n只要创建数量"), /指标/);
  assert.deepEqual(validateRequest({ months: ["2026-09"], domains: ["product-sales"], metrics: ["tickets.ranking"] }).metrics, ["tickets.ranking"]);
  const dateNow = new Date("2026-09-13T16:00:00Z");
  const dayPlan = { months: ["2026-09"], domains: ["performance"], date: "2026-09-14" };
  assert.equal(shanghaiDate(dateNow), "2026-09-14");
  assert.deepEqual(planFastQuery("今天业绩怎么样", dateNow), dayPlan);
  for (const phrase of ["2026-09-14", "2026年9月14日", "9月14号", "今年9月14日", "今日"]) assert.equal(parseDate(phrase, dateNow), "2026-09-14");
  assert.equal(parseDate("昨天业绩", dateNow), "2026-09-13");
  assert.deepEqual(parseMonths("2026年9月14日业绩", dateNow), ["2026-09"]);
  for (const invalid of ["2026-02-30业绩", "2026-09-15业绩", "9月1日到3日业绩", "今天和昨天业绩", "今天和本月业绩", "9月1日以来业绩", "最近7天业绩", "本周业绩"]) {
    assert.throws(() => planFastQuery(invalid, dateNow), /日期|单日|自然日/);
  }
  assert.throws(() => planFastQuery("今天商机创建数量", dateNow), /仅支持业绩/);
  assert.equal(validateRequest(dayPlan, dateNow).date, dayPlan.date);
  for (const invalid of [{ ...dayPlan, date: "2026-09-15" }, { ...dayPlan, months: ["2026-08"] }, { ...dayPlan, domains: ["courses"] }]) assert.throws(() => validateRequest(invalid, dateNow), /日期|单日/);
  assert.throws(() => bindQueryDemand({ months: ["2026-09"], domains: ["performance"] }, "今天业绩怎么样", dayPlan), /遗漏日期/);
  assert.throws(() => bindQueryDemand({ ...dayPlan, date: "2026-09-13" }, "今天业绩怎么样", dayPlan), /日期/);
  assert.throws(() => bindQueryDemand(dayPlan, "本月业绩怎么样", { months: ["2026-09"], domains: ["performance"] }), /日期/);
  assert.deepEqual(bindQueryDemand(dayPlan, "今天业绩怎么样", dayPlan).metrics, ["performance.ranking", "performance.total"]);
  assert.deepEqual(bindQueryDemand({ ...dayPlan, company: "佛山公司" }, "佛山公司今天业绩怎么样", dayPlan).metrics, ["performance.total"]);
  assert.deepEqual(bindQueryDemand({ ...dayPlan, company: "佛山分公司", metrics: ["performance.total"] }, "佛山分公司今天业绩怎么样", dayPlan).metrics, ["performance.total"]);
  assert.throws(() => bindQueryDemand({ ...dayPlan, company: "佛山公司", metrics: ["performance.total", "performance.ranking"] }, "佛山公司今天业绩怎么样", dayPlan), /指标/);
  const facts = { productSales: { ticketRanking: [{ company: "合成甲公司", ticketCount: 3 }], commercialRanking: [{ company: "合成乙公司", commercialCount: 7 }], companyProductMix: [], summary: {} },
    opportunities: { summary: { createdCount: 4, expectedAmount: 999, followCount: 2 }, opportunities: [{ followEvidence: [{ excerpt: "unrequested-content-sentinel" }] }] } };
  assert.deepEqual(projectFacts(facts, ["tickets.ranking"]).productSales.ticketRanking, [{ company: "合成甲公司", ticketCount: 3 }]);
  const view = buildModelFactView({ status: "ready", facts, scope: { domains: ["opportunities"] }, provenance: {} }, { metrics: ["opportunities.count"] });
  assert.equal(view.facts.opportunities.summary.createdCount, 4);
  assert.doesNotMatch(JSON.stringify(view), /unrequested-content-sentinel|expectedAmount|followCount|ticketRanking/);

  // Inject the HTTP boundary and run the actual exporter. Every call is recorded
  // so an extra table or follow-up request fails even if its rows are discarded.
  const before = { base: process.env.XBB_API_BASE, corp: process.env.XBB_CORPID, token: process.env.XBB_API_TOKEN, fetch: global.fetch };
  process.env.XBB_API_BASE = "https://synthetic.invalid"; process.env.XBB_CORPID = "synthetic"; process.env.XBB_API_TOKEN = "synthetic";
  const modulePath = require.resolve("../shared/xbb/export-live-data.js");
  delete require.cache[modulePath];
  const { buildLiveDataset, buildSourceBundle, monthRange, dateRange } = require(modulePath);
  const cutoff = new Date("2026-09-14T01:00:00Z");
  assert.equal(monthRange("2026-09", cutoff).end, cutoff.getTime() / 1000, "本月不能拉取刷新时点以后的预签记录");
  assert.deepEqual(dateRange("2026-09-13", cutoff), { month: "2026-09", start: Date.parse("2026-09-13T00:00:00+08:00") / 1000, end: Date.parse("2026-09-13T23:59:59+08:00") / 1000, startLabel: "2026-09-13", endLabel: "2026-09-13" });
  assert.equal(dateRange("2026-09-14", cutoff).end, cutoff.getTime() / 1000, "今天必须截止实际刷新时点");
  const calls = [];
  const stamp = Date.parse("2026-09-02T00:00:00+08:00") / 1000;
  global.fetch = async (url, options) => {
    const body = JSON.parse(options.body); calls.push({ path: new URL(url).pathname, body });
    let result;
    if (url.endsWith("/form/get")) result = { explainList: [{ attr: "text_11", attrName: "所属公司", items: [{ value: "company-a", text: "合成甲公司" }] },
      { attr: "text_31", attrName: "所属公司" }, { attr: "array_4", attrName: "产品明细" }] };
    else if (url.endsWith("/opportunity/list")) result = { list: [{ dataId: "opp1", addTime: stamp, data: { text_11: "company-a", num_1: 999, text_1: "not-needed" } }], totalCount: 1 };
    else if (url.endsWith("/paas/list")) result = { list: [{ dataId: "ticket1", addTime: stamp, data: { date_1: stamp, text_31: "合成甲公司", array_4: [{ text_1: "门票", num_3: 3, num_5: 999 }], num_5: 999 } }], totalCount: 1 };
    else throw new Error(`Unexpected source request: ${new URL(url).pathname}`);
    return { ok: true, status: 200, json: async () => ({ success: true, result }) };
  };
  try {
    const source = buildSourceBundle(await buildLiveDataset("2026-09", ["opportunities"], { metrics: ["opportunities.count"], company: "合成甲公司" }));
    assert.deepEqual(calls.map((call) => call.path), ["/pro/v2/api/form/get", "/pro/v2/api/opportunity/list"]);
    assert.ok(calls[1].body.conditions.some((condition) => condition.attr === "text_11" && condition.value[0] === "company-a"));
    assert.equal(Object.hasOwn(source.records, "follow"), false);
    assert.deepEqual(Object.keys(source.records.opportunity[0].fields), ["text_11"]);
    calls.length = 0;
    const tickets = buildSourceBundle(await buildLiveDataset("2026-09", ["product-sales"], { metrics: ["tickets.ranking"] }));
    assert.deepEqual(calls.map((call) => [call.path, call.body.formId]), [["/pro/v2/api/form/get", 6707824], ["/pro/v2/api/paas/list", 6707824]]);
    assert.equal(Object.hasOwn(tickets.records, "performance"), false);
    assert.equal(Object.hasOwn(tickets.records.oppOrder[0].fields, "num_5"), false);
    assert.equal(Object.hasOwn(tickets.records.oppOrder[0].fields.array_4[0], "num_5"), false);
    assert.equal(projectFacts(buildFactPack(tickets, { domains: ["product-sales"] }).facts, ["tickets.ranking"]).productSales.ticketRanking[0].ticketCount, 3);

    calls.length = 0;
    const dailyMetrics = ["performance.total", "performance.ranking"];
    const dailyRequest = { months: ["2026-09"], domains: ["performance"], date: "2026-09-02", metrics: dailyMetrics };
    const dailyRows = [
      { dataId: "daily-a", data: { date_1: stamp, text_63: "合成甲公司", array_4: [{ num_5: 17, text_10: "unrequested-mix" }] } },
      { dataId: "daily-b", data: { date_1: stamp + 3600, text_63: "合成乙公司", array_4: [{ num_5: 9, text_10: "unrequested-mix" }] } }
    ];
    let outOfDayList = false, outOfDayDetail = false, missingDetailDate = false;
    global.fetch = async (url, options) => {
      const body = JSON.parse(options.body); calls.push({ path: new URL(url).pathname, body });
      let result;
      if (url.endsWith("/form/get")) result = { explainList: [] };
      else if (url.endsWith("/contract/list")) result = { list: outOfDayList ? [{ ...dailyRows[0], data: { ...dailyRows[0].data, date_1: stamp - 1 } }] : dailyRows, totalCount: outOfDayList ? 1 : 2 };
      else if (url.endsWith("/contract/detail")) {
        const row = dailyRows.find((item) => item.dataId === body.dataId);
        result = { ...row, data: { ...row.data, ...(outOfDayDetail ? { date_1: stamp - 1 } : missingDetailDate ? { date_1: null } : {}) } };
      } else throw new Error(`Unexpected daily dependency: ${new URL(url).pathname}`);
      return { ok: true, status: 200, json: async () => ({ success: true, result }) };
    };
    const dailySource = buildSourceBundle(await buildLiveDataset("2026-09", ["performance"], dailyRequest));
    assert.deepEqual(calls.map((call) => call.path), ["/pro/v2/api/form/get", "/pro/v2/api/contract/list", "/pro/v2/api/contract/detail", "/pro/v2/api/contract/detail"]);
    assert.deepEqual(calls[1].body.conditions, [{ attr: "date_1", value: [stamp], symbol: "greaterequal" }, { attr: "date_1", value: [stamp + 86400 - 1], symbol: "lessequal" }]);
    assert.deepEqual(Object.keys(dailySource.records).sort(), ["performance", "user"]);
    assert.equal(dailySource.date, dailyRequest.date);
    const dailyPack = buildFactPack(dailySource, { domains: ["performance"], date: dailyRequest.date });
    assert.equal(dailyPack.scope.date, dailyRequest.date);
    assert.equal(dailyPack.scope.currentMonthPartial, false);
    assert.equal(dailyPack.scope.currentDayPartial, false);
    const dailyView = buildModelFactView(dailyPack, dailyRequest);
    assert.equal(dailyView.scope.date, dailyRequest.date);
    assert.equal(dailyView.facts.performance.summary.total, 26);
    assert.deepEqual(dailyView.facts.performance.ranking.map((row) => row.total), [17, 9]);
    assert.doesNotMatch(JSON.stringify(dailyView.facts), /unrequested-mix|monthlyTrend|dailyTrend|courseShare/);
    assert.throws(() => buildFactPack(dailySource, { domains: ["performance"], date: "2026-09-03" }), /日期/);
    assert.throws(() => buildFactPack({ ...dailySource, range: monthRange("2026-09") }, { domains: ["performance"], date: dailyRequest.date }), /范围无效/);
    const monthlySource = { ...dailySource }; delete monthlySource.date;
    assert.throws(() => buildFactPack(monthlySource, { domains: ["performance"], date: dailyRequest.date }), /不能使用月累计/);
    const monthlyPack = buildFactPack(monthlySource, { domains: ["performance"] });
    const outputPaths = [];
    let returnMonthly = false;
    const gateway = createToolGatewayForTest({
      testOnlyPlatform: "linux", powershell: "synthetic-runner-never-spawned",
      execFile: async (_command, args, options) => {
        assert.equal(JSON.parse(options.stdinText).date, dailyRequest.date);
        assert.ok(!args.includes(dailyRequest.date), "日期只允许走 stdin，不可进入子进程命令行");
        const outputPath = args[args.indexOf("-OutputPath") + 1]; outputPaths.push(outputPath);
        fs.writeFileSync(outputPath, JSON.stringify(returnMonthly ? monthlyPack : dailyPack), "utf8");
        return { stdout: "", stderr: "" };
      }
    });
    assert.equal((await gateway(dailyRequest, { scope: "all" })).scope.date, dailyRequest.date);
    returnMonthly = true;
    await assert.rejects(gateway(dailyRequest, { scope: "all" }), (error) => /事实包日期/u.test(error.cause?.message || ""));
    assert.ok(outputPaths.every((outputPath) => !fs.existsSync(outputPath)), "成功或日期不匹配后都必须清理事实包");
    calls.length = 0; outOfDayList = true;
    await assert.rejects(buildLiveDataset("2026-09", ["performance"], dailyRequest), /范围外日期/);
    assert.equal(calls.some((call) => call.path.endsWith("/contract/detail")), false, "列表超出日期时不得读取关联详情");
    outOfDayList = false; outOfDayDetail = true;
    await assert.rejects(buildLiveDataset("2026-09", ["performance"], dailyRequest), /范围外日期/);
    outOfDayDetail = false; missingDetailDate = true;
    await assert.rejects(buildLiveDataset("2026-09", ["performance"], dailyRequest), /缺少有效单日日期/);

    calls.length = 0;
    global.fetch = async (url, options) => {
      const body = JSON.parse(options.body); calls.push({ path: new URL(url).pathname, body });
      let result;
      if (url.endsWith("/form/get")) result = { explainList: [] };
      else if (url.endsWith("/department/list")) result = { depList: [{ id: 101, name: "合成甲公司" }], totalCount: 1 };
      else if (url.endsWith("/paas/list") && body.formId === 7452529) result = { list: [{ dataId: 201, data: { date_1: stamp, text_5: 101, text_1: "合成课程" } }], totalCount: 1 };
      else if (url.endsWith("/paas/list") && body.formId === 7642173) result = { list: [
        { dataId: 301, data: { text_5: 201, text_22: "老板" } }, { dataId: 302, data: { text_5: 201, text_22: "经理" } }
      ], totalCount: 2 };
      else if (url.endsWith("/contract/list")) result = { list: [{ dataId: 401, data: { text_28: 201, num_1: 1200, date_1: stamp - 86400 * 40 } }], totalCount: 1 };
      else throw new Error(`Unexpected course dependency: ${new URL(url).pathname}`);
      return { ok: true, status: 200, json: async () => ({ success: true, result }) };
    };
    const courseMetrics = ["courses.count", "courses.bosses", "courses.amount"];
    const courseSource = buildSourceBundle(await buildLiveDataset("2026-09", ["courses"], { metrics: courseMetrics, company: "合成甲公司" }));
    assert.deepEqual(Object.keys(courseSource.records).sort(), ["booking", "course", "courseOrders", "user"]);
    assert.equal(calls.filter((call) => call.path.endsWith("/department/list")).length, 1, "已识别举办方不得重复查目录");
    const orderRequest = calls.find((call) => call.path.endsWith("/contract/list"));
    assert.deepEqual(orderRequest.body.conditions, [{ attr: "text_28", value: [201], symbol: "equal" }]);
    assert.equal(calls.some((call) => call.path.endsWith("/contract/detail")), false, "列表已提供关联金额时不得再拉完整详情");
    const courseFacts = projectFacts(buildFactPack(courseSource, { domains: ["courses"], company: "合成甲公司" }).facts, courseMetrics);
    assert.deepEqual(courseFacts.courses.summary, { courseCount: 1, bosses: 1, dealAmount: 1200 });
    assert.equal(Object.hasOwn(courseFacts.courses.summary, "bookedCustomers"), false);
    calls.length = 0;
    const counts = buildSourceBundle(await buildLiveDataset("2026-09", ["courses"], { metrics: ["courses.count"], company: "合成甲公司" }));
    assert.deepEqual(Object.keys(counts.records).sort(), ["course", "user"]);
    assert.equal(calls.some((call) => [7642173, 5614255, 7452855].includes(call.body.formId)), false);
  } finally {
    global.fetch = before.fetch;
    for (const [key, value] of [["XBB_API_BASE", before.base], ["XBB_CORPID", before.corp], ["XBB_API_TOKEN", before.token]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    delete require.cache[modulePath];
  }
  process.stdout.write(JSON.stringify({ success: true, synthetic: true, demandCases: cases.length, scopeAndProjection: true, actualExporterCallsVerified: true }) + "\n");
}
run().catch((error) => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
