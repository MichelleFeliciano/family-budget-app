"use strict";
// Run with:  node tests/run-tests.js      (Node 20+, no dependencies)
// Runs in Texas time on purpose: several bugs only show up in the evening or
// across daylight-saving changes.
process.env.TZ = "America/Chicago";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};
for (const f of ["js/calculations.js", "js/storage.js"]) vm.runInThisContext(read(f), { filename: f });

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const at = (iso) => { const [y, m, d] = iso.split("-").map(Number); return new Date(y, m - 1, d); };
const withNow = (isoUtc, fn) => {
  test.mock.timers.enable({ apis: ["Date"], now: new Date(isoUtc) });
  try { return fn(); } finally { test.mock.timers.reset(); }
};
const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64");

/* ------------------------------------------------------------------ */
test("dates: local evening must not roll over to tomorrow / next month", () => {
  // 8:00 pm CDT on Oct 31 is already Nov 1 in UTC.
  withNow("2026-11-01T01:00:00Z", () => {
    assert.equal(currentMonthKey(), "2026-10");
    assert.equal(todayISO(), "2026-10-31");
  });
});

test("dates: app.js never builds a user-facing date from UTC", () => {
  const hits = read("js/app.js").match(/toISOString\(\)\.slice\(0,\s*10\)/g) || [];
  assert.equal(hits.length, 0, `found ${hits.length} UTC-based date(s) in app.js`);
});

test("dates: addDays steps whole calendar days across daylight-saving changes", () => {
  assert.equal(ymd(addDays(at("2026-03-07"), 2)), "2026-03-09");
  assert.equal(addDays(at("2026-03-07"), 2).getHours(), 0);
  assert.equal(ymd(addDays(at("2026-10-31"), 2)), "2026-11-02");
  assert.equal(addDays(at("2026-10-31"), 2).getHours(), 0);
});

/* ------------------------------------------------------------------ */
test("money: sums are exact to the cent", () => {
  const txns = [0.1, 0.2].map((amount, i) => ({ id: "" + i, date: "2026-09-01", type: "expense", categoryId: "x", amount }));
  assert.equal(sumTransactions(txns, {}), 0.3);
  const thirds = [33.37, 33.37, 33.37].map((amount, i) => ({ id: "" + i, date: "2026-09-01", type: "expense", amount }));
  const totals = monthTotals({ transactions: [...thirds, { id: "i", date: "2026-09-02", type: "income", amount: 100.11 }], debts: [] }, "2026-09");
  assert.equal(formatMoney(totals.leftOver), "$0.00");
  assert.ok(totals.leftOver >= 0, "tiny float error made Left Over negative");
});

test("money: formatting", () => {
  assert.equal(formatMoney(1234567.891), "$1,234,567.89");
  assert.equal(formatMoney(-5), "-$5.00");
  assert.equal(formatMoney("abc"), "$0.00");
  assert.equal(formatMoney(-1e-14), "$0.00");
});

/* ------------------------------------------------------------------ */
test("debt payoff: formula agrees with a month-by-month simulation", () => {
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < 500; i++) {
    const P = Math.round(100 + rnd() * 20000), apr = Math.round(rnd() * 30 * 100) / 100;
    const r = apr / 1200, minPay = Math.ceil(P * r) + 1 + Math.round(rnd() * 400);
    let bal = P, months = 0;
    while (bal > 0.005 && months < 2000) { bal = bal * (1 + r) - minPay; months++; }
    const est = estimateMonthsToPayoff(P, apr, minPay);
    assert.ok(Math.abs(est.months - months) <= 1, `P=${P} apr=${apr} pay=${minPay}: formula ${est.months} vs simulated ${months}`);
  }
});

