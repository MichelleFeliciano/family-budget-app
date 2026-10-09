/* ==========================================================================
   Budget math: month keys, totals, and debt payoff calculations.
   ========================================================================== */

function monthKeyOf(dateStr) {
  return (dateStr || "").slice(0, 7); // "YYYY-MM-DD" -> "YYYY-MM"
}

function toLocalISODate(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Local calendar date. toISOString() is UTC, which is already "tomorrow" by
// 7 pm in Texas — that put evening entries on the wrong day (or month).
function todayISO() {
  return toLocalISODate(new Date());
}

function currentMonthKey() {
  return todayISO().slice(0, 7);
}

// Whole calendar days, so a daylight-saving change can't leave a date at 1:00 am.
function addDays(date, n) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + n);
}

// A period's `end` is the next payday; the last day it covers is the day before.
function lastDayOfPeriod(end) {
  return addDays(end, -1);
}

function roundCents(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function shiftMonthKey(monthKey, delta) {
  const [y, m] = monthKey.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
}

function formatMonthLabel(monthKey) {
  const [y, m] = monthKey.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1, 1));
  return d.toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" });
}

function formatMoney(amount) {
  const n = roundCents(amount); // also turns float dust like -1e-14 into 0
  const sign = n < 0 ? "-" : "";
  return sign + "$" + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function sumTransactions(transactions, { monthKey, categoryId, type } = {}) {
  return roundCents(
    transactions
      .filter((t) => (monthKey ? monthKeyOf(t.date) === monthKey : true))
      .filter((t) => (categoryId ? t.categoryId === categoryId : true))
      .filter((t) => (type ? t.type === type : true))
      .reduce((sum, t) => sum + Number(t.amount || 0), 0)
  );
}

function monthTotals(data, monthKey) {
  const income = sumTransactions(data.transactions, { monthKey, type: "income" });
  const expenses = sumTransactions(data.transactions, { monthKey, type: "expense" });
  const debtRemaining = roundCents(data.debts.reduce((sum, d) => sum + Math.max(0, Number(d.currentBalance || 0)), 0));
  return { income, expenses, leftOver: roundCents(income - expenses), debtRemaining };
}

/**
 * Standard loan amortization, solved for the number of payments (n):
 *   n = -ln(1 - r*P/M) / ln(1 + r)
 * where r = monthly interest rate, P = balance, M = fixed monthly payment.
 * Returns { months, error } — error is set (months is null) when M does not
 * even cover a month's interest, since the debt would never amortize.
 */
function estimateMonthsToPayoff(balance, annualRatePct, monthlyPayment) {
  const P = Number(balance) || 0;
  const M = Number(monthlyPayment) || 0;
  const annualRate = Number(annualRatePct) || 0;

  if (P <= 0) return { months: 0, error: null };
  if (M <= 0) return { months: null, error: "Add a monthly payment to estimate a payoff date." };

  const r = annualRate / 100 / 12;
  if (r === 0) {
    return { months: Math.ceil(P / M), error: null };
  }

  const monthlyInterest = r * P;
  if (M <= monthlyInterest) {
    return {
      months: null,
      error: `This payment (${formatMoney(M)}) doesn't cover the month's interest (${formatMoney(monthlyInterest)}). Increase the payment to make progress.`,
    };
  }

  const months = -Math.log(1 - (r * P) / M) / Math.log(1 + r);
  return { months: Math.ceil(months), error: null };
}

function orderDebtsSnowball(debts) {
  return [...debts].sort((a, b) => Number(a.currentBalance) - Number(b.currentBalance));
}

function orderDebtsAvalanche(debts) {
  return [...debts].sort((a, b) => Number(b.interestRate) - Number(a.interestRate));
}

function orderDebts(debts, strategy) {
  const active = debts.filter((d) => Number(d.currentBalance) > 0);
  const paidOff = debts.filter((d) => Number(d.currentBalance) <= 0);
  const ordered = strategy === "avalanche" ? orderDebtsAvalanche(active) : orderDebtsSnowball(active);
  return [...ordered, ...paidOff];
}

function findBillPayment(transactions, billId, monthKey) {
  return transactions.find((t) => t.billId === billId && monthKeyOf(t.date) === monthKey);
}

/**
 * Moves a bill to another expense category, along with every payment already
 * logged for it, so the budget grid never disagrees with the bill. Returns how
 * many payments moved, or null if the bill or category isn't valid.
 */
function recategorizeBill(data, billId, categoryId) {
  const bill = data.bills.find((b) => b.id === billId);
  const category = data.categories.find((c) => c.id === categoryId);
  if (!bill || !category || category.type !== "expense") return null;
  bill.categoryId = categoryId;
  let moved = 0;
  data.transactions.forEach((t) => {
    if (t.billId === billId && t.categoryId !== categoryId) { t.categoryId = categoryId; moved++; }
  });
  return moved;
}

/**
 * Keeps a debt's balance in step with the payment transactions linked to it.
 * Pass the old transaction (or null when logging a new one) and the new one
 * (or null when deleting). Returns the new transaction with `debtApplied` set
 * to what was really deducted, so an over-payment can be undone exactly.
 */
function adjustDebtForTransactionChange(data, oldTxn, newTxn) {
  const debtFor = (t) => (t && t.debtId ? data.debts.find((d) => d.id === t.debtId) : null);
  const oldDebt = debtFor(oldTxn);
  if (oldDebt) {
    const undone = Number(oldTxn.debtApplied !== undefined ? oldTxn.debtApplied : oldTxn.amount) || 0;
    oldDebt.currentBalance = roundCents(Number(oldDebt.currentBalance || 0) + undone);
  }
  const newDebt = debtFor(newTxn);
  if (!newDebt) return newTxn;
  const applied = Math.min(Number(newTxn.amount) || 0, Number(newDebt.currentBalance) || 0);
  newDebt.currentBalance = roundCents(Number(newDebt.currentBalance || 0) - applied);
  return { ...newTxn, debtApplied: applied };
}

/* ---------- Pay period ----------
   All periods are computed as [start, end) with `end` being the exact
   next payday, so "days in this period" and "next payday" fall out of
   the same calculation for every frequency. */

function clampDayOfMonth(year, month, day) {
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  return Math.min(day, daysInMonth);
}

function payPeriodRolling(anchorDateStr, stepDays, today) {
  const anchor = new Date(anchorDateStr + "T00:00:00");
  if (isNaN(anchor)) return null;
  // Count calendar days with UTC arithmetic (no daylight-saving hours), then
  // step with addDays so every period still starts at local midnight.
  const diffDays = Math.round(
    (Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()) -
      Date.UTC(anchor.getFullYear(), anchor.getMonth(), anchor.getDate())) / 86400000
  );
  const periodsElapsed = Math.floor(diffDays / stepDays);
  const start = addDays(anchor, periodsElapsed * stepDays);
  return { start, end: addDays(start, stepDays) };
}

