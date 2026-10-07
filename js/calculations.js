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

function getBillsDueInPeriod(bills, paySchedule, today) {
  const period = getPayPeriod(paySchedule, today);
  if (!period) return null;
  const due = [];
  bills
    .filter((b) => b.dueDay)
    .forEach((b) => {
      billDueDatesInRange(b.dueDay, period.start, period.end).forEach((date) => due.push({ bill: b, date }));
    });
  due.sort((a, b) => a.date - b.date);
  return { ...period, due, noDueDay: bills.filter((b) => !b.dueDay) };
}
