/* ==========================================================================
   Budget math: month keys, totals, and debt payoff calculations.
   ========================================================================== */

function monthKeyOf(dateStr) {
  return (dateStr || "").slice(0, 7); // "YYYY-MM-DD" -> "YYYY-MM"
}

function currentMonthKey() {
  return new Date().toISOString().slice(0, 7);
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
  const n = Number(amount) || 0;
  const sign = n < 0 ? "-" : "";
  return sign + "$" + Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function sumTransactions(transactions, { monthKey, categoryId, type } = {}) {
  return transactions
    .filter((t) => (monthKey ? monthKeyOf(t.date) === monthKey : true))
    .filter((t) => (categoryId ? t.categoryId === categoryId : true))
    .filter((t) => (type ? t.type === type : true))
    .reduce((sum, t) => sum + Number(t.amount || 0), 0);
}

function monthTotals(data, monthKey) {
  const income = sumTransactions(data.transactions, { monthKey, type: "income" });
  const expenses = sumTransactions(data.transactions, { monthKey, type: "expense" });
  const debtRemaining = data.debts.reduce((sum, d) => sum + Math.max(0, Number(d.currentBalance || 0)), 0);
  return { income, expenses, leftOver: income - expenses, debtRemaining };
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