function payPeriodMonthly(anchorDateStr, today) {
  const anchor = new Date(anchorDateStr + "T00:00:00");
  if (isNaN(anchor)) return null;
  const payDay = anchor.getDate();
  const y = today.getFullYear();
  const m = today.getMonth();
  const thisMonthPayday = new Date(y, m, clampDayOfMonth(y, m, payDay));
  if (today >= thisMonthPayday) {
    return { start: thisMonthPayday, end: new Date(y, m + 1, clampDayOfMonth(y, m + 1, payDay)) };
  }
  return { start: new Date(y, m - 1, clampDayOfMonth(y, m - 1, payDay)), end: thisMonthPayday };
}

function payPeriodSemiMonthly1and15(today) {
  const y = today.getFullYear();
  const m = today.getMonth();
  const day = today.getDate();
  if (day < 15) return { start: new Date(y, m, 1), end: new Date(y, m, 15) };
  return { start: new Date(y, m, 15), end: new Date(y, m + 1, 1) };
}

function payPeriodSemiMonthly15andLast(today) {
  const y = today.getFullYear();
  const m = today.getMonth();
  const day = today.getDate();
  const thisLast = new Date(y, m + 1, 0).getDate();
  if (day < 15) {
    const prevLast = new Date(y, m, 0).getDate();
    return { start: new Date(y, m - 1, prevLast), end: new Date(y, m, 15) };
  }
  if (day < thisLast) return { start: new Date(y, m, 15), end: new Date(y, m, thisLast) };
  return { start: new Date(y, m, thisLast), end: new Date(y, m + 1, 15) };
}