test("debt payoff: edge cases", () => {
  assert.deepEqual(estimateMonthsToPayoff(0, 20, 50), { months: 0, error: null });
  assert.equal(estimateMonthsToPayoff(1000, 0, 100).months, 10);
  assert.equal(estimateMonthsToPayoff(1000, 12, 5).months, null);
  assert.match(estimateMonthsToPayoff(1000, 12, 5).error, /doesn't cover/);
  assert.match(estimateMonthsToPayoff(1000, 12, 0).error, /monthly payment/);
});

test("debt order: snowball, avalanche, paid-off debts last", () => {
  const debts = [
    { id: "a", currentBalance: 500, interestRate: 5 }, { id: "b", currentBalance: 100, interestRate: 25 },
    { id: "c", currentBalance: 0, interestRate: 30 }, { id: "d", currentBalance: 900, interestRate: 15 },
  ];
  assert.deepEqual(orderDebts(debts, "snowball").map((d) => d.id), ["b", "a", "d", "c"]);
  assert.deepEqual(orderDebts(debts, "avalanche").map((d) => d.id), ["b", "d", "a", "c"]);
});

test("debt payments: editing or deleting a payment keeps the debt balance in step", () => {
  const data = { debts: [{ id: "d1", currentBalance: 900 }] };
  const paid = { id: "t1", debtId: "d1", amount: 100, debtApplied: 100 };
  const edited = adjustDebtForTransactionChange(data, paid, { ...paid, amount: 150 });
  assert.equal(data.debts[0].currentBalance, 850);
  assert.equal(edited.debtApplied, 150);
  adjustDebtForTransactionChange(data, edited, null);
  assert.equal(data.debts[0].currentBalance, 1000);
  const small = { debts: [{ id: "d1", currentBalance: 0 }] };
  adjustDebtForTransactionChange(small, { id: "t2", debtId: "d1", amount: 100, debtApplied: 50 }, null);
  assert.equal(small.debts[0].currentBalance, 50, "over-payment restores only what was actually deducted");
});

/* ------------------------------------------------------------------ */
const P = (frequency, anchorDate) => ({ frequency, anchorDate });
const period = (ps, iso) => { const p = getPayPeriod(ps, at(iso)); return [ymd(p.start), ymd(p.end)]; };

test("pay period: every frequency lines up with the calendar", () => {
  assert.deepEqual(period(P("weekly", "2026-09-01"), "2026-09-30"), ["2026-09-29", "2026-10-06"]);
  assert.deepEqual(period(P("biweekly", "2026-09-01"), "2026-09-30"), ["2026-09-29", "2026-10-13"]);
  assert.deepEqual(period(P("weekly", "2026-12-01"), "2026-09-30"), ["2026-09-29", "2026-10-06"], "anchor in the future");
  assert.deepEqual(period(P("monthly", "2026-01-31"), "2026-02-27"), ["2026-01-31", "2026-02-28"]);
  assert.deepEqual(period(P("monthly", "2026-01-31"), "2026-03-01"), ["2026-02-28", "2026-03-31"]);
  assert.deepEqual(period(P("monthly", "2028-01-29"), "2028-02-29"), ["2028-02-29", "2028-03-29"], "leap day");
  assert.deepEqual(period(P("semimonthly-1-15"), "2026-10-14"), ["2026-10-01", "2026-10-15"]);
  assert.deepEqual(period(P("semimonthly-1-15"), "2026-10-15"), ["2026-10-15", "2026-11-01"]);
  assert.deepEqual(period(P("semimonthly-1-15"), "2026-12-31"), ["2026-12-15", "2027-01-01"]);
  assert.deepEqual(period(P("semimonthly-15-last"), "2026-01-10"), ["2025-12-31", "2026-01-15"]);
  assert.deepEqual(period(P("semimonthly-15-last"), "2026-02-20"), ["2026-02-15", "2026-02-28"]);
  assert.deepEqual(period(P("semimonthly-15-last"), "2026-02-28"), ["2026-02-28", "2026-03-15"]);
  assert.deepEqual(period(P("semimonthly-15-last"), "2026-12-31"), ["2026-12-31", "2027-01-15"]);
  assert.equal(getPayPeriod(P("nonsense"), new Date()), null);
});

test("pay period: periods start at midnight even after a daylight-saving change", () => {
  // Anchor set in January, today is after the March clock change.
  const p = getPayPeriod(P("weekly", "2026-01-07"), at("2026-04-15"));
  assert.equal(ymd(p.start), "2026-04-15");
  assert.equal(p.start.getHours(), 0, "period start drifted to 1:00 am");
  assert.equal(p.end.getHours(), 0, "period end drifted to 1:00 am");
});

test("pay period: a bill due on payday day belongs to the period that starts that day", () => {
  const bills = [{ id: "1", name: "On payday", dueDay: 15 }, { id: "2", name: "Day before next", dueDay: 21 }, { id: "3", name: "Next payday", dueDay: 22 }, { id: "4", name: "No date" }];
  const r = getBillsDueInPeriod(bills, P("weekly", "2026-01-07"), at("2026-04-15"));
  assert.deepEqual(r.due.map((x) => x.bill.name), ["On payday", "Day before next"]);
  assert.deepEqual(r.noDueDay.map((b) => b.name), ["No date"]);
});

test("pay period: short months clamp the due day; month-spanning periods work", () => {
  assert.deepEqual(billDueDatesInRange(31, at("2026-02-15"), at("2026-03-15")).map(ymd), ["2026-02-28"]);
  assert.deepEqual(billDueDatesInRange(30, at("2026-01-31"), at("2026-02-28")).map(ymd), []);
  assert.deepEqual(billDueDatesInRange(1, at("2026-09-29"), at("2026-10-06")).map(ymd), ["2026-10-01"]);
  assert.deepEqual(billDueDatesInRange(29, at("2028-02-20"), at("2028-03-05")).map(ymd), ["2028-02-29"]);
});

test("pay period: the label for the last day is the day before the next payday", () => {
  assert.equal(ymd(lastDayOfPeriod(at("2026-03-09"))), "2026-03-08");
  assert.equal(ymd(lastDayOfPeriod(at("2026-11-02"))), "2026-11-01");
});

/* ------------------------------------------------------------------ */
const mk = (over) => ({ ...defaultData(), lastUpdated: "2026-01-01T00:00:00.000Z", ...over });

test("merge: keeps additions made on both devices", () => {
  const local = mk({ transactions: [{ id: "a" }], lastUpdated: "2026-01-02T00:00:00.000Z" });
  const remote = mk({ transactions: [{ id: "b" }] });
  assert.deepEqual(mergeData(local, remote).transactions.map((t) => t.id).sort(), ["a", "b"]);
  assert.deepEqual(mergeData(remote, local).transactions.map((t) => t.id).sort(), ["a", "b"]);
});

test("merge: a delete sticks, and an edit by the newer device wins", () => {
  const local = mk({ transactions: [{ id: "a" }], bills: [{ id: "x", name: "old" }] });
  const remote = mk({ tombstones: ["transaction:a"], bills: [{ id: "x", name: "new" }], lastUpdated: "2026-01-02T00:00:00.000Z" });
  const m = mergeData(local, remote);
  assert.equal(m.transactions.length, 0);
  assert.equal(m.bills[0].name, "new");
});

test("merge: the pay schedule survives a sync", () => {
  const ps = { frequency: "biweekly", anchorDate: "2026-09-04" };
  assert.deepEqual(mergeData(mk({ paySchedule: ps, lastUpdated: "2026-01-02T00:00:00.000Z" }), mk({})).paySchedule, ps, "local newer");
  assert.deepEqual(mergeData(mk({}), mk({ paySchedule: ps, lastUpdated: "2026-01-02T00:00:00.000Z" })).paySchedule, ps, "remote newer");
  assert.deepEqual(mergeData(mk({ paySchedule: ps, lastUpdated: "2026-01-02T00:00:00.000Z" }), mk({ paySchedule: null })).paySchedule, ps, "other side empty");
});

test("merge: passphrase, budget plan, and fields this version doesn't know about are kept", () => {
  const local = mk({ passphraseHash: null, budgetPlan: { "2026-09": { food: 100 } }, lastUpdated: "2026-01-02T00:00:00.000Z" });
  const remote = mk({ passphraseHash: "abc", budgetPlan: { "2026-09": { food: 90, bills: 50 }, "2026-10": { food: 5 } }, futureField: 7 });
  const m = mergeData(local, remote);
  assert.equal(m.passphraseHash, "abc");
  assert.deepEqual(m.budgetPlan, { "2026-09": { food: 100, bills: 50 }, "2026-10": { food: 5 } });
  assert.equal(m.futureField, 7);
});

test("merge: merging the same data twice changes nothing", () => {
  const a = mk({ transactions: [{ id: "a" }], bills: [{ id: "b" }], tombstones: ["bill:z"], paySchedule: { frequency: "weekly", anchorDate: "2026-01-01" } });
  const once = mergeData(a, a);
  assert.deepEqual(mergeData(once, a), once);
});

test("fresh device: a brand-new empty device never overrides data already on GitHub", () => {
  store.clear();
  const remote = mk({ passphraseHash: "h", categories: DEFAULT_CATEGORIES.map((c) => (c.id === "food" ? { ...c, name: "Groceries (renamed)" } : c)) });
  const merged = mergeData(loadLocalData(), remote);
  assert.equal(merged.categories.find((c) => c.id === "food").name, "Groceries (renamed)");
});

test("data from disk or GitHub is cleaned up so a bad file can't brick the app", () => {
  const d = sanitizeData({ transactions: "oops", bills: null, categories: {}, debts: [null, { id: "d" }], tombstones: 5, budgetPlan: [] });
  for (const k of ["transactions", "bills", "categories", "debts", "tombstones"]) assert.ok(Array.isArray(d[k]), k);
  assert.deepEqual(d.debts, [{ id: "d" }]);
  assert.equal(typeof d.budgetPlan, "object");
  assert.equal(Array.isArray(d.budgetPlan), false);
  store.set("familyBudget.data", JSON.stringify({ transactions: "oops" }));
  assert.ok(Array.isArray(loadLocalData().transactions));
  store.set("familyBudget.data", "{not json");
  assert.ok(Array.isArray(loadLocalData().transactions));
  assert.throws(() => validateBackup("[1,2]"), /backup/i);
  assert.throws(() => validateBackup('{"foo":1}'), /backup/i);
  assert.ok(validateBackup(JSON.stringify(mk({}))));
});

/* ------------------------------------------------------------------ */
test("encoding: UTF-8 round-trips through base64 (curly quotes, accents, emoji)", () => {
  const s = JSON.stringify({ d: "Dave’s check — café 🐷", big: "x".repeat(200000) });
  assert.equal(base64ToUtf8(utf8ToBase64(s)), s);
});

test("passphrase hash matches the SHA-256 test vector", async () => {
  assert.equal(await sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

/* ------------------------------------------------------------------ */
function fakeGithub(initial) {
  let n = 1, file = initial ? { content: b64(initial), sha: "s1" } : null;
  const calls = [];
  const res = (status, obj) => ({ ok: status < 400, status, json: async () => obj, text: async () => JSON.stringify(obj) });
  const fetch = async (url, init = {}) => {
    calls.push({ url, init });
    if ((init.method || "GET") === "GET") return file ? res(200, { content: file.content, sha: file.sha }) : res(404, {});
    const body = JSON.parse(init.body);
    if (file && body.sha !== file.sha) return res(409, { message: "does not match" });
    if (!file && body.sha) return res(422, { message: "sha wasn't supplied correctly" });
    file = { content: body.content, sha: "s" + ++n };
    return res(200, { content: { sha: file.sha } });
  };
  return { fetch, calls, current: () => JSON.parse(Buffer.from(file.content, "base64").toString()) };
}
const cfg = { owner: "o", repo: "r", token: "t" };

test("GitHub: reads must bypass the browser's 60-second cache", async () => {
  const gh = fakeGithub(mk({}));
  globalThis.fetch = gh.fetch;
  await githubFetchFile(cfg);
  assert.equal(gh.calls[0].init.cache, "no-store");
  assert.match(gh.calls[0].init.headers.Authorization, /^Bearer t$/);
});

test("GitHub: pull merges, push round-trips, 404 means no file yet", async () => {
  store.clear();
  const gh = fakeGithub(mk({ passphraseHash: "h", transactions: [{ id: "remote" }], lastUpdated: "2026-01-05T00:00:00.000Z" }));
  globalThis.fetch = gh.fetch;
  saveLocalData(mk({ transactions: [{ id: "local" }], lastUpdated: "2026-01-06T00:00:00.000Z" }));
  const { data, sha } = await syncPull(cfg);
  assert.deepEqual(data.transactions.map((t) => t.id).sort(), ["local", "remote"]);
  const newSha = await syncPush(cfg, data, sha);
  assert.notEqual(newSha, sha);
  assert.equal(gh.current().transactions.length, 2);
  await assert.rejects(() => syncPush(cfg, data, sha), /409/);
  globalThis.fetch = fakeGithub(null).fetch;
  assert.deepEqual(await githubFetchFile(cfg), { data: null, sha: null });
});

test("GitHub: errors carry the HTTP status so the app can say what's wrong", async () => {
  globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({}), text: async () => "bad credentials" });
  await assert.rejects(() => githubFetchFile(cfg), (e) => e.status === 401);
  assert.match(describeSyncError({ status: 401 }), /token/i);
  assert.match(describeSyncError({ status: 403 }), /token/i);
  assert.match(describeSyncError(new TypeError("Failed to fetch")), /offline/i);
});

/* ------------------------------------------------------------------ */
function parseVars(block) {
  const vars = {};
  for (const m of block.matchAll(/(--[\w-]+):\s*(#[0-9a-fA-F]{6})/g)) vars[m[1]] = m[2];
  return vars;
}
const lum = (hex) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

test("accessibility: text colors meet WCAG AA (4.5:1) in light and dark mode", () => {
  const css = read("css/styles.css");
  const light = parseVars(css.match(/:root\s*\{([^}]*)\}/)[1]);
  const dark = { ...light, ...parseVars(css.match(/prefers-color-scheme: dark\)\s*\{\s*:root\s*\{([^}]*)\}/)[1]) };
  const white = "#ffffff";
  const pairs = (v) => [
    ["text on page", v["--color-text"], v["--color-bg"]], ["text on card", v["--color-text"], v["--color-surface"]],
    ["muted text on page", v["--color-text-muted"], v["--color-bg"]], ["muted text on card", v["--color-text-muted"], v["--color-surface"]],
    ["primary-colored text on card", v["--color-primary"], v["--color-surface"]],
    ["income amounts on card", v["--color-income"], v["--color-surface"]],
    ["danger text on card", v["--color-danger"], v["--color-surface"]],
    ["warning text on card", v["--color-warning"], v["--color-surface"]],
    ["button text on primary button", v["--color-on-primary"] || white, v["--color-primary"]],
    ["dark-green text on its tint", v["--color-primary-dark"], v["--color-primary-tint"]],
    ["danger on danger tint", v["--color-danger"], v["--color-danger-tint"]],
    ["token reminder banner (warning on its tint)", v["--color-warning"], v["--color-warning-tint"]],
  ];
  const fails = [];
  for (const [mode, v] of [["light", light], ["dark", dark]])
    for (const [label, fg, bg] of pairs(v)) { const r = contrast(fg, bg); if (r < 4.5) fails.push(`${mode}: ${label} ${fg} on ${bg} = ${r.toFixed(2)}:1`); }
  assert.deepEqual(fails, []);
});

/* ------------------------------------------------------------------ */
test("lock: a device stays unlocked only for the passphrase it was unlocked with", () => {
  store.clear();
  assert.equal(isUnlockedOnThisDevice("hashA"), false);
  setUnlockedOnThisDevice("hashA");
  assert.equal(isUnlockedOnThisDevice("hashA"), true);
  assert.equal(isUnlockedOnThisDevice("hashB"), false, "passphrase was changed elsewhere");
  assert.equal(isUnlockedOnThisDevice(null), false, "no passphrase set yet");
  setUnlockedOnThisDevice(null);
  assert.equal(isUnlockedOnThisDevice("hashA"), false);
  store.set("familyBudget.unlocked", "true"); // what older versions saved
  assert.equal(isUnlockedOnThisDevice("hashA"), true);
  assert.equal(isUnlockedOnThisDevice("hashB"), false, "legacy flag is adopted once, then tied to that passphrase");
});

test("restore: keeps the passphrase, and 'replace' removes what isn't in the backup", () => {
  const current = mk({ passphraseHash: "mine", transactions: [{ id: "t-new" }, { id: "t-both" }], tombstones: ["bill:was-deleted"] });
  const backup = validateBackup(JSON.stringify(mk({ passphraseHash: null, transactions: [{ id: "t-both" }], bills: [{ id: "was-deleted" }] })));
  const r = restoreFromBackup(current, backup);
  assert.equal(r.passphraseHash, "mine");
  assert.ok(r.tombstones.includes("transaction:t-new"), "record missing from the backup is marked deleted");
  assert.ok(!r.tombstones.includes("bill:was-deleted"), "record in the backup is brought back");
  const afterSync = mergeData(r, mk({ transactions: [{ id: "t-new" }], lastUpdated: "2026-01-01T00:00:00.000Z" }));
  assert.deepEqual(afterSync.transactions.map((t) => t.id), ["t-both"]);
});

test("unsynced changes are remembered between sessions", () => {
  store.clear();
  assert.equal(isDirty(), false);
  setDirty(true);
  assert.equal(isDirty(), true);
  setDirty(false);
  assert.equal(isDirty(), false);
});

/* ------------------------------------------------------------------ */
test("offline: service worker falls back to the saved copy, and never touches GitHub calls", async () => {
  const base = "https://x.test/app/";
  const listeners = {}, cacheStore = new Map(), deleted = [];
  const resolve = (r) => (typeof r === "string" ? new URL(r, base).href : r.url);
  const fakeCaches = {
    open: async () => ({
      addAll: async (files) => files.forEach((f) => cacheStore.set(resolve(f), new Response("cached:" + f))),
      put: async (req, res) => { cacheStore.set(req.url, res); },
    }),
    keys: async () => ["old-cache", "family-budget-v1"],
    delete: async (k) => { deleted.push(k); },
    match: async (r) => { const hit = cacheStore.get(resolve(r)); return hit ? hit.clone() : undefined; },
  };
  let online = true;
  const fakeFetch = async (req) => { if (!online) throw new TypeError("Failed to fetch"); return new Response("network:" + req.url); };
  const self_ = { addEventListener: (t, fn) => (listeners[t] = fn), location: { origin: "https://x.test" }, skipWaiting: async () => {}, clients: { claim: async () => {} } };
  new Function("self", "caches", "fetch", read("sw.js"))(self_, fakeCaches, fakeFetch);

  const run = async (type) => { let p; listeners[type]({ waitUntil: (x) => (p = x) }); await p; };
  await run("install");
  assert.ok(cacheStore.has(base + "index.html") && cacheStore.has(base + "js/app.js"), "app files are saved at install");
  await run("activate");
  assert.deepEqual(deleted, ["old-cache"]);

  const ask = async (req) => { let p = null; listeners.fetch({ request: req, respondWith: (x) => (p = x) }); return p ? await p : null; };
  const get = (path, extra = {}) => ({ method: "GET", url: base + path, mode: "cors", ...extra });

  assert.equal(await (await ask(get("js/app.js"))).text(), "network:" + base + "js/app.js", "online: always the network copy");
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(await (await cacheStore.get(base + "js/app.js").clone()).text(), "network:" + base + "js/app.js", "online: the saved copy is refreshed");

  online = false;
  assert.equal(await (await ask(get("js/app.js"))).text(), "network:" + base + "js/app.js", "offline: last saved copy");
  assert.equal(await (await ask(get("", { mode: "navigate" }))).text(), "cached:./", "offline: opening the site root works");
  assert.equal(await (await ask(get("somewhere/else", { mode: "navigate" }))).text(), "cached:index.html", "offline: unknown page falls back to the app");
  assert.equal((await ask(get("nope.png"))).type, "error", "offline: a file that was never saved fails cleanly");

  assert.equal(await ask({ method: "GET", url: "https://api.github.com/repos/o/r/contents/data/budget-data.json", mode: "cors" }), null, "GitHub API calls are not intercepted");
  assert.equal(await ask({ method: "PUT", url: base + "js/app.js", mode: "cors" }), null, "writes are not intercepted");
});

/* ------------------------------------------------------------------ */
test("bill categories: changing a bill's category also moves its logged payments", () => {
  const data = mk({
    bills: [{ id: "b1", name: "Netflix", categoryId: "bills" }, { id: "b2", name: "Rent", categoryId: "bills" }],
    transactions: [
      { id: "t1", billId: "b1", categoryId: "bills" }, { id: "t2", billId: "b1", categoryId: "bills" },
      { id: "t3", billId: "b2", categoryId: "bills" }, { id: "t4", categoryId: "bills" },
    ],
  });
  assert.equal(recategorizeBill(data, "b1", "personal"), 2);
  assert.equal(data.bills[0].categoryId, "personal");
  assert.deepEqual(data.transactions.map((t) => t.categoryId), ["personal", "personal", "bills", "bills"], "only this bill's payments move");
  assert.equal(recategorizeBill(data, "b1", "personal"), 0, "no change, nothing to move");
  assert.equal(recategorizeBill(data, "b1", "income"), null, "income categories can't hold bills");
  assert.equal(recategorizeBill(data, "b1", "no-such-category"), null);
  assert.equal(recategorizeBill(data, "no-such-bill", "food"), null);
  assert.equal(data.bills[0].categoryId, "personal", "rejected changes leave the bill alone");
});

/* ------------------------------------------------------------------ */
test("pay period: paid bills are marked and left out of what's still to pay", () => {
  const bills = [{ id: "a", name: "Water", amount: 100, dueDay: 15 }, { id: "b", name: "Gas", amount: 50.5, dueDay: 18 }, { id: "c", name: "Rent", amount: 1000, dueDay: 1 }];
  const txns = [
    { id: "t1", billId: "a", date: "2026-04-14" },   // Water paid this month
    { id: "t2", billId: "c", date: "2026-03-30" },   // Rent paid, but in March
  ];
  const r = getBillsDueInPeriod(bills, P("weekly", "2026-04-01"), at("2026-04-15"), txns); // period Apr 15 - Apr 22
  assert.deepEqual(r.due.map((x) => [x.bill.name, !!x.paid]), [["Water", true], ["Gas", false]]);
  assert.equal(r.total, 150.5);
  assert.equal(r.remaining, 50.5);
  // A period that crosses into next month looks for the payment in the month the bill falls due.
  const r2 = getBillsDueInPeriod(bills, P("weekly", "2026-03-30"), at("2026-03-30"), txns); // Mar 30 - Apr 6
  assert.deepEqual(r2.due.map((x) => [x.bill.name, !!x.paid]), [["Rent", false]], "March payment doesn't count for April's due date");
  assert.equal(getBillsDueInPeriod(bills, P("weekly", "2026-04-01"), at("2026-04-15")).remaining, 150.5, "transactions are optional");
});

test("bills list: sorted by due day, name, or category", () => {
  const cats = [{ id: "bills", name: "Bills & Utilities" }, { id: "personal", name: "Personal & Fun" }, { id: "debt", name: "Debt Payments" }];
  const bills = [
    { id: "1", name: "Netflix", dueDay: 12, categoryId: "personal" }, { id: "2", name: "Water", dueDay: 3, categoryId: "bills" },
    { id: "3", name: "Amazon", categoryId: "personal" }, { id: "4", name: "Chase", dueDay: 12, categoryId: "debt" }, { id: "5", name: "gas" },
  ];
  const ids = (mode) => sortBills(bills, mode, cats).map((b) => b.id).join("");
  assert.equal(ids("due"), "24135", "by due day; same day by name; no due day last (by name)");
  assert.equal(ids("name"), "34512", "Amazon, Chase, gas, Netflix, Water");
  assert.equal(ids("category"), "25413", "Bills & Utilities (Water, gas), Debt Payments (Chase), Personal & Fun (Netflix, Amazon)");
  assert.notEqual(sortBills(bills, "due", cats), bills, "never reorders the saved list itself");
  assert.deepEqual(bills.map((b) => b.id), ["1", "2", "3", "4", "5"]);
});

test("bills linked to a debt: paying the bill lowers the debt, undoing restores it", () => {
  const data = mk({
    debts: [{ id: "d1", name: "Visa", currentBalance: 1000 }],
    bills: [{ id: "b1", name: "Visa payment", categoryId: "debt", debtId: "d1" }, { id: "b2", name: "Water", categoryId: "bills" }, { id: "b3", name: "Old link", debtId: "gone" }],
  });
  const paid = recordBillPayment(data, data.bills[0], "2026-10-05", 150, "p1");
  assert.equal(data.debts[0].currentBalance, 850);
  assert.equal(paid.debtId, "d1");
  assert.equal(paid.debtApplied, 150);
  assert.equal(paid.categoryId, "debt");
  assert.equal(paid.billId, "b1");
  recordBillPayment(data, data.bills[1], "2026-10-05", 40, "p2");
  assert.equal(data.debts[0].currentBalance, 850, "an unlinked bill doesn't touch the debt");
  assert.equal(data.transactions.find((t) => t.id === "p2").debtId, undefined);
  recordBillPayment(data, data.bills[2], "2026-10-05", 10, "p3");
  assert.equal(data.transactions.find((t) => t.id === "p3").debtId, undefined, "a link to a deleted debt is ignored");
  assert.equal(removeTransaction(data, "p1"), true);
  assert.equal(data.debts[0].currentBalance, 1000, "undo gives the money back");
  assert.ok(data.tombstones.includes("transaction:p1"));
  assert.equal(removeTransaction(data, "nope"), false);
});

test("token reminder: warns two weeks ahead, today, and after it has expired", () => {
  const today = at("2026-10-07");
  assert.equal(tokenExpiryNotice("", today), null);
  assert.equal(tokenExpiryNotice("garbage", today), null);
  assert.equal(tokenExpiryNotice("2026-12-30", today), null, "far away: stay quiet");
  assert.equal(tokenExpiryNotice("2026-10-21", today).daysLeft, 14);
  assert.equal(tokenExpiryNotice("2026-10-22", today), null, "15 days: still quiet");
  const soon = tokenExpiryNotice("2026-10-14", today);
  assert.equal(soon.level, "soon");
  assert.match(soon.message, /expires in 7 days \(Oct 14\)/);
  assert.match(tokenExpiryNotice("2026-10-08", today).message, /in 1 day /);
  assert.match(tokenExpiryNotice("2026-10-07", today).message, /expires today/);
  const gone = tokenExpiryNotice("2026-10-01", today);
  assert.equal(gone.level, "expired");
  assert.match(gone.message, /expired on Oct 1/);
});

test("text size: remembered per device, only valid sizes accepted", () => {
  store.clear();
  assert.equal(getTextSize(), "normal");
  setTextSize("large"); assert.equal(getTextSize(), "large");
  setTextSize("xlarge"); assert.equal(getTextSize(), "xlarge");
  setTextSize("gigantic"); assert.equal(getTextSize(), "normal", "invalid value resets to normal");
  store.set("familyBudget.textSize", "<script>");
  assert.equal(getTextSize(), "normal");
});

test("text size: the stylesheet scales everything from the root size", () => {
  const css = read("css/styles.css");
  assert.match(css, /html\[data-text-size="large"\]\s*\{[^}]*font-size:\s*\d+px/);
  assert.match(css, /html\[data-text-size="xlarge"\]\s*\{[^}]*font-size:\s*\d+px/);
  assert.doesNotMatch(css, /html,\s*body\s*\{[^}]*font-size:\s*\d+px/, "body must not pin a fixed pixel size");
});

test("safety check: warns only when the data repository is public", async () => {
  const reply = (obj, ok = true) => async () => ({ ok, status: ok ? 200 : 404, json: async () => obj });
  globalThis.fetch = reply({ private: false }); assert.equal(await githubRepoIsPublic(cfg), true);
  globalThis.fetch = reply({ private: true }); assert.equal(await githubRepoIsPublic(cfg), false);
  globalThis.fetch = reply({}, false); assert.equal(await githubRepoIsPublic(cfg), null, "unknown: don't scare anyone");
  globalThis.fetch = async () => { throw new TypeError("Failed to fetch"); }; assert.equal(await githubRepoIsPublic(cfg), null);
});

test("bills: paid rows are not dimmed (dimmed gray text is too faint to read)", () => {
  assert.doesNotMatch(read("css/styles.css"), /is-paid[^{]*\{[^}]*opacity/);
});

/* ------------------------------------------------------------------ */
const pays = (frequency, anchorDate) => ({ frequency, anchorDate });
const days = (schedule, from, to) => paydaysBetween(schedule, from, to);

test("paydays: every frequency lands on the right dates", () => {
  assert.deepEqual(days(pays("weekly", "2026-10-02"), "2026-09-20", "2026-10-20"), ["2026-09-25", "2026-10-02", "2026-10-09", "2026-10-16"]);
  assert.deepEqual(days(pays("biweekly", "2026-10-02"), "2026-09-01", "2026-10-31"), ["2026-09-04", "2026-09-18", "2026-10-02", "2026-10-16", "2026-10-30"], "dates before the anchor still line up");
  assert.deepEqual(days(pays("biweekly", "2026-10-30"), "2026-10-01", "2026-10-20"), ["2026-10-02", "2026-10-16"], "anchor after the range");
  assert.deepEqual(days(pays("semimonthly-1-15"), "2026-09-28", "2026-11-02"), ["2026-10-01", "2026-10-15", "2026-11-01"]);
  assert.deepEqual(days(pays("semimonthly-15-last"), "2026-01-30", "2026-03-01"), ["2026-01-31", "2026-02-15", "2026-02-28"], "February's last day is the 28th");
  assert.deepEqual(days(pays("semimonthly-15-last"), "2028-02-14", "2028-03-01"), ["2028-02-15", "2028-02-29"], "leap year");
  assert.deepEqual(days(pays("monthly", "2026-01-31"), "2026-01-01", "2026-05-01"), ["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"], "a 31st payday falls on the last day of shorter months");
  assert.deepEqual(days(pays("monthly", "2026-10-05"), "2026-10-05", "2026-10-05"), ["2026-10-05"], "both ends are included");
});

test("paydays: daylight-saving changes and bad input don't skip or repeat a payday", () => {
  const spring = days(pays("weekly", "2026-02-27"), "2026-02-27", "2026-04-10");
  assert.equal(spring.length, 7);
  assert.deepEqual(spring.slice(2, 4), ["2026-03-13", "2026-03-20"]);
  assert.deepEqual(days(pays("biweekly", "2026-10-16"), "2026-10-16", "2026-12-01"), ["2026-10-16", "2026-10-30", "2026-11-13", "2026-11-27"]);
  assert.deepEqual(days(pays("weekly", "garbage"), "2026-10-01", "2026-10-31"), []);
  assert.deepEqual(days(pays("weekly", null), "2026-10-01", "2026-10-31"), []);
  assert.deepEqual(days(pays("fortnightly", "2026-10-01"), "2026-10-01", "2026-10-31"), []);
  assert.deepEqual(days(null, "2026-10-01", "2026-10-31"), []);
  assert.deepEqual(days(pays("weekly", "2026-10-01"), "nope", "2026-10-31"), []);
});

test("paydays: next payday, including today", () => {
  assert.equal(ymd(nextPayday(pays("biweekly", "2026-10-02"), at("2026-10-02"))), "2026-10-02", "today counts");
  assert.equal(ymd(nextPayday(pays("biweekly", "2026-10-02"), at("2026-10-03"))), "2026-10-16");
  assert.equal(ymd(nextPayday(pays("semimonthly-15-last"), at("2026-10-16"))), "2026-10-31");
  assert.equal(nextPayday(pays("weekly", "garbage"), at("2026-10-16")), null);
});

const incomeData = (sources, over = {}) => mk({ recurringIncome: sources, ...over });
const dad = { id: "s1", name: "Dad's paycheck", amount: 1500.5, categoryId: "income", frequency: "biweekly", anchorDate: "2026-10-02", startedOn: "2026-10-02" };

test("recurring income: paychecks come due from the day they were set up, once each", () => {
  const data = incomeData([dad]);
  const due = duePaychecks(data, at("2026-10-31"));
  assert.deepEqual(due.map((t) => t.date), ["2026-10-02", "2026-10-16", "2026-10-30"]);
  assert.deepEqual(due[0], { id: "pay-s1-2026-10-02", type: "income", date: "2026-10-02", categoryId: "income", description: "Dad's paycheck", amount: 1500.5, paycheckId: "s1" });
  assert.deepEqual(duePaychecks(data, at("2026-10-01")), [], "nothing before it starts");
  assert.equal(duePaychecks(data, at("2026-10-02")).length, 1, "payday itself counts");
  data.transactions.push(...due);
  assert.deepEqual(duePaychecks(data, at("2026-10-31")), [], "running again adds nothing");
  assert.equal(duePaychecks(data, at("2026-11-13")).length, 1, "only the new payday is added");
});

test("recurring income: a deleted paycheck stays deleted, an edited one isn't redone", () => {
  const data = incomeData([dad], { tombstones: ["transaction:pay-s1-2026-10-16"] });
  assert.deepEqual(duePaychecks(data, at("2026-10-31")).map((t) => t.date), ["2026-10-02", "2026-10-30"]);
  const edited = incomeData([dad], { transactions: [{ id: "pay-s1-2026-10-02", type: "income", date: "2026-10-02", amount: 1400, description: "Dad (short week)" }] });
  assert.deepEqual(duePaychecks(edited, at("2026-10-05")), [], "a changed amount is left alone");
});

test("recurring income: ignores damaged sources, falls back sensibly, limits the look-back", () => {
  const data = incomeData([
    { id: "a", name: "No amount", amount: 0, frequency: "weekly", anchorDate: "2026-10-01", startedOn: "2026-10-01" },
    { id: "b", name: "Bad schedule", amount: 10, frequency: "weekly", anchorDate: "nope", startedOn: "2026-10-01" },
    { name: "No id", amount: 10, frequency: "weekly", anchorDate: "2026-10-01", startedOn: "2026-10-01" },
    { id: "c", name: "Deleted category", amount: 10, categoryId: "gone", frequency: "monthly", anchorDate: "2026-10-05", startedOn: "2026-10-05" },
    { id: "d", name: "Expense category", amount: 10, categoryId: "food", frequency: "monthly", anchorDate: "2026-10-05", startedOn: "2026-10-05" },
  ]);
  const due = duePaychecks(data, at("2026-10-31"));
  assert.deepEqual(due.map((t) => t.id), ["pay-c-2026-10-05", "pay-d-2026-10-05"]);
  assert.deepEqual(due.map((t) => t.categoryId), ["income", "income"], "must land in an income category");
  const forgotten = incomeData([{ id: "e", name: "Old", amount: 1, frequency: "weekly", anchorDate: "2020-01-03", startedOn: "2020-01-03" }]);
  const long = duePaychecks(forgotten, at("2026-10-31"));
  assert.ok(long.length >= 57 && long.length <= 58, `about 400 days of weekly pay, got ${long.length}`);
  const noStart = incomeData([{ id: "f", name: "Hand-edited", amount: 1, frequency: "weekly", anchorDate: "2020-01-03" }]);
  assert.equal(duePaychecks(noStart, at("2026-10-31")).length, paydaysBetween(pays("weekly", "2020-01-03"), "2026-10-31", "2026-10-31").length, "no start date means start today, never a flood");
});

test("recurring income: two devices that add the same paycheck end up with one", () => {
  const a = incomeData([dad], { lastUpdated: "2026-10-31T10:00:00.000Z" });
  const b = incomeData([dad], { lastUpdated: "2026-10-31T11:00:00.000Z" });
  a.transactions.push(...duePaychecks(a, at("2026-10-31")));
  b.transactions.push(...duePaychecks(b, at("2026-10-31")));
  const merged = mergeData(a, b);
  assert.equal(merged.transactions.length, 3);
  assert.equal(new Set(merged.transactions.map((t) => t.id)).size, 3);
  assert.equal(sumTransactions(merged.transactions, { type: "income" }), 4501.5);
});

test("recurring income: saved, merged, deleted and restored like everything else", () => {
  assert.deepEqual(defaultData().recurringIncome, []);
  assert.deepEqual(sanitizeData({ recurringIncome: "oops" }).recurringIncome, []);
  assert.deepEqual(sanitizeData({ recurringIncome: [dad, 5, null] }).recurringIncome, [dad]);
  assert.deepEqual(sanitizeData(JSON.parse('{"transactions":[],"categories":[]}')).recurringIncome, [], "files from before this feature");
  const mom = { ...dad, id: "s2", name: "Mom's paycheck" };
  const merged = mergeData(incomeData([dad], { lastUpdated: "2026-01-01T00:00:00.000Z" }), incomeData([mom], { lastUpdated: "2026-01-02T00:00:00.000Z" }));
  assert.deepEqual(merged.recurringIncome.map((p) => p.id).sort(), ["s1", "s2"], "an addition on each device is kept");
  const gone = mergeData(incomeData([dad]), incomeData([], { tombstones: ["paycheck:s1"], lastUpdated: "2026-05-01T00:00:00.000Z" }));
  assert.deepEqual(gone.recurringIncome, [], "a deletion on one device sticks");
  const restored = restoreFromBackup(incomeData([dad, mom]), sanitizeData({ categories: [], transactions: [], recurringIncome: [mom] }));
  assert.ok(restored.tombstones.includes("paycheck:s1"), "restoring replaces: paychecks missing from the backup are removed");
  assert.ok(!restored.tombstones.includes("paycheck:s2"));
  assert.equal(mergeData(restored, incomeData([dad, mom])).recurringIncome.map((p) => p.id).join(), "s2");
});

test("month by month: newest first, across a year boundary, with gaps", () => {
  const data = mk({ transactions: [
    { id: "1", type: "income", date: "2026-01-05", amount: 3000 }, { id: "2", type: "expense", date: "2026-01-20", amount: 1200.1 },
    { id: "3", type: "expense", date: "2025-11-02", amount: 50 }, { id: "4", type: "income", date: "2025-11-02", amount: 10 },
  ] });
  const rows = monthlyHistory(data, "2026-02", 4);
  assert.deepEqual(rows.map((r) => r.monthKey), ["2026-02", "2026-01", "2025-12", "2025-11"]);
  assert.deepEqual(rows.map((r) => r.income), [0, 3000, 0, 10]);
  assert.deepEqual(rows.map((r) => r.expenses), [0, 1200.1, 0, 50]);
  assert.deepEqual(rows.map((r) => r.leftOver), [0, 1799.9, 0, -40]);
  assert.equal(monthlyHistory(data, "2026-02", 12).length, 12);
});

test("month by month: change from last month is worded plainly", () => {
  assert.equal(describeChange(150, 100), "↑ $50.00 more than last month");
  assert.equal(describeChange(100.5, 150), "↓ $49.50 less than last month");
  assert.equal(describeChange(100, 100), null);
  assert.equal(describeChange(0.3, 0.1 + 0.2), null, "float dust is not a change");
  assert.equal(describeChange(40, 0), "↑ $40.00 more than last month");
});

test("printable bills list: month view is in due-day order and shows what's paid", () => {
  const data = mk({
    bills: [
      { id: "1", name: "Water", amount: 45.25, dueDay: 22 }, { id: "2", name: "Rent", amount: 1000, dueDay: 1 },
      { id: "3", name: "Netflix", amount: 15.49 }, { id: "4", name: "Phone", amount: 80, dueDay: 3 },
    ],
    transactions: [{ id: "t", billId: "2", date: "2026-10-01" }, { id: "u", billId: "4", date: "2026-09-03" }],
  });
  const sheet = billsSheet(data, "month", at("2026-10-08"));
  assert.equal(sheet.title, "Bills for October 2026");
  assert.deepEqual(sheet.rows.map((r) => [r.due, r.name, r.paid]), [["1st", "Rent", true], ["3rd", "Phone", false], ["22nd", "Water", false], ["Any day", "Netflix", false]]);
  assert.equal(sheet.total, 1140.74);
  assert.equal(billsSheet(data, "period", at("2026-10-08")), null, "no payday set up yet");
  assert.equal(billsSheet(mk(), "month", at("2026-10-08")).rows.length, 0);
});

test("printable bills list: pay-period view lists only what's due before the next payday", () => {
  const data = mk({
    paySchedule: pays("weekly", "2026-10-02"),
    bills: [{ id: "1", name: "Water", amount: 45.25, dueDay: 10 }, { id: "2", name: "Rent", amount: 1000, dueDay: 1 }, { id: "3", name: "Netflix", amount: 15 }],
    transactions: [{ id: "t", billId: "1", date: "2026-10-05" }],
  });
  const quiet = billsSheet(data, "period", at("2026-10-08")); // pay period Oct 2 - Oct 8: nothing falls due
  assert.equal(quiet.subtitle, "Oct 2 – Oct 8 • Next payday Oct 9");
  assert.deepEqual(quiet.rows, []);
  const later = billsSheet(data, "period", at("2026-10-10")); // pay period Oct 9 - Oct 15
  assert.deepEqual(later.rows.map((r) => [r.due, r.name, r.paid]), [["Oct 10", "Water", true]]);
  assert.equal(later.total, 45.25);
  assert.deepEqual(later.skipped, ["Netflix"], "bills with no due date are mentioned, not silently dropped");
});

test("printable bills list: print layout hides the app and uses large, dark-on-white type", () => {
  const css = read("css/styles.css");
  const print = css.slice(css.indexOf("@media print"));
  assert.match(print, /body\s*>\s*\*:not\(#modal-root\)\s*\{[^}]*display:\s*none/);
  assert.match(print, /\.no-print\s*\{[^}]*display:\s*none/);
  assert.match(print, /table\s*\{[^}]*font-size:\s*(2\d|3\d)pt/);
  assert.match(css, /\.print-sheet\s*\{[^}]*background:\s*#ffffff;\s*color:\s*#000000/, "stays black on white even in dark mode");
});

test("app wiring: new screens are hooked up and ordinal() lives in one place", () => {
  const app = read("js/app.js");
  for (const needle of ["open-add-paycheck", "edit-paycheck", "open-month", "toggle-history", "print-bills", "addDuePaychecks()", "renderPaychecksSection()", "renderHistoryCard()"])
    assert.ok(app.includes(needle), `app.js is missing ${needle}`);
  assert.equal((app.match(/function ordinal\(/g) || []).length, 0, "ordinal() now lives in calculations.js");
  assert.equal((read("js/calculations.js").match(/function ordinal\(/g) || []).length, 1);
});

/* ------------------------------------------------------------------ */
test("coming up: the next 7 days including today, across a month end, unpaid vs paid", () => {
  const bills = [
    { id: "1", name: "Rent", amount: 1000, dueDay: 1 }, { id: "2", name: "Water", amount: 45, dueDay: 30 },
    { id: "3", name: "Phone", amount: 80, dueDay: 31 }, { id: "4", name: "Gym", amount: 20, dueDay: 7 },
    { id: "5", name: "Netflix", amount: 15 }, { id: "6", name: "Far", amount: 5, dueDay: 15 },
  ];
  const txns = [{ id: "t", billId: "1", date: "2026-11-01" }, { id: "u", billId: "2", date: "2026-10-05" }];
  const soon = billsComingUp(bills, txns, at("2026-10-28"), 7); // Oct 28 .. Nov 4
  assert.deepEqual(soon.map((x) => [x.bill.name, ymd(x.date), !!x.paid]), [["Water", "2026-10-30", true], ["Phone", "2026-10-31", false], ["Rent", "2026-11-01", true]],
    "Water's payment was logged in October (its due month); Rent's in November");
  assert.deepEqual(billsComingUp(bills, [], at("2026-10-07"), 7).map((x) => x.bill.name), ["Gym"], "today counts");
  assert.deepEqual(billsComingUp(bills, [], at("2026-10-08"), 7).map((x) => x.bill.name), ["Far"], "yesterday's bill (the 7th) is gone; a week ahead (the 15th) is in");
  assert.deepEqual(billsComingUp(bills, [], at("2026-10-08"), 6).map((x) => x.bill.name), [], "the window length is respected");
  assert.equal(ymd(billsComingUp(bills, [], at("2026-02-27"), 7).find((x) => x.bill.name === "Phone").date), "2026-02-28", "a 31st bill falls on the 28th in February");
  assert.deepEqual(billsComingUp([], [], at("2026-10-07")), []);
});

test("coming up: friendly day names", () => {
  assert.equal(dayLabel(at("2026-10-08"), at("2026-10-08")), "Today");
  assert.equal(dayLabel(at("2026-10-09"), at("2026-10-08")), "Tomorrow");
  assert.equal(dayLabel(at("2026-10-16"), at("2026-10-08")), "Fri, Oct 16");
  assert.equal(dayLabel(at("2026-11-01"), at("2026-10-31")), "Tomorrow", "across a month end");
});

const undoFixture = () => mk({
  debts: [{ id: "d1", name: "Visa", currentBalance: 1000 }],
  bills: [{ id: "b1", name: "Visa payment", categoryId: "debt", debtId: "d1", amount: 150 }],
  tombstones: ["transaction:old"],
});

test("undo: a deleted debt payment comes back, and so does the debt balance", () => {
  const data = undoFixture();
  recordBillPayment(data, data.bills[0], "2026-10-05", 150, "p1");
  assert.equal(data.debts[0].currentBalance, 850);
  const before = snapshotForUndo(data);
  removeTransaction(data, "p1");
  const after = snapshotForUndo(data);
  assert.equal(data.debts[0].currentBalance, 1000);
  assert.ok(data.tombstones.includes("transaction:p1"));
  undoDelete(data, before, after);
  assert.equal(data.debts[0].currentBalance, 850, "balance goes back down");
  assert.deepEqual(data.transactions.map((t) => t.id), ["p1"]);
  assert.equal(data.transactions[0].debtApplied, 150, "the payment is exactly as it was");
  assert.deepEqual(data.tombstones, ["transaction:old"], "its delete-marker is gone, older ones stay");
});

test("undo: bills, debts, categories and paychecks come back with their delete-markers removed", () => {
  const data = undoFixture();
  data.recurringIncome = [{ id: "s1", name: "Pay", amount: 100, frequency: "weekly", anchorDate: "2026-10-02" }];
  for (const [list, id, key] of [["bills", "b1", "bill"], ["debts", "d1", "debt"], ["recurringIncome", "s1", "paycheck"], ["categories", "food", "category"]]) {
    const before = snapshotForUndo(data);
    const record = data[list].find((r) => r.id === id);
    data[list] = data[list].filter((r) => r.id !== id);
    data.tombstones.push(`${key}:${id}`);
    const after = snapshotForUndo(data);
    undoDelete(data, before, after);
    assert.deepEqual(data[list].find((r) => r.id === id), record, `${key} restored`);
    assert.ok(!data.tombstones.includes(`${key}:${id}`), `${key} delete-marker removed`);
  }
});

test("undo: leaves everything done since alone and never duplicates", () => {
  const data = undoFixture();
  data.transactions.push({ id: "t1", type: "expense", amount: 5 });
  const before = snapshotForUndo(data);
  removeTransaction(data, "t1");
  const after = snapshotForUndo(data);
  data.transactions.push({ id: "t2", type: "expense", amount: 7 });        // a new entry made meanwhile
  data.debts[0].currentBalance = 900;                                    // a balance edited meanwhile
  undoDelete(data, before, after);
  assert.deepEqual(data.transactions.map((t) => t.id).sort(), ["t1", "t2"]);
  assert.equal(data.debts[0].currentBalance, 900, "a balance changed since is not overwritten");
  undoDelete(data, before, after);
  assert.equal(data.transactions.filter((t) => t.id === "t1").length, 1, "undoing twice doesn't duplicate");
});

test("undo: before the deletion reaches GitHub, an undone item survives the next sync", () => {
  const data = undoFixture();
  const remote = JSON.parse(JSON.stringify(data));          // GitHub still has the bill
  const before = snapshotForUndo(data);
  data.bills = []; data.tombstones.push("bill:b1");
  const after = snapshotForUndo(data);
  data.lastUpdated = "2026-10-08T10:00:00.000Z";
  undoDelete(data, before, after);
  const merged = mergeData(data, remote);
  assert.equal(merged.bills.length, 1, "no stray delete-marker is left to remove it again");
});

test("sync is held back while Undo is on offer", () => {
  const app = read("js/app.js");
  assert.match(app, /state\.syncHoldUntil = Date\.now\(\) \+ UNDO_WINDOW_MS/);
  assert.match(app, /Math\.max\(1200, state\.syncHoldUntil - Date\.now\(\)\)/);
  assert.equal((app.match(/deleteWithUndo\("/g) || []).length, 7, "transaction, payment, bill, debt, category, paycheck, goal");
  assert.doesNotMatch(app, /showToast\("(Transaction|Bill|Debt|Category|Paycheck|Goal|Payment) (deleted|removed)"\)/, "every delete offers Undo");
});

test("debt-free date: one debt matches the payoff formula", () => {
  let seed = 4242;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < 300; i++) {
    const P = Math.round(100 + rnd() * 20000), apr = Math.round(rnd() * 30 * 100) / 100;
    const min = Math.ceil((P * apr) / 1200) + 1 + Math.round(rnd() * 400);
    const sim = simulatePayoff([{ name: "d", currentBalance: P, interestRate: apr, minPayment: min }], "snowball", 0);
    assert.equal(sim.months, estimateMonthsToPayoff(P, apr, min).months, `P=${P} apr=${apr} min=${min}`);
  }
});

test("debt-free date: money freed by a finished debt rolls onto the next, extra speeds it up", () => {
  const debts = [{ name: "A", currentBalance: 100, interestRate: 0, minPayment: 50 }, { name: "B", currentBalance: 300, interestRate: 0, minPayment: 50 }];
  assert.deepEqual(simulatePayoff(debts, "snowball", 0), { months: 4, interest: 0 }, "B alone would take 6 months without the rollover");
  assert.equal(simulatePayoff(debts, "snowball", 100).months, 2);
  assert.equal(simulatePayoff([], "snowball", 0).months, 0);
  assert.equal(simulatePayoff([{ name: "Done", currentBalance: 0, minPayment: 0 }], "snowball", 0).months, 0, "paid-off debts are ignored");
});

test("debt-free date: avalanche costs less interest than snowball when the big-interest debt is bigger", () => {
  const debts = [{ name: "X", currentBalance: 1000, interestRate: 5, minPayment: 100 }, { name: "Y", currentBalance: 2000, interestRate: 25, minPayment: 100 }];
  const snow = simulatePayoff(debts, "snowball", 200), ava = simulatePayoff(debts, "avalanche", 200);
  assert.ok(ava.interest < snow.interest, `avalanche ${ava.interest} vs snowball ${snow.interest}`);
  assert.ok(simulatePayoff(debts, "avalanche", 300).months < simulatePayoff(debts, "avalanche", 200).months);
  assert.ok(simulatePayoff(debts, "avalanche", 200).interest < simulatePayoff(debts, "avalanche", 0).interest);
});

test("debt-free date: says why it can't give one instead of guessing", () => {
  assert.match(simulatePayoff([{ name: "Visa", currentBalance: 500, interestRate: 10, minPayment: 0 }], "snowball").error, /Add a monthly payment for Visa/);
  assert.match(simulatePayoff([{ name: "Visa", currentBalance: 1000, interestRate: 24, minPayment: 10 }], "snowball").error, /never get paid off/);
  const rescued = simulatePayoff([{ name: "A", currentBalance: 100, interestRate: 0, minPayment: 500 }, { name: "B", currentBalance: 1000, interestRate: 24, minPayment: 10 }], "snowball");
  assert.equal(rescued.months, 3, "a payment that is too small is rescued by money freed from another debt");
});

test("debt-free date: month names roll over the year", () => {
  assert.equal(monthsFromNowLabel(at("2026-10-31"), 0), "October 2026");
  assert.equal(monthsFromNowLabel(at("2026-10-31"), 17), "March 2028");
  assert.equal(monthsFromNowLabel(at("2026-12-15"), 1), "January 2027");
  assert.equal(monthsFromNowLabel(at("2026-01-31"), 1), "February 2026", "no skipping a short month from the 31st");
});

test("search the Log: words match description, category, date and amount", () => {
  const cats = [{ id: "food", name: "Food & Groceries" }, { id: "bills", name: "Bills & Utilities" }];
  const txns = [
    { id: "1", date: "2026-10-03", description: "Walmart", categoryId: "food", amount: 82.5, type: "expense" },
    { id: "2", date: "2026-09-20", description: "WALMART supercenter", categoryId: "food", amount: 40, type: "expense" },
    { id: "3", date: "2026-10-12", description: "Electric", categoryId: "bills", amount: 120, type: "expense" },
    { id: "4", date: "2026-08-02", description: "Pay", categoryId: "income", amount: 2400, type: "income" },
  ];
  const ids = (q) => searchTransactions(txns, cats, q).map((t) => t.id).join("");
  assert.equal(ids("walmart"), "12", "any case, newest first");
  assert.equal(ids("walmart 40"), "2", "every word must match");
  assert.equal(ids("utilities"), "3", "category name");
  assert.equal(ids("2026-09"), "2", "date");
  assert.equal(ids("$82.50"), "1", "amount typed with a dollar sign");
  assert.equal(ids("82.5"), "1");
  assert.equal(ids("2,400"), "4", "amount as shown with a comma");
  assert.equal(ids("zzz"), "");
  assert.equal(ids("   "), "3124", "no words: everything, newest first");
});

test("search the Log: wired to type-as-you-go filtering without redrawing the box", () => {
  const app = read("js/app.js");
  assert.match(app, /e\.target\.id !== "txn-search"/);
  assert.match(app, /byId\("txn-results"\)\.innerHTML = renderTransactionResults\(\)/);
  assert.match(read("css/styles.css"), /\.toast-btn\s*\{[^}]*min-height:\s*var\(--touch-min\)/, "Undo button is a big target");
});

/* ------------------------------------------------------------------ */
test("budget plan: a month with no plan uses the latest earlier plan", () => {
  const plan = { "2026-08": { food: 300 }, "2026-09": { food: 350, bills: 100 }, "2026-11": { food: 1 } };
  assert.deepEqual(planForMonth(plan, "2026-09"), { plan: plan["2026-09"], from: null }, "its own plan wins");
  assert.deepEqual(planForMonth(plan, "2026-10"), { plan: plan["2026-09"], from: "2026-09" });
  assert.equal(planForMonth(plan, "2027-03").from, "2026-11", "any number of months later");
  assert.equal(planForMonth(plan, "2026-12").from, "2026-11");
  assert.deepEqual(planForMonth(plan, "2026-07"), { plan: {}, from: null }, "never borrows from the future");
  assert.equal(planForMonth({ "2026-10": {}, "2026-09": { food: 5 } }, "2026-10").from, "2026-09", "an empty plan counts as no plan");
  assert.deepEqual(planForMonth({ junk: { a: 1 } }, "2026-10"), { plan: {}, from: null }, "keys that aren't months are ignored");
  assert.deepEqual(planForMonth({}, "2026-10"), { plan: {}, from: null });
});

test("budget plan: the first change in a carried-over month saves the whole plan without touching the old one", () => {
  const plan = { "2026-09": { food: 350, bills: 100 } };
  plan["2026-10"] = { ...planForMonth(plan, "2026-10").plan, food: 400 };
  assert.deepEqual(plan["2026-10"], { food: 400, bills: 100 });
  assert.deepEqual(plan["2026-09"], { food: 350, bills: 100 });
  assert.equal(planForMonth(plan, "2026-10").from, null, "now it has its own");
  assert.equal(planForMonth(plan, "2026-11").plan.food, 400, "and next month carries October's");
  plan["2026-10"] = { ...planForMonth(plan, "2026-10").plan, food: 0 };
  assert.equal(planForMonth(plan, "2026-10").plan.food, 0, "typing 0 is a real choice, not 'unset'");
});

test("last paid: finds the most recent payment of that bill", () => {
  const txns = [
    { id: "1", billId: "b", date: "2026-08-05", amount: 100 }, { id: "2", billId: "b", date: "2026-09-05", amount: 142.1 },
    { id: "3", billId: "c", date: "2026-09-20", amount: 9 }, { id: "4", date: "2026-09-21", amount: 7 },
  ];
  assert.equal(lastBillPayment(txns, "b").id, "2");
  assert.equal(lastBillPayment(txns, "zzz"), null);
  assert.equal(lastBillPayment([], "b"), null);
  assert.equal(lastBillPayment([...txns, { id: "5", billId: "b", date: "2026-09-05", amount: 1 }], "b").id, "5", "same day: the later entry");
  assert.equal(shortISODate("2026-09-05"), "Sep 5");
  assert.equal(shortISODate("nope"), "");
});

test("not marked paid: only this month's bills whose due date has passed", () => {
  const bills = [
    { id: "rent", name: "Rent", dueDay: 1 }, { id: "phone", name: "Phone", dueDay: 3 }, { id: "water", name: "Water", dueDay: 15 },
    { id: "gym", name: "Gym", dueDay: 5, addedOn: "2026-10-06" }, { id: "old", name: "Old", dueDay: 2, addedOn: "2026-09-01" },
    { id: "nodue", name: "Netflix" }, { id: "today", name: "Today", dueDay: 8 },
  ];
  const txns = [{ id: "t", billId: "phone", date: "2026-10-04" }, { id: "u", billId: "rent", date: "2026-09-30" }];
  const late = overdueBills(bills, txns, at("2026-10-08"));
  assert.deepEqual(late.map((x) => [x.bill.name, ymd(x.date)]), [["Rent", "2026-10-01"], ["Old", "2026-10-02"]],
    "Phone is paid; Gym was added after its date; today's bill isn't late yet; last month's payment doesn't count");
  assert.deepEqual(overdueBills(bills, txns, at("2026-10-01")), [], "nothing is late on the 1st");
  assert.deepEqual(overdueBills([{ id: "x", name: "X", dueDay: 31 }], [], at("2026-02-28")), [], "a 31st bill is due on the 28th in February, not late yet");
  assert.equal(overdueBills([{ id: "x", name: "X", dueDay: 31 }], [], at("2026-04-30")).length, 0, "…or the 30th in April");
  assert.deepEqual(overdueBills([], [], at("2026-10-08")), []);
});

const flowData = (over = {}) => mk({
  paySchedule: pays("biweekly", "2026-10-02"),
  recurringIncome: [dad, { id: "s2", name: "Mom's paycheck", amount: 800, frequency: "monthly", anchorDate: "2026-10-05", startedOn: "2026-10-05" }],
  bills: [{ id: "w", name: "Water", amount: 45.25, dueDay: 10 }, { id: "r", name: "Rent", amount: 1000, dueDay: 1 }, { id: "p", name: "Phone", amount: 80, dueDay: 14 }],
  ...over,
});

test("paychecks minus bills: this pay period's income, bills and what's left", () => {
  const flow = periodCashFlow(flowData(), at("2026-10-09")); // pay period Oct 2 - Oct 15
  assert.deepEqual(flow.paychecks.map((p) => [p.name, p.date, p.amount]), [["Dad's paycheck", "2026-10-02", 1500.5], ["Mom's paycheck", "2026-10-05", 800]]);
  assert.equal(flow.income, 2300.5);
  assert.equal(flow.bills, 125.25, "Water (10th) and Phone (14th); Rent isn't in this period");
  assert.equal(flow.left, 2175.25);
  const paid = periodCashFlow(flowData({ transactions: [{ id: "x", billId: "w", date: "2026-10-09" }] }), at("2026-10-09"));
  assert.equal(paid.bills, 125.25, "a bill that's already paid still comes out of what the paycheck covers");
  const short = periodCashFlow(flowData({ bills: [{ id: "r", name: "Rent", amount: 3000, dueDay: 12 }] }), at("2026-10-09"));
  assert.equal(short.left, -699.5, "negative means short");
});

test("paychecks minus bills: stays quiet when it has nothing sensible to say", () => {
  assert.equal(periodCashFlow(flowData({ paySchedule: null }), at("2026-10-09")), null, "no payday");
  assert.equal(periodCashFlow(flowData({ recurringIncome: [] }), at("2026-10-09")), null, "no paychecks");
  const far = flowData({ recurringIncome: [{ id: "s3", name: "Late", amount: 800, frequency: "monthly", anchorDate: "2026-10-20" }] });
  assert.equal(periodCashFlow(far, at("2026-10-09")), null, "no paycheck lands in this period");
  assert.equal(periodCashFlow(flowData({ recurringIncome: [{ ...dad, amount: 0 }] }), at("2026-10-09")), null, "zero-amount paychecks don't count");
});

const goalData = () => mk({ goals: [{ id: "g1", name: "Vacation", target: 1000, startAmount: 100 }, { id: "g2", name: "Car", target: 5000 }] });

test("savings goals: progress is added up from tagged Savings entries in the Log", () => {
  const data = goalData();
  assert.equal(goalSaved(data, data.goals[0]), 100, "starts at what was already saved");
  assert.equal(goalSaved(data, data.goals[1]), 0);
  const txn = recordGoalContribution(data, data.goals[0], "2026-10-05", 250.5, "c1");
  assert.deepEqual(txn, { id: "c1", type: "expense", date: "2026-10-05", categoryId: "savings", description: "Savings: Vacation", amount: 250.5, goalId: "g1" });
  recordGoalContribution(data, data.goals[0], "2026-10-06", 0.1, "c2");
  recordGoalContribution(data, data.goals[0], "2026-10-07", 0.2, "c3");
  assert.equal(goalSaved(data, data.goals[0]), 350.8, "cents stay exact");
  assert.equal(goalSaved(data, data.goals[1]), 0, "another goal is unaffected");
  assert.equal(sumTransactions(data.transactions, { categoryId: "savings", type: "expense" }), 250.8, "it shows up as Savings spending");
  removeTransaction(data, "c1");
  assert.equal(goalSaved(data, data.goals[0]), 100.3, "deleting the entry in the Log lowers the goal");
  data.transactions.find((t) => t.id === "c2").amount = 50;
  assert.equal(goalSaved(data, data.goals[0]), 150.2, "so does editing it");
});

test("savings goals: falls back to another expense category if Savings was deleted", () => {
  const data = mk({ goals: [{ id: "g1", name: "Trip", target: 10 }], categories: [{ id: "income", name: "Income", type: "income" }, { id: "fun", name: "Fun", type: "expense" }] });
  assert.equal(recordGoalContribution(data, data.goals[0], "2026-10-05", 5, "c").categoryId, "fun");
});

test("savings goals: saved, merged, deleted, undone and restored like everything else", () => {
  assert.deepEqual(defaultData().goals, []);
  assert.deepEqual(sanitizeData({ goals: "oops" }).goals, []);
  assert.deepEqual(sanitizeData({ goals: [{ id: "g" }, 3, null] }).goals, [{ id: "g" }]);
  const a = goalData(), b = mk({ goals: [{ id: "g3", name: "Roof", target: 9 }], lastUpdated: "2026-02-01T00:00:00.000Z" });
  assert.deepEqual(mergeData(a, b).goals.map((g) => g.id).sort(), ["g1", "g2", "g3"], "a goal added on each device is kept");
  const gone = mergeData(goalData(), mk({ tombstones: ["goal:g1"], lastUpdated: "2026-05-01T00:00:00.000Z" }));
  assert.deepEqual(gone.goals.map((g) => g.id), ["g2"], "a deletion on one device sticks");
  const restored = restoreFromBackup(goalData(), sanitizeData({ categories: [], transactions: [], goals: [{ id: "g2", name: "Car", target: 5000 }] }));
  assert.ok(restored.tombstones.includes("goal:g1") && !restored.tombstones.includes("goal:g2"));
  const data = goalData();
  const before = snapshotForUndo(data);
  data.goals = data.goals.filter((g) => g.id !== "g1"); data.tombstones.push("goal:g1");
  const after = snapshotForUndo(data);
  undoDelete(data, before, after);
  assert.deepEqual(data.goals.map((g) => g.id).sort(), ["g1", "g2"]);
  assert.ok(!data.tombstones.includes("goal:g1"));
});

test("app wiring: carry-forward, last paid, not-marked-paid, cash flow and goals are hooked up", () => {
  const app = read("js/app.js");
  for (const needle of [
    "planForMonth(d.budgetPlan, state.month).plan", "planForMonth(state.data.budgetPlan, state.month)",
    "...(isEdit ? txn : {})", "delete updated.billId; delete updated.goalId", "addedOn: isEdit ? bill.addedOn : todayISO()",
    "bill-pay-use-last", "overdueBills(", "renderCashFlow()", "periodCashFlow(", "renderGoalsCard()", "open-add-goal", "add-to-goal", "edit-goal",
    "recordGoalContribution(d, goal",
  ]) assert.ok(app.includes(needle), `app.js is missing ${needle}`);
});

/* ------------------------------------------------------------------ */
const cssRules = (css) => [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}@]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1].trim(), body: m[2] }));

test("css: every form field sets its own background and text color (dark mode showed white boxes with near-white text)", () => {
  const css = read("css/styles.css");
  const fields = cssRules(css).filter((r) => /(^|[\s,>])(input|select|textarea)\b|-input\b|-select\b/.test(r.selector) && !/::placeholder|:focus|:checked/.test(r.selector));
  const boxes = fields.filter((r) => /border|padding|min-height/.test(r.body));
  assert.ok(boxes.length >= 6, `expected to find the form-field rules, found ${boxes.length}`);
  const bare = boxes.filter((r) => !/background/.test(r.body) || !/(^|[\s;])color:/.test(r.body));
  assert.deepEqual(bare.map((r) => r.selector), [], "these field rules draw a box but don't set both a background and a text color");
});

test("css: native widgets and hints follow light/dark, and keyboard focus is visible", () => {
  const css = read("css/styles.css");
  assert.match(css, /:root\s*\{\s*color-scheme:\s*light dark;\s*\}/);
  assert.match(css, /::placeholder\s*\{\s*color:\s*var\(--color-text-muted\);\s*opacity:\s*1;\s*\}/);
  assert.match(css, /:focus-visible\s*\{\s*outline:\s*3px solid/);
  assert.match(css, /\.btn:disabled\s*\{[^}]*opacity/, "disabled buttons look disabled");
});

test("css: colour swatches in the category form are big enough to tap, selected one is ringed", () => {
  const css = read("css/styles.css");
  assert.match(css, /\.swatch-picker \.color-swatch\s*\{[^}]*width:\s*44px;[^}]*height:\s*44px/);
  assert.match(css, /\.swatch-picker \.color-swatch\.selected\s*\{[^}]*border-color:\s*var\(--color-text\)/);
  const app = read("js/app.js");
  assert.match(app, /class="swatch-picker"/);
  assert.doesNotMatch(app, /style\.borderColor/, "selection is a class now, not an inline style");
});

test("css: phone rules come after the base rules they override", () => {
  const css = read("css/styles.css");
  const mobile = css.lastIndexOf("@media (max-width: 520px)");
  for (const base of [".bar-row .bar-label {", ".budget-row {", ".bill-item {", ".print-sheet {", ".app-header {", ".search-box {"])
    assert.ok(css.indexOf(base) !== -1 && css.indexOf(base) < mobile, `${base} must be defined before the small-screen block`);
  assert.match(css.slice(mobile), /\.budget-row \.cat-pill \{ grid-column: 1 \/ -1; \}/, "category names get their own line on phones");
  assert.match(css.slice(mobile), /\.bar-row \.bar-track \{ flex: 0 0 100%; order: 3; \}/);
});

test("css: narrow screens — two summary cards fit across 360px phones, header wraps instead of crushing the title", () => {
  const css = read("css/styles.css");
  const min = Number(css.match(/\.summary-grid\s*\{[^}]*minmax\((\d+)px/)[1]);
  assert.ok(2 * min + 12 <= 360 - 32, `two cards of ${min}px must fit in a 360px phone`);
  assert.match(css, /\.app-header\s*\{[^}]*flex-wrap:\s*wrap/);
  assert.doesNotMatch(css, /\.sync-status\s*\{[^}]*max-width:\s*50%/);
});

test("css: budget grid has Planned / Spent headings and the bills list has its own phone layout", () => {
  const app = read("js/app.js");
  assert.match(app, /class="budget-head"[^>]*><span>Category<\/span><span>Planned<\/span><span>Spent<\/span>/);
  assert.match(app, /class="bill-item bill-item-list/);
  assert.match(read("css/styles.css"), /\.bill-item-list \.bill-main \{ flex: 1 1 100%; \}/);
});

test("css: print preview wraps long bill names without breaking the 'Paid' heading", () => {
  const css = read("css/styles.css");
  assert.match(css, /\.print-sheet th:nth-child\(2\), \.print-sheet td:nth-child\(2\)\s*\{[^}]*overflow-wrap:\s*anywhere/);
  assert.match(css, /\.print-sheet th, \.print-sheet td:first-child, \.print-sheet td\.num, \.print-sheet td\.paid-box\s*\{\s*white-space:\s*nowrap/);
});

/* ------------------------------------------------------------------ */
test("bills that aren't monthly: which months they fall due in", () => {
  const months = (bill) => Array.from({ length: 12 }, (_, i) => i).filter((i) => billDueInMonth(bill, 2026, i)).map((i) => i + 1);
  assert.deepEqual(months({ frequency: "quarterly", dueMonth: 3 }), [3, 6, 9, 12]);
  assert.deepEqual(months({ frequency: "quarterly", dueMonth: 11 }), [2, 5, 8, 11], "counting from any month, wrapping the year");
  assert.deepEqual(months({ frequency: "semiannual", dueMonth: 12 }), [6, 12]);
  assert.deepEqual(months({ frequency: "semiannual", dueMonth: 4 }), [4, 10]);
  assert.deepEqual(months({ frequency: "yearly", dueMonth: 7 }), [7]);
  assert.equal(months({ frequency: "monthly", dueMonth: 7 }).length, 12);
  assert.equal(months({}).length, 12, "older bills with no frequency are monthly");
  assert.equal(months({ frequency: "yearly" }).length, 12, "no month chosen: shown every month rather than hidden");
  assert.equal(months({ frequency: "yearly", dueMonth: 13 }).length, 12);
  assert.equal(months({ frequency: "fortnightly", dueMonth: 3 }).length, 12, "unknown frequency: monthly");
});

test("bills that aren't monthly: due dates across a year end, only in their months", () => {
  const bill = { frequency: "semiannual", dueMonth: 12 };
  const dates = billDueDatesInRange(15, at("2026-05-01"), at("2027-07-01"), (y, m) => billDueInMonth(bill, y, m)).map(ymd);
  assert.deepEqual(dates, ["2026-06-15", "2026-12-15", "2027-06-15"]);
  assert.equal(billDueDatesInRange(15, at("2026-05-01"), at("2027-07-01")).length, 14, "no filter: every month, as before");
});

const mixedBills = () => [
  { id: "water", name: "Water", amount: 45, dueDay: 12 },
  { id: "car", name: "Car insurance", amount: 600, dueDay: 15, frequency: "semiannual", dueMonth: 4 },     // Apr, Oct
  { id: "tax", name: "Property tax", amount: 2400, dueDay: 15, frequency: "yearly", dueMonth: 12 },
  { id: "phone", name: "Phone plan", amount: 90, dueDay: 15, frequency: "quarterly", dueMonth: 3 },        // Mar, Jun, Sep, Dec
];

test("bills that aren't monthly: only appear in the pay period, Coming Up and Not-marked-paid when they're due", () => {
  const bills = mixedBills();
  const oct = getBillsDueInPeriod(bills, P("weekly", "2026-10-02"), at("2026-10-09"));      // Oct 9 - Oct 15
  assert.deepEqual(oct.due.map((x) => x.bill.name), ["Water", "Car insurance"], "October: car insurance yes; tax and phone plan no");
  assert.equal(oct.total, 645);
  const dec = getBillsDueInPeriod(bills, P("weekly", "2026-10-02"), at("2026-12-12"));      // Dec 11 - Dec 17
  assert.deepEqual(dec.due.map((x) => x.bill.name), ["Water", "Property tax", "Phone plan"], "December: tax and phone plan, not car insurance");
  assert.deepEqual(billsComingUp(bills, [], at("2026-10-09"), 7).map((x) => x.bill.name), ["Water", "Car insurance"]);
  assert.deepEqual(billsComingUp(bills, [], at("2026-11-10"), 7).map((x) => x.bill.name), ["Water"], "November: only the monthly one");
  assert.deepEqual(overdueBills(bills, [], at("2026-10-20")).map((x) => x.bill.name), ["Water", "Car insurance"], "tax and phone plan weren't due, so can't be late");
  assert.deepEqual(overdueBills(bills, [{ id: "p", billId: "car", date: "2026-10-03" }], at("2026-10-20")).map((x) => x.bill.name), ["Water"], "paid in its due month");
  assert.deepEqual(overdueBills(bills, [{ id: "p", billId: "car", date: "2026-04-03" }], at("2026-10-20")).map((x) => x.bill.name), ["Water", "Car insurance"], "April's payment doesn't cover October");
});

test("bills that aren't monthly: next due date and how they're described", () => {
  const car = { dueDay: 15, frequency: "yearly", dueMonth: 12 };
  assert.equal(ymd(nextBillDue(car, at("2026-10-09"))), "2026-12-15");
  assert.equal(ymd(nextBillDue(car, at("2026-12-15"))), "2026-12-15", "today counts");
  assert.equal(ymd(nextBillDue(car, at("2026-12-16"))), "2027-12-15");
  assert.equal(ymd(nextBillDue({ dueDay: 31, frequency: "yearly", dueMonth: 2 }, at("2026-10-09"))), "2027-02-28");
  assert.equal(ymd(nextBillDue({ dueDay: 15, frequency: "quarterly", dueMonth: 3 }, at("2026-10-09"))), "2026-12-15");
  assert.equal(ymd(nextBillDue({ dueDay: 12 }, at("2026-10-13"))), "2026-11-12", "monthly bills too");
  assert.equal(nextBillDue({ frequency: "yearly", dueMonth: 3 }, at("2026-10-09")), null, "no due day");
  assert.equal(billFrequencyLabel({ frequency: "semiannual", dueMonth: 12 }), "Every 6 months (Jun, Dec)");
  assert.equal(billFrequencyLabel({ frequency: "quarterly", dueMonth: 2 }), "Every 3 months (Feb, May, Aug, Nov)");
  assert.equal(billFrequencyLabel({ frequency: "yearly", dueMonth: 7 }), "Once a year (Jul)");
  for (const none of [{}, { frequency: "monthly" }, { frequency: "yearly" }, { frequency: "weird", dueMonth: 3 }]) assert.equal(billFrequencyLabel(none), "");
});

test("bills that aren't monthly: the printed list only has what's due, and names the rest", () => {
  const data = mk({ bills: [{ id: "r", name: "Rent", amount: 1000, dueDay: 1 }, ...mixedBills().slice(1)] });
  const oct = billsSheet(data, "month", at("2026-10-08"));
  assert.deepEqual(oct.rows.map((r) => [r.due, r.name]), [["1st", "Rent"], ["15th", "Car insurance"]]);
  assert.equal(oct.total, 1600);
  assert.deepEqual(oct.notDue, ["Phone plan (next Dec 15)", "Property tax (next Dec 15)"], "same day: by name");
  const dec = billsSheet(data, "month", at("2026-12-08"));
  assert.deepEqual(dec.rows.map((r) => r.name), ["Rent", "Phone plan", "Property tax"]);
  assert.deepEqual(dec.notDue, ["Car insurance (next Apr 15)"]);
  assert.deepEqual(billsSheet(mk({ bills: [{ id: "r", name: "Rent", dueDay: 1, amount: 5 }] }), "month", at("2026-10-08")).notDue, []);
});

test("bills that aren't monthly: the bill form asks how often and which month, and refuses a missing due day", () => {
  const app = read("js/app.js");
  for (const needle of ["bill-frequency", "bill-due-month", "bill-month-group", "Enter the day of the month it's due.", "billDueInMonth(b, viewYear, viewMonth)", "Not due this month", "Not due this month: ", "frequency: chosenFrequency"])
    assert.ok(app.includes(needle), `app.js is missing ${needle}`);
});

/* ------------------------------------------------------------------ */
test("spreadsheet export: cells are quoted, and free text can't run as a formula", () => {
  assert.equal(csvCell(null), "");
  assert.equal(csvCell("plain"), "plain");
  assert.equal(csvCell('say "hi", ok'), '"say ""hi"", ok"');
  assert.equal(csvCell("two\nlines"), '"two\nlines"');
  assert.equal(csvCell("  padded "), '"  padded "');
  assert.equal(csvCell("=1+1", { text: true }), "'=1+1");
  assert.equal(csvCell("+cmd", { text: true }), "'+cmd");
  assert.equal(csvCell("-2+3", { text: true }), "'-2+3");
  assert.equal(csvCell("@SUM(A1)", { text: true }), "'@SUM(A1)");
  assert.equal(csvCell("=1+1"), "=1+1", "only free-text cells get the guard");
  assert.equal(csvCell(-5), "-5");
});

test("spreadsheet export: transactions as rows, oldest first, spending negative", () => {
  const data = mk({ transactions: [
    { id: "1", type: "expense", date: "2026-10-05", categoryId: "food", description: 'Groceries, "big" store', amount: 82.5 },
    { id: "2", type: "income", date: "2026-01-02", categoryId: "income", description: "=1+1", amount: 1500 },
    { id: "3", type: "expense", date: "2025-12-31", categoryId: "gone", description: "  spaced ", amount: 0.1 + 0.2 },
    { id: "4", type: "expense", date: "2026-10-05", categoryId: "other", description: "a\nb", amount: 0 },
  ] });
  const csv = transactionsToCsv(data);
  assert.ok(csv.startsWith("﻿Date,Type,Category,Description,Amount (spending is negative)\r\n"), "byte-order mark so Excel reads accents, and a header");
  assert.equal(csv.slice(1), [
    "Date,Type,Category,Description,Amount (spending is negative)",
    '2025-12-31,Expense,Uncategorized,"  spaced ",-0.30',
    "2026-01-02,Income,Income,'=1+1,1500.00",
    '2026-10-05,Expense,Food & Groceries,"Groceries, ""big"" store",-82.50',
    '2026-10-05,Expense,Other,"a\nb",0.00',
    "",
  ].join("\r\n"), "oldest first; same day keeps entry order; cents exact; no -0.00; unknown category named");
  const y26 = transactionsToCsv(data, "2026").split("\r\n");
  assert.equal(y26.length, 5, "header + 3 rows + trailing newline");
  assert.ok(!y26.join("").includes("2025-12-31"));
  assert.equal(transactionsToCsv(mk(), "2026"), "﻿Date,Type,Category,Description,Amount (spending is negative)\r\n", "nothing to list: just the header");
});

test("spreadsheet export: the years offered come from the data", () => {
  assert.deepEqual(transactionYears([{ date: "2025-03-01" }, { date: "2026-10-05" }, { date: "2026-01-01" }, { date: "garbage" }, {}]), ["2026", "2025"]);
  assert.deepEqual(transactionYears([]), []);
  const app = read("js/app.js");
  for (const needle of ["export-csv", "handleExportCsv", "export-year", "transactionsToCsv(state.data, year)", "text/csv;charset=utf-8"])
    assert.ok(app.includes(needle), `app.js is missing ${needle}`);
  assert.equal((app.match(/URL\.createObjectURL/g) || []).length, 1, "one shared download helper");
});

/* ------------------------------------------------------------------ */
test("safety: saved text and ids are escaped before they go into a page attribute", () => {
  const app = read("js/app.js");
  const allowed = new Set(["CSS.escape(key)", "pct", "toLocalISODate(dueDate)", "r.monthKey", "Math.round((r.expenses / maxSpent) * 100)", "toLocalISODate(date)", "dueHere", "v", "n", "y", "c", "todayISO()", "value", "i + 1"]);
  const unescaped = new Set();
  for (const m of app.matchAll(/(data-[\w-]+|value|style)="([^"]*)"/g))
    for (const e of m[2].matchAll(/\$\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g))
      if (!/escapeHtml\(/.test(e[1]) && !allowed.has(e[1])) unescaped.add(`${m[1]}="${e[1]}"`);
  assert.deepEqual([...unescaped], [], "these saved values reach an attribute without escapeHtml");
});

test("safety: a category colour from a file or backup can't carry anything but a colour", () => {
  const colourOf = (color) => sanitizeData({ categories: [{ id: "c", name: "x", type: "expense", color }], transactions: [] }).categories[0].color;
  for (const good of ["#abc", "#3f6b58", "#3f6b58ff", "var(--cat-food)", "var(--cat-other)"]) assert.equal(colourOf(good), good);
  for (const bad of ['red"; onmouseover="x', "red; background:url(//evil)", "url(x)", "var(--a) var(--b)", 'var(--x)"', "", null, 7, undefined, "#12"]) assert.equal(colourOf(bad), "var(--cat-other)", `rejected: ${bad}`);
  assert.equal(validateBackup(JSON.stringify({ categories: [{ id: "c", color: 'x"y' }], transactions: [] })).categories[0].color, "var(--cat-other)", "backups too");
  assert.equal(mergeData(mk(), mk({ categories: [{ id: "c", name: "x", type: "expense", color: "javascript:1" }], lastUpdated: "2026-05-01T00:00:00.000Z" })).categories.find((c) => c.id === "c").color, "var(--cat-other)", "and what comes from GitHub");
});

test("bug fixes from the code review are in place", () => {
  const app = read("js/app.js");
  assert.match(app, /delete updated\.debtId/, "turning a debt payment into income gives the debt its money back");
  assert.match(app, /Math\.max\(0, Math\.min\(100, Math\.round\(\(1 - d\.currentBalance \/ d\.originalBalance\)/, "debt progress can't go below 0%");
  assert.match(app, /a\.date > b\.date \? -1 : 0/, "equal dates compare equal");
  assert.match(app, /data-id="\$\{escapeHtml\(b\.id\)\}" data-due="\$\{dueHere\}"/, "Mark Paid in the Bills list dates the payment in the month on screen");
  assert.match(app, /No bills are due this month\./, "an empty month list doesn't talk about pay periods");
  assert.equal((app.match(/setDirty\(true\);\s*(\/\/[^\n]*\n\s*)?scheduleSync\(\)/g) || []).length >= 2, true, "connecting uploads what the device already had (both connect forms)");
});

test("an expense turned into income no longer lowers the debt it was paying", () => {
  const data = mk({ debts: [{ id: "d", name: "Visa", currentBalance: 1000 }], bills: [{ id: "b", name: "Visa", debtId: "d", categoryId: "debt" }] });
  recordBillPayment(data, data.bills[0], "2026-10-05", 100, "p");
  assert.equal(data.debts[0].currentBalance, 900);
  // what the Log's edit form does when the type is switched to Income
  const edited = { ...data.transactions[0], type: "income" };
  delete edited.billId; delete edited.goalId; delete edited.paycheckId; delete edited.debtId;
  data.transactions[0] = adjustDebtForTransactionChange(data, data.transactions[0], edited);
  assert.equal(data.debts[0].currentBalance, 1000, "the 100 goes back to the debt");
  assert.equal(findBillPayment(data.transactions, "b", "2026-10"), undefined, "and it no longer counts as the bill being paid");
});

test("accessibility: every planned-amount box says which category it is for", () => {
  assert.match(read("js/app.js"), /class="planned-input"[^>]*aria-label="Planned amount for \$\{escapeHtml\(c\.name\)\}"/);
});

/* ------------------------------------------------------------------ */
test("money: the fast formatter gives exactly what the locale formatter did", () => {
  const old = (amount) => { const n = roundCents(amount); return (n < 0 ? "-" : "") + "$" + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
  let seed = 31337; const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const cases = [0, -0, 0.004, 0.005, 0.015, 1, 12, 123, 999.995, 1000, 1234.5, 999999.99, 1e6, 1234567.891, -1, -1234.567, -0.001, 1e12 + 0.01, 1e15, 2.5e15, "12.5", "abc", null, undefined, NaN, Infinity === 1 ? 0 : 5];
  for (let i = 0; i < 20000; i++) cases.push((rnd() - 0.3) * Math.pow(10, Math.floor(rnd() * 13)));
  for (const c of cases) assert.equal(formatMoney(c), old(c), `formatMoney(${c})`);
});

test("money: formatting 20,000 amounts is fast enough for search-as-you-type", () => {
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 20000; i++) formatMoney(i * 1.37);
  assert.ok(Number(process.hrtime.bigint() - t0) / 1e6 < 250, "formatting 20,000 amounts should take well under a quarter second");
  const txns = Array.from({ length: 20000 }, (_, i) => ({ id: "t" + i, date: "2026-03-01", categoryId: "food", description: "Store " + i, amount: i / 4 }));
  const t1 = process.hrtime.bigint();
  const found = searchTransactions(txns, defaultData().categories, "store 199");
  const ms = Number(process.hrtime.bigint() - t1) / 1e6;
  const slowHay = (t) => [t.description, "Food & Groceries", t.date, String(t.amount), "$" + Math.abs(t.amount).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })].join(" ").toLowerCase();
  const expected = txns.filter((t) => slowHay(t).includes("store") && slowHay(t).includes("199")).length;
  assert.ok(expected > 100, "the check itself has something to find");
  assert.equal(found.length, expected, "same matches as the slow, obviously-correct way");
  assert.ok(ms < 400, `one search over 20,000 transactions took ${ms.toFixed(0)} ms`);
});

test("GitHub: a data file over 1 MB (content left out by GitHub) is read from the raw copy", async () => {
  const data = mk({ transactions: [{ id: "big", amount: 1 }] });
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push(init.headers.Accept);
    if (init.headers.Accept === "application/vnd.github.raw+json") return { ok: true, status: 200, text: async () => JSON.stringify(data) };
    return { ok: true, status: 200, json: async () => ({ content: "", encoding: "none", sha: "bigsha", size: 3000000 }) };
  };
  const got = await githubFetchFile(cfg);
  assert.equal(got.sha, "bigsha", "the version still comes from the first answer");
  assert.deepEqual(got.data.transactions, [{ id: "big", amount: 1 }]);
  assert.deepEqual(calls, ["application/vnd.github+json", "application/vnd.github.raw+json"]);
  calls.length = 0;
  globalThis.fetch = async (url, init) => ({ ok: true, status: 200, json: async () => ({ content: b64(data), encoding: "base64", sha: "s1" }) });
  assert.equal((await githubFetchFile(cfg)).sha, "s1", "small files still come back in one request");
  globalThis.fetch = async (url, init) => init.headers.Accept.includes("raw") ? { ok: false, status: 403, text: async () => "" } : { ok: true, status: 200, json: async () => ({ content: "", encoding: "none", sha: "x" }) };
  await assert.rejects(() => githubFetchFile(cfg), (e) => e.status === 403, "a failed raw read is reported like any other read failure");
});
