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