function getPayPeriod(paySchedule, today) {
  if (!paySchedule) return null;
  switch (paySchedule.frequency) {
    case "weekly": return payPeriodRolling(paySchedule.anchorDate, 7, today);
    case "biweekly": return payPeriodRolling(paySchedule.anchorDate, 14, today);
    case "monthly": return payPeriodMonthly(paySchedule.anchorDate, today);
    case "semimonthly-1-15": return payPeriodSemiMonthly1and15(today);
    case "semimonthly-15-last": return payPeriodSemiMonthly15andLast(today);
    default: return null;
  }
}

/** Every real calendar date a day-of-month bill falls on within [start, end). */
function billDueDatesInRange(dueDay, start, end) {
  const dates = [];
  let cursor = new Date(start.getFullYear(), start.getMonth(), 1);
  const lastMonth = new Date(end.getFullYear(), end.getMonth(), 1);
  while (cursor <= lastMonth) {
    const day = clampDayOfMonth(cursor.getFullYear(), cursor.getMonth(), dueDay);
    const candidate = new Date(cursor.getFullYear(), cursor.getMonth(), day);
    if (candidate >= start && candidate < end) dates.push(candidate);
    cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
  }
  return dates;
}

function getBillsDueInPeriod(bills, paySchedule, today, transactions = []) {
  const period = getPayPeriod(paySchedule, today);
  if (!period) return null;
  const due = [];
  bills
    .filter((b) => b.dueDay)
    .forEach((b) => {
      billDueDatesInRange(b.dueDay, period.start, period.end).forEach((date) => {
        // Paid means a payment was logged in the month the bill falls due.
        const paid = findBillPayment(transactions, b.id, toLocalISODate(date).slice(0, 7)) || null;
        due.push({ bill: b, date, paid });
      });
    });
  due.sort((a, b) => a.date - b.date);
  const sum = (items) => roundCents(items.reduce((total, { bill }) => total + Number(bill.amount || 0), 0));
  return {
    ...period,
    due,
    noDueDay: bills.filter((b) => !b.dueDay),
    total: sum(due),
    remaining: sum(due.filter((x) => !x.paid)),
  };
}

/** Sorts bills for display: by due day (no due day last), by name, or by category. */
function sortBills(bills, mode, categories = []) {
  const name = (b) => String(b.name || "").toLowerCase();
  const day = (b) => (b.dueDay ? Number(b.dueDay) : 99);
  const catName = (b) => {
    const c = categories.find((x) => x.id === b.categoryId) || categories.find((x) => x.id === "bills");
    return c ? c.name.toLowerCase() : "";
  };
  const byName = (a, b) => name(a).localeCompare(name(b));
  const compare = {
    name: byName,
    category: (a, b) => catName(a).localeCompare(catName(b)) || day(a) - day(b) || byName(a, b),
    due: (a, b) => day(a) - day(b) || byName(a, b),
  }[mode] || byName;
  return [...bills].sort(compare);
}

/**
 * Logs a payment for a bill. If the bill is linked to a debt, the payment also
 * lowers that debt's balance (and is recorded so it can be undone exactly).
 */
function recordBillPayment(data, bill, date, amount, id) {
  const category = data.categories.find((c) => c.id === bill.categoryId) || data.categories.find((c) => c.id === "bills") || data.categories.find((c) => c.type === "expense");
  const txn = { id, type: "expense", date, categoryId: category ? category.id : "bills", description: `Bill: ${bill.name}`, amount, billId: bill.id };
  if (bill.debtId && data.debts.some((d) => d.id === bill.debtId)) txn.debtId = bill.debtId;
  const saved = adjustDebtForTransactionChange(data, null, txn);
  data.transactions.push(saved);
  return saved;
}

/** Deletes a transaction (giving any debt payment back to its balance) and marks it deleted for sync. */
function removeTransaction(data, txnId) {
  const txn = data.transactions.find((t) => t.id === txnId);
  if (!txn) return false;
  adjustDebtForTransactionChange(data, txn, null);
  data.transactions = data.transactions.filter((t) => t.id !== txnId);
  data.tombstones.push(`transaction:${txnId}`);
  return true;
}

/**
 * Reminder text for a GitHub token that expires on `expiresOn` (YYYY-MM-DD, as
 * shown on GitHub). GitHub doesn't let a web page read the real expiry, so each
 * device is told the date. Returns null when there's nothing to say yet.
 */
function tokenExpiryNotice(expiresOn, today, warnDays = 14) {
  if (!expiresOn) return null;
  const end = new Date(expiresOn + "T00:00:00");
  if (isNaN(end)) return null;
  const daysLeft = Math.round((Date.UTC(end.getFullYear(), end.getMonth(), end.getDate()) - Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())) / 86400000);
  const when = end.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  if (daysLeft < 0) return { level: "expired", daysLeft, message: `Your GitHub access token expired on ${when}, so syncing has stopped. Add a new token in Settings.` };
  if (daysLeft === 0) return { level: "soon", daysLeft, message: "Your GitHub access token expires today. Add a new token in Settings." };
  if (daysLeft <= warnDays) return { level: "soon", daysLeft, message: `Your GitHub access token expires in ${daysLeft} day${daysLeft === 1 ? "" : "s"} (${when}). Make a new one and add it in Settings before then.` };
  return null;
}

/* ---------- Regular paychecks ----------
   A paycheck source ({id, name, amount, categoryId, frequency, anchorDate,
   startedOn}) is entered once; each payday it becomes an ordinary income
   transaction. The transaction id is built from the source and the date, so
   two devices that both add the same paycheck produce the same record and the
   sync merge keeps just one. */

const PAY_FREQUENCIES = [
  ["weekly", "Weekly"],
  ["biweekly", "Every 2 weeks"],
  ["semimonthly-1-15", "Twice a month (1st & 15th)"],
  ["semimonthly-15-last", "Twice a month (15th & last day)"],
  ["monthly", "Monthly"],
];

function payFrequencyLabel(frequency) {
  const hit = PAY_FREQUENCIES.find(([value]) => value === frequency);
  return hit ? hit[1] : "";
}

function frequencyNeedsAnchor(frequency) {
  return frequency === "weekly" || frequency === "biweekly" || frequency === "monthly";
}

/** Is this calendar day a payday on the schedule? */
function isPayday(schedule, date) {
  if (!schedule) return false;
  const y = date.getFullYear();
  const m = date.getMonth();
  const day = date.getDate();
  const anchor = frequencyNeedsAnchor(schedule.frequency) ? new Date(schedule.anchorDate + "T00:00:00") : null;
  if (frequencyNeedsAnchor(schedule.frequency) && (!anchor || isNaN(anchor))) return false;
  switch (schedule.frequency) {
    case "weekly":
    case "biweekly": {
      const step = schedule.frequency === "weekly" ? 7 : 14;
      const diff = Math.round((Date.UTC(y, m, day) - Date.UTC(anchor.getFullYear(), anchor.getMonth(), anchor.getDate())) / 86400000);
      return ((diff % step) + step) % step === 0;
    }
    case "monthly": return day === clampDayOfMonth(y, m, anchor.getDate());
    case "semimonthly-1-15": return day === 1 || day === 15;
    case "semimonthly-15-last": return day === 15 || day === clampDayOfMonth(y, m, 31);
    default: return false;
  }
}

/** Every payday from fromISO to toISO, both included, as YYYY-MM-DD strings. */
function paydaysBetween(schedule, fromISO, toISO) {
  const out = [];
  const from = new Date(fromISO + "T00:00:00");
  const to = new Date(toISO + "T00:00:00");
  if (isNaN(from) || isNaN(to)) return out;
  let day = from;
  for (let n = 0; day <= to && n < 800; n++, day = addDays(day, 1)) {
    if (isPayday(schedule, day)) out.push(toLocalISODate(day));
  }
  return out;
}

/** The next payday on or after `from`, or null if the schedule can't be read. */
function nextPayday(schedule, from) {
  let day = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  for (let n = 0; n < 70; n++, day = addDays(day, 1)) {
    if (isPayday(schedule, day)) return day;
  }
  return null;
}

/**
 * Income transactions that are due but not yet in the Log: every payday from
 * the day the paycheck was set up through today. Paychecks the user deleted
 * (tombstoned) or already has are skipped, so deleting one sticks. Looks back
 * at most 400 days, so a device that was off for months still catches up.
 */
function duePaychecks(data, today) {
  const todayStr = toLocalISODate(today);
  const oldest = toLocalISODate(addDays(today, -400));
  const have = new Set(data.transactions.map((t) => t.id));
  const deleted = new Set(data.tombstones || []);
  const due = [];
  (data.recurringIncome || []).forEach((src) => {
    if (!src || !src.id || !(Number(src.amount) > 0)) return;
    const startedOn = src.startedOn || todayStr;
    const from = startedOn > oldest ? startedOn : oldest;
    const cat = data.categories.find((c) => c.id === src.categoryId && c.type === "income") || data.categories.find((c) => c.type === "income");
    paydaysBetween(src, from, todayStr).forEach((date) => {
      const id = `pay-${src.id}-${date}`;
      if (have.has(id) || deleted.has(`transaction:${id}`)) return;
      have.add(id);
      due.push({ id, type: "income", date, categoryId: cat ? cat.id : "income", description: src.name || "Paycheck", amount: roundCents(src.amount), paycheckId: src.id });
    });
  });
  return due;
}

/* ---------- Month-by-month history ---------- */

/** Income, spending and what's left for `count` months ending at `endMonthKey`, newest first. */
function monthlyHistory(data, endMonthKey, count) {
  const rows = [];
  for (let i = 0; i < count; i++) {
    const monthKey = shiftMonthKey(endMonthKey, -i);
    const t = monthTotals(data, monthKey);
    rows.push({ monthKey, income: t.income, expenses: t.expenses, leftOver: t.leftOver });
  }
  return rows;
}

/** "↑ $40.00 more than last month" — or null when nothing changed or there's nothing to compare. */
function describeChange(current, previous) {
  const diff = roundCents(current - previous);
  if (diff === 0) return null;
  return diff > 0 ? `↑ ${formatMoney(diff)} more than last month` : `↓ ${formatMoney(-diff)} less than last month`;
}

/* ---------- Printable bills list ---------- */

function ordinal(n) {
  const num = Number(n);
  const v = num % 100;
  if (v >= 11 && v <= 13) return num + "th";
  switch (num % 10) {
    case 1: return num + "st";
    case 2: return num + "nd";
    case 3: return num + "rd";
    default: return num + "th";
  }
}

/**
 * What goes on the large-print sheet. mode "month": every bill in due-day
 * order for the current month. mode "period": only the bills due before the
 * next payday (null if no payday is set up).
 */
function billsSheet(data, mode, today) {
  const short = (d) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const sum = (rows) => roundCents(rows.reduce((total, r) => total + r.amount, 0));
  if (mode === "period") {
    const r = getBillsDueInPeriod(data.bills, data.paySchedule, today, data.transactions);
    if (!r) return null;
    const rows = r.due.map(({ bill, date, paid }) => ({ name: bill.name, amount: roundCents(bill.amount), due: short(date), paid: !!paid }));
    return {
      title: "Bills due before next payday",
      subtitle: `${short(r.start)} – ${short(lastDayOfPeriod(r.end))} • Next payday ${short(r.end)}`,
      rows, total: sum(rows), skipped: r.noDueDay.map((b) => b.name),
    };
  }
  const monthKey = toLocalISODate(today).slice(0, 7);
  const rows = sortBills(data.bills, "due", data.categories).map((b) => ({
    name: b.name,
    amount: roundCents(b.amount),
    due: b.dueDay ? ordinal(b.dueDay) : "Any day",
    paid: !!findBillPayment(data.transactions, b.id, monthKey),
  }));
  return { title: `Bills for ${formatMonthLabel(monthKey)}`, subtitle: "Due on this day of each month", rows, total: sum(rows), skipped: [] };
}

/* ---------- Coming up (bills due soon) ---------- */

/**
 * Every bill falling due from today through `days` days ahead, paid or not
 * ("paid" means a payment was logged in the month the bill falls due).
 */
function billsComingUp(bills, transactions, today, days = 7) {
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const end = addDays(start, days + 1);
  const out = [];
  bills.filter((b) => b.dueDay).forEach((bill) => {
    billDueDatesInRange(bill.dueDay, start, end).forEach((date) => {
      out.push({ bill, date, paid: findBillPayment(transactions, bill.id, toLocalISODate(date).slice(0, 7)) || null });
    });
  });
  return out.sort((a, b) => a.date - b.date || String(a.bill.name).localeCompare(String(b.bill.name)));
}

/** "Today", "Tomorrow", or "Fri, Oct 16". */
function dayLabel(date, today) {
  const diff = Math.round((Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) - Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  return date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

/* ---------- Undo for deletions ---------- */

const UNDO_COLLECTIONS = ["transactions", "bills", "debts", "categories", "recurringIncome"];

/** A copy of everything a deletion can touch, to compare before and after. */
function snapshotForUndo(data) {
  const snap = { tombstones: [...(data.tombstones || [])] };
  UNDO_COLLECTIONS.forEach((name) => { snap[name] = JSON.parse(JSON.stringify(data[name] || [])); });
  return snap;
}

/**
 * Reverses one deletion. `before` / `after` are snapshots taken just before and
 * just after it. Puts back what it removed, takes back the delete-markers it
 * added, and restores any debt balance it changed (deleting a debt payment
 * gives money back to the debt). Anything done since is left alone.
 */
function undoDelete(data, before, after) {
  UNDO_COLLECTIONS.forEach((name) => {
    const present = new Set((data[name] || []).map((r) => r.id));
    const removedByDelete = (id) => !after[name].some((r) => r.id === id);
    before[name].forEach((record) => {
      if (!present.has(record.id) && removedByDelete(record.id)) data[name].push(record);
    });
  });
  const added = new Set(after.tombstones.filter((t) => !before.tombstones.includes(t)));
  data.tombstones = (data.tombstones || []).filter((t) => !added.has(t));
  data.debts.forEach((debt) => {
    const was = before.debts.find((d) => d.id === debt.id);
    const then = after.debts.find((d) => d.id === debt.id);
    if (was && then && was.currentBalance !== then.currentBalance && debt.currentBalance === then.currentBalance) {
      debt.currentBalance = was.currentBalance;
    }
  });
}

/* ---------- Debt-free date ---------- */

/**
 * Month-by-month payoff of every debt. Each month interest is added, every
 * debt gets its usual payment, and everything left in the pot (money freed up
 * by finished debts, plus `extra`) goes to the debt the strategy says to
 * focus on. Returns { months, interest } or { error }.
 */
function simulatePayoff(debts, strategy, extra = 0) {
  const live = debts
    .filter((d) => Number(d.currentBalance) > 0)
    .map((d) => ({ name: d.name, bal: Number(d.currentBalance), rate: (Number(d.interestRate) || 0) / 1200, min: Number(d.minPayment) || 0 }));
  if (!live.length) return { months: 0, interest: 0 };
  const missing = live.find((d) => d.min <= 0);
  if (missing) return { error: `Add a monthly payment for ${missing.name} to estimate when you'll be debt-free.` };
  const pot = live.reduce((sum, d) => sum + d.min, 0) + Math.max(0, Number(extra) || 0);
  let interest = 0;
  for (let month = 1; month <= 1200; month++) {
    live.forEach((d) => {
      if (d.bal <= 0) return;
      const charge = d.bal * d.rate;
      d.bal += charge;
      interest += charge;
    });
    let left = pot;
    live.forEach((d) => {
      if (d.bal <= 0) return;
      const pay = Math.min(d.min, d.bal);
      d.bal -= pay;
      left -= pay;
    });
    const order = live
      .filter((d) => d.bal > 0.005)
      .sort(strategy === "avalanche" ? (a, b) => b.rate - a.rate : (a, b) => a.bal - b.bal);
    for (const d of order) {
      if (left <= 0) break;
      const pay = Math.min(left, d.bal);
      d.bal -= pay;
      left -= pay;
    }
    if (live.every((d) => d.bal <= 0.005)) return { months: month, interest: roundCents(interest) };
  }
  return { error: "At the current payments some debts never get paid off. Raise a payment (or add extra) to see a date." };
}

/** "March 2029", counting `months` from today. */
function monthsFromNowLabel(today, months) {
  const d = new Date(today.getFullYear(), today.getMonth() + months, 1);
  return d.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

/* ---------- Searching the Log ---------- */

/** Transactions matching every word typed (description, category, date or amount), newest first. */
function searchTransactions(transactions, categories, query) {
  const words = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
  const nameOf = (t) => (categories.find((c) => c.id === t.categoryId) || {}).name || "";
  const matches = (t) => {
    const hay = [t.description, nameOf(t), t.date, String(t.amount), formatMoney(t.amount)].join(" ").toLowerCase();
    return words.every((w) => hay.includes(w.replace(/^\$/, "")));
  };
  return transactions.filter(matches).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}
