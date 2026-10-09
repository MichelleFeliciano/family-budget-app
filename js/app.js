/* ==========================================================================
   Our Family Budget — app logic (state, rendering, event wiring).
   ========================================================================== */

const state = {
  data: null,
  githubConfig: null,
  view: "dashboard",
  month: currentMonthKey(),
  txnShowAll: false,
  debtStrategy: "snowball",
  sha: null,
  saveTimer: null,
  editSeq: 0,
  billSort: getBillSort(),
  historyMonths: 6,
  txnQuery: "",
  extraDebtPayment: 0,
  syncHoldUntil: 0, // while an Undo is on offer, nothing is sent to GitHub
  repoPublic: null, // true when the GitHub repository holding the budget is public
};

/* ---------- Small helpers ---------- */

function byId(id) {
  return document.getElementById(id);
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function getCategory(id) {
  return state.data.categories.find((c) => c.id === id);
}

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function categoryOptions(type, selectedId) {
  const opts = state.data.categories.filter((c) => c.type === type);
  if (!opts.length) return '<option value="">No categories yet</option>';
  return opts
    .map((c) => `<option value="${c.id}" ${c.id === selectedId ? "selected" : ""}>${escapeHtml(c.name)}</option>`)
    .join("");
}

function showToast(msg) {
  const root = byId("toast-root");
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  root.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

const UNDO_WINDOW_MS = 8000;

// A message with an Undo button. Only one is offered at a time.
function showUndoToast(msg, onUndo) {
  const root = byId("toast-root");
  root.querySelectorAll(".toast-undo").forEach((t) => t.remove());
  const el = document.createElement("div");
  el.className = "toast toast-undo";
  const text = document.createElement("span");
  text.textContent = msg;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "toast-btn";
  btn.textContent = "Undo";
  el.append(text, btn);
  root.appendChild(el);
  const timer = setTimeout(() => el.remove(), UNDO_WINDOW_MS);
  btn.addEventListener("click", () => {
    clearTimeout(timer);
    el.remove();
    onUndo();
  });
}

// Deletes, then offers Undo for a few seconds. Syncing is held back for that
// long: once a deletion reaches GitHub it is permanent on every device, so
// until then it can still be taken back cleanly.
function deleteWithUndo(message, fn) {
  const before = snapshotForUndo(state.data);
  state.syncHoldUntil = Date.now() + UNDO_WINDOW_MS + 1000;
  mutateData(fn);
  const after = snapshotForUndo(state.data);
  showUndoToast(message, () => {
    state.syncHoldUntil = 0;
    mutateData((d) => undoDelete(d, before, after));
    showToast("Put back");
  });
}

function openModal(html) {
  byId("modal-root").innerHTML = `<div class="modal-backdrop" id="modal-backdrop"><div class="modal">${html}</div></div>`;
  byId("modal-backdrop").addEventListener("click", (e) => {
    if (e.target.id === "modal-backdrop") closeModal();
  });
}

function closeModal() {
  byId("modal-root").innerHTML = "";
}

function confirmAction(message, onConfirm) {
  openModal(`
    <h2>Are you sure?</h2>
    <p>${escapeHtml(message)}</p>
    <div class="modal-actions">
      <button type="button" class="btn" data-action="modal-cancel">Cancel</button>
      <button type="button" class="btn btn-danger" id="confirm-yes-btn">Yes, Continue</button>
    </div>
  `);
  byId("confirm-yes-btn").addEventListener("click", onConfirm);
}

/* ---------- Data mutation + sync ---------- */

function mutateData(fn, { render: shouldRender = true } = {}) {
  fn(state.data);
  state.data.lastUpdated = new Date().toISOString();
  state.editSeq++;
  saveLocalData(state.data);
  if (state.githubConfig) setDirty(true);
  scheduleSync();
  if (shouldRender) render();
}

function setSyncStatus(kind, text) {
  const el = byId("sync-status");
  if (!el) return;
  el.textContent = text;
  el.className = "sync-status" + (kind ? " " + kind : "");
}

function scheduleSync() {
  if (!state.githubConfig) {
    setSyncStatus("", "Saved on this device");
    return;
  }
  setSyncStatus("syncing", "Saving…");
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(async () => {
    // Only mark "synced" if nothing was edited while this push was in flight.
    const seq = state.editSeq;
    const markPushed = () => { if (state.editSeq === seq) setDirty(false); };
    try {
      state.sha = await syncPush(state.githubConfig, state.data, state.sha);
      markPushed();
      setSyncStatus("ok", "Synced");
    } catch (e) {
      console.error("Push failed, retrying after a fresh merge:", e);
      try {
        const { data, sha } = await syncPull(state.githubConfig);
        state.data = data;
        state.sha = await syncPush(state.githubConfig, state.data, sha);
        markPushed();
        setSyncStatus("ok", "Synced");
        render();
      } catch (retryErr) {
        console.error(retryErr);
        setSyncStatus("error", describeSyncError(retryErr));
      }
    }
  }, Math.max(1200, state.syncHoldUntil - Date.now()));
}

async function pullAndMergeSilently() {
  if (!state.githubConfig) return;
  try {
    setSyncStatus("syncing", "Checking for updates…");
    const { data, sha } = await syncPull(state.githubConfig);
    state.data = data;
    state.sha = sha;
    setSyncStatus("ok", "Synced");
    addDuePaychecks(); // after merging, so this device never invents a paycheck another one already removed
    if (!byId("app").classList.contains("hidden")) render();
    if (isDirty()) scheduleSync(); // changes from an earlier session or a failed save
  } catch (e) {
    console.error(e);
    setSyncStatus("error", describeSyncError(e));
  }
}

/* ---------- Lock screen ---------- */

function updateLockScreenMode() {
  const needsSetup = !state.data.passphraseHash;
  byId("setup-form").classList.toggle("hidden", !needsSetup);
  byId("unlock-form").classList.toggle("hidden", needsSetup);
  if (!state.githubConfig) byId("github-connect-details").open = true;
}

function wireLockScreen() {
  byId("unlock-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = byId("passphrase-input").value;
    const hash = await sha256Hex(input);
    if (hash === state.data.passphraseHash) {
      setUnlockedOnThisDevice(hash);
      showApp();
    } else {
      byId("lock-error").textContent = "That passphrase is not correct.";
      byId("lock-error").classList.remove("hidden");
    }
  });

  byId("setup-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const p1 = byId("new-passphrase-1").value;
    const p2 = byId("new-passphrase-2").value;
    const errEl = byId("setup-error");
    if (p1.length < 4) {
      errEl.textContent = "Please use at least 4 characters.";
      errEl.classList.remove("hidden");
      return;
    }
    if (p1 !== p2) {
      errEl.textContent = "Those don't match — try again.";
      errEl.classList.remove("hidden");
      return;
    }
    errEl.classList.add("hidden");
    const hash = await sha256Hex(p1);
    mutateData((d) => { d.passphraseHash = hash; });
    setUnlockedOnThisDevice(hash);
    showApp();
  });

  byId("gh-connect-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const owner = byId("gh-owner").value.trim();
    const repo = byId("gh-repo").value.trim();
    const token = byId("gh-token").value.trim();
    const statusEl = byId("gh-connect-status");
    if (!owner || !repo || !token) {
      statusEl.textContent = "Please fill in all three fields.";
      return;
    }
    statusEl.textContent = "Connecting…";
    const config = { owner, repo, token, tokenExpires: byId("gh-expires").value || null };
    try {
      const { data, sha } = await syncPull(config);
      saveGithubConfig(config);
      state.githubConfig = config;
      checkRepoVisibility(true);
      state.data = data;
      state.sha = sha;
      if (sha === null && state.data.passphraseHash) {
        state.sha = await syncPush(config, state.data, null);
        statusEl.textContent = "Connected! This device's data was backed up to GitHub.";
      } else {
        statusEl.textContent = "Connected! " + (data.passphraseHash ? "Enter the passphrase above." : "No passphrase set yet — create one above.");
      }
      updateLockScreenMode();
      if (isUnlockedOnThisDevice(state.data.passphraseHash)) showApp();
    } catch (err) {
      console.error(err);
      statusEl.textContent = "Could not connect. Check the username, repository name, and token.";
    }
  });
}

function showApp() {
  byId("lock-screen").classList.add("hidden");
  byId("app").classList.remove("hidden");
  render();
}

/* ---------- App shell wiring ---------- */

function wireApp() {
  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.view = btn.dataset.view;
      render();
    });
  });
  byId("view-container").addEventListener("click", handleViewClick);
  byId("view-container").addEventListener("change", handleViewChange);
  byId("view-container").addEventListener("input", (e) => {
    if (e.target.id !== "txn-search") return;
    state.txnQuery = e.target.value;
    byId("txn-results").innerHTML = renderTransactionResults();
    byId("txn-search-clear").classList.toggle("hidden", !state.txnQuery);
  });
  byId("modal-root").addEventListener("click", (e) => {
    if (e.target.closest('[data-action="modal-cancel"]')) closeModal();
  });
  window.addEventListener("online", pullAndMergeSilently);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && !byId("app").classList.contains("hidden")) {
      if (state.githubConfig) pullAndMergeSilently();
      else if (addDuePaychecks()) render(); // the app stayed open past midnight
    }
  });
}

function handleViewClick(e) {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  const action = btn.dataset.action;
  switch (action) {
    case "month-prev": state.month = shiftMonthKey(state.month, -1); render(); break;
    case "month-next": state.month = shiftMonthKey(state.month, 1); render(); break;
    case "toggle-show-all": state.txnShowAll = !state.txnShowAll; render(); break;
    case "open-add-transaction": openTransactionModal(null); break;
    case "edit-transaction": openTransactionModal(state.data.transactions.find((t) => t.id === btn.dataset.id)); break;
    case "open-add-debt": openDebtModal(null); break;
    case "edit-debt": openDebtModal(state.data.debts.find((d) => d.id === btn.dataset.id)); break;
    case "log-payment": openLogPaymentModal(state.data.debts.find((d) => d.id === btn.dataset.id)); break;
    case "open-pay-schedule": openPayScheduleModal(); break;
    case "clear-search": state.txnQuery = ""; render(); byId("txn-search").focus(); break;
    case "open-add-goal": openGoalModal(null); break;
    case "edit-goal": openGoalModal(state.data.goals.find((g) => g.id === btn.dataset.id)); break;
    case "add-to-goal": openAddToGoalModal(state.data.goals.find((g) => g.id === btn.dataset.id)); break;
    case "open-add-paycheck": openPaycheckModal(null); break;
    case "edit-paycheck": openPaycheckModal(state.data.recurringIncome.find((p) => p.id === btn.dataset.id)); break;
    case "open-month": state.month = btn.dataset.month; render(); window.scrollTo(0, 0); break;
    case "toggle-history": state.historyMonths = state.historyMonths === 6 ? 12 : 6; render(); break;
    case "print-bills": openPrintBillsModal(); break;
    case "open-add-bill": openBillModal(null); break;
    case "edit-bill": openBillModal(state.data.bills.find((b) => b.id === btn.dataset.id)); break;
    case "mark-bill-paid": openMarkBillPaidModal(state.data.bills.find((b) => b.id === btn.dataset.id), btn.dataset.due); break;
    case "undo-bill-payment":
      confirmAction("Remove this payment record?", () => {
        deleteWithUndo("Payment removed", (d) => { removeTransaction(d, btn.dataset.txnId); });
        closeModal();
      });
      break;
    case "set-strategy": state.debtStrategy = btn.dataset.strategy; render(); break;
    case "open-add-category": openCategoryModal(null); break;
    case "edit-category": openCategoryModal(state.data.categories.find((c) => c.id === btn.dataset.id)); break;
    case "open-change-passphrase": openChangePassphraseModal(); break;
    case "save-github-config": handleSaveGithubConfig(); break;
    case "sync-now": handleSyncNow(); break;
    case "disconnect-github": handleDisconnectGithub(); break;
    case "export-data": handleExportData(); break;
    case "trigger-import": byId("import-file-input").click(); break;
    case "reset-data": handleResetData(); break;
    case "set-text-size": setTextSize(btn.dataset.size); applyTextSize(); render(); break;
    case "lock-now": handleLockNow(); break;
  }
}

function handleViewChange(e) {
  const el = e.target;
  if (el.matches(".planned-input")) {
    const catId = el.dataset.categoryId;
    const value = Math.abs(Number(el.value) || 0);
    mutateData((d) => {
      // The first change in a month that was showing a carried-over plan saves the whole plan for this month.
      d.budgetPlan[state.month] = { ...planForMonth(d.budgetPlan, state.month).plan, [catId]: value };
    }, { render: false });
    // Redrawing destroys the input the user is tabbing into, which dropped
    // their place after every amount. Wait for focus to land on the next
    // field, redraw, then put focus back on that same field.
    setTimeout(renderKeepingFocus, 0);
  }
  if (el.id === "extra-debt-select") {
    state.extraDebtPayment = Number(el.value) || 0;
    renderKeepingFocus();
  }
  if (el.id === "bill-sort-select") {
    state.billSort = el.value;
    setBillSort(el.value);
    renderKeepingFocus();
  }
  if (el.matches(".bill-cat-select")) {
    const billName = (state.data.bills.find((b) => b.id === el.dataset.billId) || {}).name;
    let moved = null;
    mutateData((d) => { moved = recategorizeBill(d, el.dataset.billId, el.value); }, { render: false });
    setTimeout(renderKeepingFocus, 0);
    if (moved !== null) showToast(moved > 0 ? `${billName} moved, along with ${moved} logged payment${moved === 1 ? "" : "s"}` : `${billName} moved to ${getCategory(el.value).name}`);
  }
  if (el.id === "import-file-input") {
    handleImportFile(el.files[0]);
  }
}

/* ---------- Alerts, text size, repository safety ---------- */

// One banner at the top of the app for things that need attention.
function updateAlertBanner() {
  const banner = byId("alert-banner");
  if (!banner) return;
  const notes = [];
  if (state.repoPublic) {
    notes.push({ red: true, text: "Your budget is saved in a PUBLIC GitHub repository, so anyone can read it. Switch to a private repository in Settings." });
  }
  const notice = state.githubConfig ? tokenExpiryNotice(state.githubConfig.tokenExpires, new Date()) : null;
  if (notice) notes.push({ red: notice.level === "expired", text: notice.message });
  banner.classList.toggle("hidden", notes.length === 0);
  banner.classList.toggle("expired", notes.some((n) => n.red));
  banner.innerHTML = notes.map((n) => `<div>${escapeHtml(n.text)}</div>`).join("");
}

function applyTextSize() {
  const size = getTextSize();
  if (size === "normal") delete document.documentElement.dataset.textSize;
  else document.documentElement.dataset.textSize = size;
}

// Asks GitHub whether the repository holding the budget is public. Only ever
// warns; if GitHub can't say, nothing is shown.
async function checkRepoVisibility(announce) {
  if (!state.githubConfig) { state.repoPublic = null; return; }
  const isPublic = await githubRepoIsPublic(state.githubConfig);
  state.repoPublic = isPublic === true;
  if (isPublic === true && announce) showToast("Warning: that repository is public — anyone can read your budget.");
  if (!byId("app").classList.contains("hidden")) render();
}

/* ---------- Render dispatcher ---------- */

// Redraws the screen, then puts keyboard focus back on the same control
// (found by its data-focus-key) so editing in place doesn't lose your spot.
function renderKeepingFocus() {
  const active = document.activeElement;
  const key = active && active.dataset ? active.dataset.focusKey : null;
  render();
  if (key) {
    const again = byId("view-container").querySelector(`[data-focus-key="${CSS.escape(key)}"]`);
    if (again) again.focus();
  }
}

function render() {
  updateAlertBanner();
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === state.view));
  const container = byId("view-container");
  if (state.view === "dashboard") container.innerHTML = renderDashboard();
  else if (state.view === "budget") container.innerHTML = renderBudget();
  else if (state.view === "transactions") container.innerHTML = renderTransactions();
  else if (state.view === "debts") container.innerHTML = renderDebts();
  else if (state.view === "settings") container.innerHTML = renderSettings();
}

/* ---------- Views ---------- */

function renderDashboard() {
  const totals = monthTotals(state.data, state.month);
  const cats = state.data.categories.filter((c) => c.type === "expense");
  const amounts = cats.map((c) => sumTransactions(state.data.transactions, { monthKey: state.month, categoryId: c.id, type: "expense" }));
  const maxCat = Math.max(1, ...amounts);
  // Only compare with last month once there is something to compare with.
  const prevKey = shiftMonthKey(state.month, -1);
  const hasPrev = sumTransactions(state.data.transactions, { monthKey: prevKey, type: "expense" }) > 0;

  const bars = cats.map((c, i) => {
    const amt = amounts[i];
    const pct = Math.round((amt / maxCat) * 100);
    const change = hasPrev ? describeChange(amt, sumTransactions(state.data.transactions, { monthKey: prevKey, categoryId: c.id, type: "expense" })) : null;
    return `<div class="bar-row">
      <div class="bar-label">${escapeHtml(c.name)}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${pct}%; background:${c.color};"></div></div>
      <div class="bar-amount">${formatMoney(amt)}</div>
      ${change ? `<div class="bar-change">${change}</div>` : ""}
    </div>`;
  }).join("");

  const anySpending = amounts.some((a) => a > 0);

  return `
    ${renderComingUpCard()}
    <div class="month-nav">
      <button class="btn btn-icon" data-action="month-prev" aria-label="Previous month">←</button>
      <div class="month-label">${formatMonthLabel(state.month)}</div>
      <button class="btn btn-icon" data-action="month-next" aria-label="Next month">→</button>
    </div>
    <div class="summary-grid">
      <div class="summary-card"><div class="label">Income</div><div class="value positive">${formatMoney(totals.income)}</div></div>
      <div class="summary-card"><div class="label">Expenses</div><div class="value">${formatMoney(totals.expenses)}</div></div>
      <div class="summary-card"><div class="label">Left Over</div><div class="value ${totals.leftOver >= 0 ? "positive" : "negative"}">${formatMoney(totals.leftOver)}</div></div>
      <div class="summary-card"><div class="label">Total Debt</div><div class="value">${formatMoney(totals.debtRemaining)}</div></div>
    </div>
    <div class="card">
      <h2>Spending by Category</h2>
      ${anySpending ? bars : '<p class="empty-state">No expenses logged yet this month.</p>'}
    </div>
    ${renderGoalsCard()}
    ${renderHistoryCard()}
    <button class="btn btn-primary btn-large" data-action="open-add-transaction">+ Add a Transaction</button>
  `;
}

// Savings goals with a progress bar and an Add Money button.
function renderGoalsCard() {
  const goals = state.data.goals;
  if (!goals.length) {
    return `
      <div class="card">
        <h2>🐷 Savings Goals</h2>
        <p class="help-text">Saving up for something? Add a goal and watch it grow.</p>
        <button class="btn btn-large" data-action="open-add-goal">+ Add a Savings Goal</button>
      </div>`;
  }
  const items = goals.map((g) => {
    const saved = goalSaved(state.data, g);
    const target = Number(g.target) || 0;
    const pct = target > 0 ? Math.min(100, Math.round((saved / target) * 100)) : 0;
    const done = target > 0 && saved >= target;
    return `
      <div class="goal-item">
        <div class="goal-head"><strong>${escapeHtml(g.name)}</strong>${done ? '<span class="focus-badge">🎉 Goal reached!</span>' : ""}</div>
        <div class="debt-progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" aria-label="${escapeHtml(g.name)} progress"><div class="goal-fill" style="width:${pct}%;"></div></div>
        <div class="goal-meta">${formatMoney(saved)} of ${formatMoney(target)} (${pct}%)${!done && target > saved ? ` • ${formatMoney(target - saved)} to go` : ""}</div>
        <div class="debt-actions">
          <button class="btn btn-primary" data-action="add-to-goal" data-id="${g.id}">Add Money</button>
          <button class="btn" data-action="edit-goal" data-id="${g.id}">Edit</button>
        </div>
      </div>`;
  }).join("");
  return `
    <div class="card">
      <h2>🐷 Savings Goals</h2>
      ${items}
      <button class="btn btn-link" data-action="open-add-goal">+ Add another goal</button>
    </div>`;
}

// Bills due in the next week that haven't been paid, with a Mark Paid button.
function renderComingUpCard() {
  if (!state.data.bills.some((b) => b.dueDay)) return "";
  const today = new Date();
  const soon = billsComingUp(state.data.bills, state.data.transactions, today, 7);
  const unpaid = soon.filter((x) => !x.paid);
  const late = overdueBills(state.data.bills, state.data.transactions, today);
  const paidCount = soon.length - unpaid.length;
  const total = roundCents(unpaid.reduce((sum, { bill }) => sum + Number(bill.amount || 0), 0));
  const row = (bill, label, dueDate) => `
    <div class="bill-item">
      <div class="bill-main">
        <div class="bill-name">${escapeHtml(bill.name)}</div>
        <div class="bill-meta"><strong>${label}</strong> • ${formatMoney(bill.amount)}</div>
      </div>
      <button class="btn btn-primary" data-action="mark-bill-paid" data-id="${bill.id}" data-due="${toLocalISODate(dueDate)}">Mark Paid</button>
    </div>`;
  const lateBlock = late.length ? `
      <h3 class="overdue-title">Not marked paid yet</h3>
      <p class="help-text">These were due earlier this month. If you already paid them, tap Mark Paid so it's recorded.</p>
      ${late.map(({ bill, date }) => row(bill, `Was due ${formatShortDate(date)}`, date)).join("")}
      <h3 class="upcoming-title">Next 7 days</h3>` : "";
  return `
    <div class="card coming-up">
      <h2>⏰ ${late.length ? "Bills" : "Coming Up — Next 7 Days"}</h2>
      ${lateBlock}
      ${unpaid.length ? unpaid.map(({ bill, date }) => row(bill, dayLabel(date, today), date)).join("") : `<p class="help-text">${soon.length ? "Everything due this week is paid ✓" : "No bills are due in the next 7 days."}</p>`}
      ${unpaid.length ? `<div class="budget-total-row"><span>Still to pay this week</span><span>${formatMoney(total)}</span></div>` : ""}
      ${unpaid.length && paidCount ? `<p class="help-text">${paidCount} more already paid ✓</p>` : ""}
    </div>`;
}

// Income, spending and what was left for each recent month, newest first.
// Tapping a month opens it.
function renderHistoryCard() {
  const all = monthlyHistory(state.data, currentMonthKey(), 12);
  const hasData = (r) => r.income > 0 || r.expenses > 0;
  // Leave out the empty months from before anything was logged.
  const oldest = all.map(hasData).lastIndexOf(true);
  if (oldest === -1) return "";
  const logged = all.slice(0, oldest + 1);
  const rows = logged.slice(0, state.historyMonths);
  const maxSpent = Math.max(1, ...rows.map((r) => r.expenses));
  const lines = rows.map((r) => `
    <button class="history-row${r.monthKey === state.month ? " selected" : ""}" data-action="open-month" data-month="${r.monthKey}" aria-label="Open ${formatMonthLabel(r.monthKey)}">
      <span class="history-month">${formatMonthLabel(r.monthKey)}</span>
      <span class="history-spent">Spent ${formatMoney(r.expenses)}</span>
      <span class="history-bar"><span style="width:${Math.round((r.expenses / maxSpent) * 100)}%"></span></span>
      <span class="history-detail">Income ${formatMoney(r.income)} • ${r.leftOver >= 0 ? "Left over" : "Short by"} <strong class="${r.leftOver >= 0 ? "positive" : "negative"}">${formatMoney(Math.abs(r.leftOver))}</strong></span>
    </button>`).join("");
  return `
    <div class="card">
      <h2>📅 Month by Month</h2>
      <p class="help-text">Tap a month to open it.</p>
      ${lines}
      ${logged.length > 6 ? `<button class="btn btn-link" data-action="toggle-history">${state.historyMonths === 6 ? "Show 12 months" : "Show 6 months"}</button>` : ""}
    </div>`;
}

function renderBudget() {
  const cats = state.data.categories.filter((c) => c.type === "expense");
  const { plan, from: planFrom } = planForMonth(state.data.budgetPlan, state.month);

  const rows = cats.map((c) => {
    const planned = Number(plan[c.id] || 0);
    const actual = sumTransactions(state.data.transactions, { monthKey: state.month, categoryId: c.id, type: "expense" });
    const pct = planned > 0 ? Math.min(100, Math.round((actual / planned) * 100)) : actual > 0 ? 100 : 0;
    const over = planned > 0 && actual > planned;
    const barColor = over ? "var(--color-danger)" : pct >= 90 ? "var(--color-warning)" : c.color;
    return `
      <div class="budget-row">
        <span class="cat-pill"><span class="cat-dot" style="background:${c.color}"></span><span>${escapeHtml(c.name)}</span></span>
        <input type="number" min="0" step="0.01" class="planned-input" value="${planned || ""}" placeholder="0.00"
               data-category-id="${c.id}" data-focus-key="plan:${c.id}">
        <span class="actual-amount">${formatMoney(actual)}</span>
        <div class="budget-track-row"><div class="bar-track"><div class="bar-fill" style="width:${pct}%; background:${barColor};"></div></div></div>
      </div>`;
  }).join("");

  const totalPlanned = cats.reduce((s, c) => s + Number(plan[c.id] || 0), 0);
  const totalActual = sumTransactions(state.data.transactions, { monthKey: state.month, type: "expense" });

  return `
    <div class="month-nav">
      <button class="btn btn-icon" data-action="month-prev" aria-label="Previous month">←</button>
      <div class="month-label">${formatMonthLabel(state.month)}</div>
      <button class="btn btn-icon" data-action="month-next" aria-label="Next month">→</button>
    </div>
    <div class="card">
      <h2>Monthly Budget</h2>
      <p class="help-text">Type how much you plan to spend in each category. We'll fill in what you've actually spent.</p>
      ${planFrom ? `<p class="help-text carry-note">Showing ${escapeHtml(formatMonthLabel(planFrom))}'s plan. Change any amount to make this month's own.</p>` : ""}
      ${cats.length ? rows : '<p class="empty-state">No expense categories yet. Add one in Settings.</p>'}
      <div class="budget-total-row">
        <span>Total Spent</span>
        <span>${formatMoney(totalActual)}</span>
      </div>
      <p class="help-text">Planned total: ${formatMoney(totalPlanned)}</p>
    </div>
    ${renderPayPeriodSection()}
    ${renderPaychecksSection()}
    ${renderBillsSection()}
  `;
}

function formatShortDate(date) {
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function renderPaychecksSection() {
  const sources = state.data.recurringIncome;
  const rows = sources.map((p) => {
    const next = nextPayday(p, new Date());
    return `
      <div class="bill-item">
        <div class="bill-main">
          <div class="bill-name">${escapeHtml(p.name)}</div>
          <div class="bill-meta">${formatMoney(p.amount)} • ${escapeHtml(payFrequencyLabel(p.frequency))}${next ? ` • Next payday ${formatShortDate(next)}` : ""}</div>
        </div>
        <button class="btn btn-icon" data-action="edit-paycheck" data-id="${p.id}" aria-label="Edit paycheck">✏️</button>
      </div>`;
  }).join("");
  return `
    <div class="card">
      <h2>💵 Regular Paychecks</h2>
      <p class="help-text">Add a paycheck once and it is put in your Log as income on every payday.</p>
      ${sources.length ? rows : ""}
      <button class="btn btn-primary btn-large" style="margin-top:12px;" data-action="open-add-paycheck">+ Add a Paycheck</button>
    </div>`;
}

// Paychecks landing in this pay period, minus the bills due in it.
function renderCashFlow() {
  const flow = periodCashFlow(state.data, new Date());
  if (!flow) return "";
  return `
    <div class="cash-flow">
      <div class="flow-row"><span>Paychecks this period</span><span>${formatMoney(flow.income)}</span></div>
      <div class="flow-names">${flow.paychecks.map((p) => `${escapeHtml(p.name)}, ${shortISODate(p.date)}`).join(" • ")}</div>
      <div class="flow-row"><span>Bills due</span><span>− ${formatMoney(flow.bills)}</span></div>
      <div class="flow-row flow-left"><span>${flow.left >= 0 ? "Left after bills" : "Short by"}</span><span class="${flow.left >= 0 ? "positive" : "negative"}">${formatMoney(Math.abs(flow.left))}</span></div>
    </div>`;
}

function renderPayPeriodSection() {
  const ps = state.data.paySchedule;
  if (!ps) {
    return `
      <div class="card">
        <h2>💰 Pay Period</h2>
        <p class="help-text">Tell us when you get paid, and this will show which bills are due before your next paycheck.</p>
        <button class="btn btn-primary btn-large" data-action="open-pay-schedule">Set Up Payday</button>
      </div>`;
  }

  const result = getBillsDueInPeriod(state.data.bills, ps, new Date(), state.data.transactions);
  if (!result) {
    // Unrecognized or damaged pay schedule — offer to set it up again instead of breaking the whole tab.
    return `
      <div class="card">
        <h2>💰 Pay Period</h2>
        <p class="help-text">We couldn't read the saved payday settings. Please set them up again.</p>
        <button class="btn btn-primary btn-large" data-action="open-pay-schedule">Set Up Payday</button>
      </div>`;
  }
  const periodEndDisplay = lastDayOfPeriod(result.end);

  const rows = result.due.map(({ bill, date, paid }) => {
    const cat = getCategory(bill.categoryId) || getCategory("bills");
    return `
      <div class="bill-item${paid ? " is-paid" : ""}">
        <div class="bill-main">
          <div class="bill-name">${escapeHtml(bill.name)}</div>
          <div class="bill-meta">
            <span class="cat-dot" style="background:${cat ? cat.color : "var(--cat-other)"}"></span>${cat ? escapeHtml(cat.name) : ""} • Due ${formatShortDate(date)} • ${formatMoney(bill.amount)}
          </div>
        </div>
        ${paid
          ? `<span class="bill-paid-badge">✓ Paid ${formatMoney(paid.amount)}</span>`
          : `<button class="btn btn-primary" data-action="mark-bill-paid" data-id="${bill.id}" data-due="${toLocalISODate(date)}">Mark Paid</button>`}
      </div>`;
  }).join("");
  const allPaid = result.due.length > 0 && result.remaining === 0;

  return `
    <div class="card">
      <h2>💰 This Pay Period</h2>
      <p class="help-text">${formatShortDate(result.start)} – ${formatShortDate(periodEndDisplay)} • Next payday ${formatShortDate(result.end)}</p>
      ${result.due.length ? rows : '<p class="empty-state">No bills with a due date fall in this pay period.</p>'}
      ${result.due.length ? `<div class="budget-total-row"><span>${allPaid ? "All paid ✓" : "Still to pay"}</span><span>${formatMoney(result.remaining)}</span></div>
      <p class="help-text">Total due this pay period: ${formatMoney(result.total)}</p>` : ""}
      ${renderCashFlow()}
      ${result.noDueDay.length ? `<p class="help-text" style="margin-top:12px;">${result.noDueDay.length} bill${result.noDueDay.length === 1 ? "" : "s"} skipped here because they have no due date set: ${result.noDueDay.map((b) => escapeHtml(b.name)).join(", ")}</p>` : ""}
      <button class="btn btn-link" data-action="open-pay-schedule">Change payday settings</button>
    </div>`;
}

function renderBillsSection() {
  const bills = sortBills(state.data.bills, state.billSort, state.data.categories);

  const rows = bills.map((b) => {
    const paidTxn = findBillPayment(state.data.transactions, b.id, state.month);
    // A bill with no category (or a deleted one) counts as Bills & Utilities, so show that in the dropdown too.
    const cat = getCategory(b.categoryId) || getCategory("bills") || state.data.categories.find((c) => c.type === "expense");
    return `
      <div class="bill-item${paidTxn ? " is-paid" : ""}">
        <div class="bill-main">
          <div class="bill-name">${escapeHtml(b.name)}</div>
          <div class="bill-meta">${formatMoney(b.amount)}${b.dueDay ? ` • Due on the ${ordinal(b.dueDay)}` : ""}</div>
          <label class="bill-cat">
            <span class="cat-dot" style="background:${cat ? cat.color : "var(--cat-other)"}"></span>
            <select class="bill-cat-select" data-bill-id="${b.id}" data-focus-key="bill:${b.id}" aria-label="Category for ${escapeHtml(b.name)}">${categoryOptions("expense", cat ? cat.id : "")}</select>
          </label>
        </div>
        ${paidTxn
          ? `<span class="bill-paid-badge">✓ Paid ${formatMoney(paidTxn.amount)}</span>
             <button class="btn btn-link" data-action="undo-bill-payment" data-id="${b.id}" data-txn-id="${paidTxn.id}">Undo</button>`
          : `<button class="btn btn-primary" data-action="mark-bill-paid" data-id="${b.id}">Mark Paid</button>`}
        <button class="btn btn-icon" data-action="edit-bill" data-id="${b.id}" aria-label="Edit bill">✏️</button>
      </div>`;
  }).join("");

  return `
    <div class="card">
      <h2>🧾 Your Bills</h2>
      <p class="help-text">Add each bill on its own so you can check it off as you pay it.</p>
      ${bills.length > 1 ? `<div class="bill-sort"><label for="bill-sort-select">Sort by</label>
        <select id="bill-sort-select" data-focus-key="bill-sort">
          ${[["due", "Due day"], ["name", "Name"], ["category", "Category"]].map(([v, l]) => `<option value="${v}" ${state.billSort === v ? "selected" : ""}>${l}</option>`).join("")}
        </select></div>` : ""}
      ${bills.length ? rows : '<p class="empty-state">No bills added yet.</p>'}
      <button class="btn btn-primary btn-large" style="margin-top:12px;" data-action="open-add-bill">+ Add a Bill</button>
      ${bills.length ? '<button class="btn btn-large" style="margin-top:10px;" data-action="print-bills">🖨️ Print Bills List</button>' : ""}
    </div>
  `;
}

// The month navigator plus the list of transactions (or the search results).
function renderTransactionResults() {
  const query = state.txnQuery.trim();
  const list = query
    ? searchTransactions(state.data.transactions, state.data.categories, query)
    : state.data.transactions
        .filter((t) => (state.txnShowAll ? true : monthKeyOf(t.date) === state.month))
        .sort((a, b) => (a.date < b.date ? 1 : -1));

  const rows = list.map((t) => {
    const cat = getCategory(t.categoryId);
    return `
      <div class="txn-item">
        <span class="cat-dot" style="background:${cat ? cat.color : "var(--cat-other)"}"></span>
        <div class="txn-main">
          <div class="txn-desc">${escapeHtml(t.description)}</div>
          <div class="txn-meta">${escapeHtml(t.date)} • ${cat ? escapeHtml(cat.name) : "Uncategorized"}</div>
        </div>
        <div class="txn-amount ${t.type === "income" ? "income" : ""}">${t.type === "income" ? "+" : "-"}${formatMoney(t.amount)}</div>
        <div class="txn-actions">
          <button class="btn btn-icon" data-action="edit-transaction" data-id="${t.id}" aria-label="Edit transaction">✏️</button>
        </div>
      </div>`;
  }).join("");

  if (query) {
    const spent = sumTransactions(list, { type: "expense" });
    const got = sumTransactions(list, { type: "income" });
    return `
      <p class="search-summary"><strong>${list.length} match${list.length === 1 ? "" : "es"}</strong> in all months${spent ? ` • Spent ${formatMoney(spent)}` : ""}${got ? ` • Received ${formatMoney(got)}` : ""}</p>
      <div class="card">
        ${list.length ? rows : '<p class="empty-state">Nothing matches. Try fewer or different words.</p>'}
      </div>`;
  }
  return `
    <div class="month-nav">
      <button class="btn btn-icon" data-action="month-prev" aria-label="Previous month" ${state.txnShowAll ? "disabled" : ""}>←</button>
      <div class="month-label">${state.txnShowAll ? "All Transactions" : formatMonthLabel(state.month)}</div>
      <button class="btn btn-icon" data-action="month-next" aria-label="Next month" ${state.txnShowAll ? "disabled" : ""}>→</button>
    </div>
    <div style="text-align:center; margin-bottom:16px;">
      <button class="btn btn-link" data-action="toggle-show-all">${state.txnShowAll ? "Show current month only" : "Show all transactions"}</button>
    </div>
    <div class="card">
      ${list.length ? rows : '<p class="empty-state">No transactions yet.</p>'}
    </div>`;
}

function renderTransactions() {
  return `
    <div class="search-box">
      <label for="txn-search" class="search-label">🔍 Search</label>
      <input type="search" id="txn-search" value="${escapeHtml(state.txnQuery)}" placeholder="Store, category, date or amount" autocomplete="off" enterkeyhint="search">
      <button class="btn btn-link ${state.txnQuery ? "" : "hidden"}" id="txn-search-clear" data-action="clear-search">Clear</button>
    </div>
    <div id="txn-results">${renderTransactionResults()}</div>
    <button class="btn btn-primary btn-large" data-action="open-add-transaction">+ Add a Transaction</button>
  `;
}

function renderDebts() {
  const ordered = orderDebts(state.data.debts, state.debtStrategy);
  const firstActive = ordered.find((d) => Number(d.currentBalance) > 0);
  const focusId = firstActive ? firstActive.id : null;

  const cards = ordered.map((d) => {
    const pct = d.originalBalance > 0 ? Math.min(100, Math.round((1 - d.currentBalance / d.originalBalance) * 100)) : 0;
    const est = estimateMonthsToPayoff(d.currentBalance, d.interestRate, d.minPayment);
    const isFocus = d.id === focusId;
    const paidOff = Number(d.currentBalance) <= 0;
    return `
      <div class="card debt-card ${isFocus ? "focus" : ""}">
        ${isFocus ? '<span class="focus-badge">Focus this one first</span>' : ""}
        ${paidOff ? '<span class="focus-badge" style="background:var(--color-primary-tint); color:var(--color-primary-dark);">🎉 Paid off!</span>' : ""}
        <h3>${escapeHtml(d.name)}</h3>
        <div class="debt-progress-track"><div class="debt-progress-fill" style="width:${pct}%;"></div></div>
        <div class="debt-stats">
          <div><strong>${formatMoney(d.currentBalance)}</strong>owed now</div>
          <div><strong>${formatMoney(d.originalBalance)}</strong>starting balance</div>
          <div><strong>${d.interestRate || 0}%</strong>interest</div>
          <div><strong>${formatMoney(d.minPayment)}</strong>per month</div>
        </div>
        <p class="help-text">${est.error ? est.error : paidOff ? "Paid off — nice work." : `About ${est.months} month${est.months === 1 ? "" : "s"} left at this payment.`}</p>
        <div class="debt-actions">
          <button class="btn btn-primary" data-action="log-payment" data-id="${d.id}">Log Payment</button>
          <button class="btn" data-action="edit-debt" data-id="${d.id}">Edit</button>
        </div>
      </div>`;
  }).join("");

  return `
    <div class="strategy-toggle">
      <button class="btn ${state.debtStrategy === "snowball" ? "active" : ""}" data-action="set-strategy" data-strategy="snowball">Snowball (smallest first)</button>
      <button class="btn ${state.debtStrategy === "avalanche" ? "active" : ""}" data-action="set-strategy" data-strategy="avalanche">Avalanche (highest interest first)</button>
    </div>
    ${renderDebtFreeCard()}
    ${ordered.length ? cards : '<p class="empty-state">No debts added yet. Add one to start tracking payoff progress.</p>'}
    <button class="btn btn-primary btn-large" data-action="open-add-debt">+ Add a Debt</button>
  `;
}

// When everything will be paid off, and what a little extra each month would change.
function renderDebtFreeCard() {
  if (!state.data.debts.some((d) => Number(d.currentBalance) > 0)) return "";
  const today = new Date();
  const strategyName = state.debtStrategy === "avalanche" ? "Avalanche" : "Snowball";
  const base = simulatePayoff(state.data.debts, state.debtStrategy, 0);
  if (base.error) return `<div class="card"><h2>🎯 Debt-Free Date</h2><p class="help-text">${escapeHtml(base.error)}</p></div>`;
  const extra = Number(state.extraDebtPayment) || 0;
  const withExtra = extra > 0 ? simulatePayoff(state.data.debts, state.debtStrategy, extra) : null;
  const years = (m) => (m >= 24 ? `about ${Math.round(m / 12)} years` : `${m} month${m === 1 ? "" : "s"}`);
  const saving = withExtra && !withExtra.error && withExtra.months <= base.months
    ? `<p><strong>${monthsFromNowLabel(today, withExtra.months)}</strong> with an extra ${formatMoney(extra)} a month — ${base.months - withExtra.months > 0 ? `${years(base.months - withExtra.months)} sooner and ` : ""}${formatMoney(Math.max(0, base.interest - withExtra.interest))} less interest.</p>`
    : "";
  return `
    <div class="card">
      <h2>🎯 Debt-Free Date</h2>
      <div class="debt-free-date">${monthsFromNowLabel(today, base.months)}</div>
      <p class="help-text">About ${years(base.months)} from now if you keep making each payment and put what a paid-off debt frees up toward the next one (${strategyName}). Interest along the way: about ${formatMoney(base.interest)}.</p>
      <div class="form-group">
        <label for="extra-debt-select">What if you paid extra each month?</label>
        <select id="extra-debt-select" data-focus-key="extra-debt">
          ${[0, 25, 50, 100, 200].map((n) => `<option value="${n}" ${extra === n ? "selected" : ""}>${n === 0 ? "No extra" : "+ " + formatMoney(n) + " a month"}</option>`).join("")}
        </select>
      </div>
      ${saving}
    </div>`;
}

function renderSettings() {
  const cats = state.data.categories.map((c) => `
    <div class="category-list-item">
      <span class="color-swatch" style="background:${c.color}"></span>
      <span class="cat-name">${escapeHtml(c.name)} <span class="help-text">(${c.type})</span></span>
      <button class="btn btn-icon" data-action="edit-category" data-id="${c.id}" aria-label="Edit category">✏️</button>
    </div>`).join("");

  const gh = state.githubConfig;
  const statusOk = !!gh;

  return `
    <div class="settings-section">
      <h2>🔄 GitHub Sync</h2>
      <div class="status-line">
        <span class="status-dot ${statusOk ? "ok" : ""}"></span>
        <span>${statusOk ? `Connected to ${escapeHtml(gh.owner)}/${escapeHtml(gh.repo)}` : "Not connected — data is only saved on this device"}</span>
      </div>
      ${state.repoPublic ? '<div class="repo-warning">⚠️ This repository is PUBLIC — anyone on the internet can read your budget. Create a private repository for your data and connect to that instead.</div>' : ""}
      <div class="form-group">
        <label for="set-gh-owner">GitHub username</label>
        <input type="text" id="set-gh-owner" value="${gh ? escapeHtml(gh.owner) : ""}">
      </div>
      <div class="form-group">
        <label for="set-gh-repo">Data repository name</label>
        <input type="text" id="set-gh-repo" value="${gh ? escapeHtml(gh.repo) : ""}">
      </div>
      <div class="form-group">
        <label for="set-gh-token">Access token</label>
        <input type="password" id="set-gh-token" placeholder="${gh ? "Leave blank to keep current token" : ""}">
      </div>
      <div class="form-group">
        <label for="set-gh-expires">Token expires on (optional)</label>
        <input type="date" id="set-gh-expires" value="${gh && gh.tokenExpires ? escapeHtml(gh.tokenExpires) : ""}">
        <p class="help-text">GitHub shows this date when you make the token. We'll remind you two weeks before it runs out.</p>
      </div>
      ${gh && !gh.tokenExpires ? '<p class="help-text">No expiry date entered, so there will be no reminder before the token runs out.</p>' : ""}
      <div style="display:flex; gap:10px; flex-wrap:wrap;">
        <button class="btn btn-primary" data-action="save-github-config">Save &amp; Connect</button>
        ${statusOk ? '<button class="btn" data-action="sync-now">Sync Now</button>' : ""}
        ${statusOk ? '<button class="btn btn-danger" data-action="disconnect-github">Disconnect</button>' : ""}
      </div>
    </div>

    <div class="settings-section">
      <h2>🏷️ Categories</h2>
      ${cats}
      <button class="btn btn-large" style="margin-top:12px;" data-action="open-add-category">+ Add Category</button>
    </div>

    <div class="settings-section">
      <h2>🔑 Passphrase</h2>
      <button class="btn btn-large" data-action="open-change-passphrase">Change Passphrase</button>
    </div>

    <div class="settings-section">
      <h2>💾 Your Data</h2>
      <div style="display:flex; gap:10px; flex-wrap:wrap;">
        <button class="btn" data-action="export-data">Download Backup</button>
        <button class="btn" data-action="trigger-import">Restore from Backup</button>
        <input type="file" id="import-file-input" accept="application/json" class="hidden">
      </div>
    </div>

    <div class="settings-section">
      <h2>🔠 Text Size</h2>
      <div class="text-size-options">
        ${[["normal", "Normal"], ["large", "Large"], ["xlarge", "Extra large"]].map(([v, l]) => `<button class="btn ${getTextSize() === v ? "active" : ""}" data-action="set-text-size" data-size="${v}">${l}</button>`).join("")}
      </div>
      <p class="help-text">Makes everything bigger. This applies to this device only.</p>
    </div>

    <div class="settings-section">
      <h2>🚪 This Device</h2>
      <button class="btn btn-large" data-action="lock-now">Lock This Device Now</button>
    </div>

    <div class="settings-section">
      <h2 style="color:var(--color-danger);">⚠️ Danger Zone</h2>
      <button class="btn btn-danger btn-large" data-action="reset-data">Erase All Data</button>
    </div>
  `;
}

/* ---------- Modals ---------- */

function openTransactionModal(existing) {
  const isEdit = !!existing;
  const txn = existing || { type: "expense", date: todayISO(), categoryId: "", description: "", amount: "" };
  let currentType = txn.type;

  openModal(`
    <h2>${isEdit ? "Edit" : "Add"} Transaction</h2>
    <form id="txn-form">
      <div class="type-toggle">
        <button type="button" class="btn ${txn.type === "expense" ? "active-expense" : ""}" id="type-expense-btn">Expense</button>
        <button type="button" class="btn ${txn.type === "income" ? "active-income" : ""}" id="type-income-btn">Income</button>
      </div>
      <div class="form-group" id="txn-category-group">
        <label for="txn-category">Category</label>
        <select id="txn-category">${categoryOptions(txn.type, txn.categoryId)}</select>
      </div>
      <div class="form-group">
        <label for="txn-date">Date</label>
        <input type="date" id="txn-date" value="${txn.date}" required>
      </div>
      <div class="form-group">
        <label for="txn-desc">Description</label>
        <input type="text" id="txn-desc" value="${escapeHtml(txn.description)}" placeholder="e.g. Grocery store" required>
      </div>
      <div class="form-group">
        <label for="txn-amount">Amount</label>
        <input type="number" id="txn-amount" min="0" step="0.01" value="${txn.amount || ""}" placeholder="0.00" required>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn" data-action="modal-cancel">Cancel</button>
        <button type="submit" class="btn btn-primary">${isEdit ? "Save" : "Add"}</button>
      </div>
      ${isEdit ? '<button type="button" class="btn btn-danger btn-large" style="margin-top:10px;" id="txn-delete-btn">Delete Transaction</button>' : ""}
    </form>
  `);

  function refreshCategoryOptions() {
    byId("txn-category-group").innerHTML = `<label for="txn-category">Category</label><select id="txn-category">${categoryOptions(currentType, txn.categoryId)}</select>`;
  }
  byId("type-expense-btn").addEventListener("click", () => {
    currentType = "expense";
    byId("type-expense-btn").classList.add("active-expense");
    byId("type-income-btn").classList.remove("active-income");
    refreshCategoryOptions();
  });
  byId("type-income-btn").addEventListener("click", () => {
    currentType = "income";
    byId("type-income-btn").classList.add("active-income");
    byId("type-expense-btn").classList.remove("active-expense");
    refreshCategoryOptions();
  });

  byId("txn-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const updated = {
      ...(isEdit ? txn : {}),
      id: isEdit ? txn.id : uid(),
      type: currentType,
      date: byId("txn-date").value,
      categoryId: byId("txn-category").value,
      description: byId("txn-desc").value.trim(),
      amount: Math.abs(Number(byId("txn-amount").value) || 0),
      debtId: isEdit ? txn.debtId : undefined,
    };
    // A bill payment or savings entry is an expense; if it was turned into income it's no longer one.
    if (isEdit && txn.type !== currentType) { delete updated.billId; delete updated.goalId; delete updated.paycheckId; }
    mutateData((d) => {
      if (isEdit) {
        const idx = d.transactions.findIndex((t) => t.id === txn.id);
        if (idx > -1) d.transactions[idx] = adjustDebtForTransactionChange(d, d.transactions[idx], updated);
      } else {
        d.transactions.push(updated);
      }
    });
    closeModal();
    showToast(isEdit ? "Transaction updated" : "Transaction added");
  });

  if (isEdit) {
    byId("txn-delete-btn").addEventListener("click", () => {
      confirmAction("Delete this transaction?", () => {
        deleteWithUndo("Transaction deleted", (d) => { removeTransaction(d, txn.id); }); // also gives a debt payment back to its balance
        closeModal();
      });
    });
  }
}

function openCategoryModal(existing) {
  const isEdit = !!existing;
  const cat = existing || { name: "", type: "expense", color: "var(--cat-other)" };
  const colorOptions = [
    "var(--cat-food)", "var(--cat-bills)", "var(--cat-debt)", "var(--cat-transportation)",
    "var(--cat-healthcare)", "var(--cat-savings)", "var(--cat-personal)", "var(--cat-other)", "var(--cat-income)",
  ];

  openModal(`
    <h2>${isEdit ? "Edit" : "Add"} Category</h2>
    <form id="cat-form">
      <div class="form-group">
        <label for="cat-name">Name</label>
        <input type="text" id="cat-name" value="${escapeHtml(cat.name)}" required>
      </div>
      <div class="form-group">
        <label for="cat-type">Type</label>
        <select id="cat-type">
          <option value="expense" ${cat.type === "expense" ? "selected" : ""}>Expense</option>
          <option value="income" ${cat.type === "income" ? "selected" : ""}>Income</option>
        </select>
      </div>
      <div class="form-group">
        <label>Color</label>
        <div style="display:flex; gap:8px; flex-wrap:wrap;">
          ${colorOptions.map((c) => `<button type="button" class="color-swatch" data-color="${c}" style="background:${c}; border:2px solid ${c === cat.color ? "var(--color-text)" : "transparent"};"></button>`).join("")}
        </div>
        <input type="hidden" id="cat-color" value="${cat.color}">
      </div>
      <div class="modal-actions">
        <button type="button" class="btn" data-action="modal-cancel">Cancel</button>
        <button type="submit" class="btn btn-primary">${isEdit ? "Save" : "Add"}</button>
      </div>
      ${isEdit ? '<button type="button" class="btn btn-danger btn-large" style="margin-top:10px;" id="cat-delete-btn">Delete Category</button>' : ""}
    </form>
  `);

  document.querySelectorAll(".color-swatch").forEach((btn) => {
    btn.addEventListener("click", () => {
      byId("cat-color").value = btn.dataset.color;
      document.querySelectorAll(".color-swatch").forEach((b) => (b.style.borderColor = "transparent"));
      btn.style.borderColor = "var(--color-text)";
    });
  });

  byId("cat-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const updated = {
      id: isEdit ? cat.id : uid(),
      name: byId("cat-name").value.trim(),
      type: byId("cat-type").value,
      color: byId("cat-color").value,
    };
    mutateData((d) => {
      if (isEdit) {
        const idx = d.categories.findIndex((c) => c.id === cat.id);
        if (idx > -1) d.categories[idx] = updated;
      } else {
        d.categories.push(updated);
      }
    });
    closeModal();
    showToast(isEdit ? "Category updated" : "Category added");
  });

  if (isEdit) {
    byId("cat-delete-btn").addEventListener("click", () => {
      const inUse = state.data.transactions.some((t) => t.categoryId === cat.id);
      const msg = inUse
        ? `Some transactions use "${cat.name}". Deleting it won't remove those transactions, but they'll show as uncategorized. Continue?`
        : `Delete the "${cat.name}" category?`;
      confirmAction(msg, () => {
        deleteWithUndo("Category deleted", (d) => {
          d.categories = d.categories.filter((c) => c.id !== cat.id);
          d.tombstones.push(`category:${cat.id}`);
        });
        closeModal();
      });
    });
  }
}

function openDebtModal(existing) {
  const isEdit = !!existing;
  const debt = existing || { name: "", type: "credit-card", originalBalance: "", currentBalance: "", interestRate: "", minPayment: "" };

  openModal(`
    <h2>${isEdit ? "Edit" : "Add"} Debt</h2>
    <form id="debt-form">
      <div class="form-group">
        <label for="debt-name">Name</label>
        <input type="text" id="debt-name" value="${escapeHtml(debt.name)}" placeholder="e.g. Visa Card" required>
      </div>
      <div class="form-group">
        <label for="debt-type">Type</label>
        <select id="debt-type">
          <option value="credit-card" ${debt.type === "credit-card" ? "selected" : ""}>Credit Card</option>
          <option value="loan" ${debt.type === "loan" ? "selected" : ""}>Loan</option>
          <option value="mortgage" ${debt.type === "mortgage" ? "selected" : ""}>Mortgage</option>
          <option value="medical" ${debt.type === "medical" ? "selected" : ""}>Medical</option>
          <option value="other" ${debt.type === "other" ? "selected" : ""}>Other</option>
        </select>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label for="debt-original">Starting Balance</label>
          <input type="number" id="debt-original" min="0" step="0.01" value="${debt.originalBalance}" required>
        </div>
        <div class="form-group">
          <label for="debt-current">Balance Owed Now</label>
          <input type="number" id="debt-current" min="0" step="0.01" value="${debt.currentBalance}" required>
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label for="debt-rate">Interest Rate % (optional)</label>
          <input type="number" id="debt-rate" min="0" step="0.01" value="${debt.interestRate}">
        </div>
        <div class="form-group">
          <label for="debt-min">Monthly Payment</label>
          <input type="number" id="debt-min" min="0" step="0.01" value="${debt.minPayment}" required>
        </div>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn" data-action="modal-cancel">Cancel</button>
        <button type="submit" class="btn btn-primary">${isEdit ? "Save" : "Add"}</button>
      </div>
      ${isEdit ? '<button type="button" class="btn btn-danger btn-large" style="margin-top:10px;" id="debt-delete-btn">Delete Debt</button>' : ""}
    </form>
  `);

  byId("debt-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const updated = {
      id: isEdit ? debt.id : uid(),
      name: byId("debt-name").value.trim(),
      type: byId("debt-type").value,
      originalBalance: Math.abs(Number(byId("debt-original").value) || 0),
      currentBalance: Math.abs(Number(byId("debt-current").value) || 0),
      interestRate: Math.abs(Number(byId("debt-rate").value) || 0),
      minPayment: Math.abs(Number(byId("debt-min").value) || 0),
    };
    mutateData((d) => {
      if (isEdit) {
        const idx = d.debts.findIndex((x) => x.id === debt.id);
        if (idx > -1) d.debts[idx] = updated;
      } else {
        d.debts.push(updated);
      }
    });
    closeModal();
    showToast(isEdit ? "Debt updated" : "Debt added");
  });

  if (isEdit) {
    byId("debt-delete-btn").addEventListener("click", () => {
      confirmAction(`Delete "${debt.name}"? This won't delete past transactions.`, () => {
        deleteWithUndo("Debt deleted", (d) => {
          d.debts = d.debts.filter((x) => x.id !== debt.id);
          d.tombstones.push(`debt:${debt.id}`);
        });
        closeModal();
      });
    });
  }
}

function openLogPaymentModal(debt) {
  openModal(`
    <h2>Log a Payment: ${escapeHtml(debt.name)}</h2>
    <form id="payment-form">
      <div class="form-group">
        <label for="pay-date">Date</label>
        <input type="date" id="pay-date" value="${todayISO()}" required>
      </div>
      <div class="form-group">
        <label for="pay-amount">Payment Amount</label>
        <input type="number" id="pay-amount" min="0.01" step="0.01" value="${debt.minPayment || ""}" required>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn" data-action="modal-cancel">Cancel</button>
        <button type="submit" class="btn btn-primary">Log Payment</button>
      </div>
    </form>
  `);

  byId("payment-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const amount = Math.abs(Number(byId("pay-amount").value) || 0);
    const date = byId("pay-date").value;
    if (amount <= 0) return;
    mutateData((d) => {
      const debtCategory = d.categories.find((c) => c.id === "debt") || d.categories.find((c) => c.type === "expense");
      d.transactions.push(adjustDebtForTransactionChange(d, null, {
        id: uid(),
        type: "expense",
        date,
        categoryId: debtCategory ? debtCategory.id : "debt",
        description: `Payment: ${debt.name}`,
        amount,
        debtId: debt.id,
      }));
    });
    closeModal();
    showToast("Payment logged");
  });
}

function openPayScheduleModal() {
  const ps = state.data.paySchedule || { frequency: "biweekly", anchorDate: todayISO() };
  const needsAnchor = frequencyNeedsAnchor;

  openModal(`
    <h2>When do you get paid?</h2>
    <form id="pay-schedule-form">
      <div class="form-group">
        <label for="pay-frequency">How often?</label>
        <select id="pay-frequency">${frequencyOptions(ps.frequency)}</select>
      </div>
      <div class="form-group" id="pay-anchor-group" style="${needsAnchor(ps.frequency) ? "" : "display:none;"}">
        <label for="pay-anchor-date">A recent payday</label>
        <input type="date" id="pay-anchor-date" value="${ps.anchorDate || todayISO()}">
        <p class="help-text">Any payday you actually got paid on works — we just use it to line up the schedule.</p>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn" data-action="modal-cancel">Cancel</button>
        <button type="submit" class="btn btn-primary">Save</button>
      </div>
    </form>
  `);

  byId("pay-frequency").addEventListener("change", () => {
    byId("pay-anchor-group").style.display = needsAnchor(byId("pay-frequency").value) ? "" : "none";
  });

  byId("pay-schedule-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const frequency = byId("pay-frequency").value;
    const anchorDate = needsAnchor(frequency) ? byId("pay-anchor-date").value : null;
    if (needsAnchor(frequency) && !anchorDate) {
      showToast("Pick a payday date first.");
      return;
    }
    mutateData((d) => { d.paySchedule = { frequency, anchorDate }; });
    closeModal();
    showToast("Payday settings saved");
  });
}

function openGoalModal(existing) {
  const isEdit = !!existing;
  const goal = existing || { name: "", target: "", startAmount: "" };

  openModal(`
    <h2>${isEdit ? "Edit" : "Add"} Savings Goal</h2>
    <form id="goal-form">
      <div class="form-group">
        <label for="goal-name">What are you saving for?</label>
        <input type="text" id="goal-name" value="${escapeHtml(goal.name)}" placeholder="e.g. Vacation" required>
      </div>
      <div class="form-group">
        <label for="goal-target">Goal amount</label>
        <input type="number" id="goal-target" min="0.01" step="0.01" value="${goal.target}" placeholder="0.00" required>
      </div>
      <div class="form-group">
        <label for="goal-start">Already saved (optional)</label>
        <input type="number" id="goal-start" min="0" step="0.01" value="${goal.startAmount || ""}" placeholder="0.00">
      </div>
      <div class="modal-actions">
        <button type="button" class="btn" data-action="modal-cancel">Cancel</button>
        <button type="submit" class="btn btn-primary">${isEdit ? "Save" : "Add"}</button>
      </div>
      ${isEdit ? '<button type="button" class="btn btn-danger btn-large" style="margin-top:10px;" id="goal-delete-btn">Delete Goal</button>' : ""}
    </form>
  `);

  byId("goal-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const updated = {
      id: isEdit ? goal.id : uid(),
      name: byId("goal-name").value.trim(),
      target: Math.abs(Number(byId("goal-target").value) || 0),
      startAmount: Math.abs(Number(byId("goal-start").value) || 0),
    };
    if (!(updated.target > 0)) { showToast("Enter the goal amount."); return; }
    mutateData((d) => {
      if (isEdit) {
        const idx = d.goals.findIndex((g) => g.id === goal.id);
        if (idx > -1) d.goals[idx] = updated;
      } else {
        d.goals.push(updated);
      }
    });
    closeModal();
    showToast(isEdit ? "Goal updated" : "Goal added");
  });

  if (isEdit) {
    byId("goal-delete-btn").addEventListener("click", () => {
      confirmAction(`Delete "${goal.name}"? Money you already added stays in your Log.`, () => {
        deleteWithUndo("Goal deleted", (d) => {
          d.goals = d.goals.filter((g) => g.id !== goal.id);
          d.tombstones.push(`goal:${goal.id}`);
        });
        closeModal();
      });
    });
  }
}

function openAddToGoalModal(goal) {
  if (!goal) return;
  openModal(`
    <h2>Add Money: ${escapeHtml(goal.name)}</h2>
    <form id="goal-add-form">
      <div class="form-group">
        <label for="goal-add-date">Date</label>
        <input type="date" id="goal-add-date" value="${todayISO()}" required>
      </div>
      <div class="form-group">
        <label for="goal-add-amount">Amount</label>
        <input type="number" id="goal-add-amount" min="0.01" step="0.01" placeholder="0.00" required>
      </div>
      <p class="help-text">This is also recorded in your Log as a Savings expense.</p>
      <div class="modal-actions">
        <button type="button" class="btn" data-action="modal-cancel">Cancel</button>
        <button type="submit" class="btn btn-primary">Add Money</button>
      </div>
    </form>
  `);

  byId("goal-add-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const amount = Math.abs(Number(byId("goal-add-amount").value) || 0);
    const date = byId("goal-add-date").value;
    if (amount <= 0) return;
    const wasDone = goalSaved(state.data, goal) >= goal.target;
    mutateData((d) => { recordGoalContribution(d, goal, date, amount, uid()); });
    closeModal();
    showToast(!wasDone && goalSaved(state.data, goal) >= goal.target ? "🎉 You reached your goal!" : "Money added");
  });
}

function frequencyOptions(selected) {
  return PAY_FREQUENCIES.map(([value, label]) => `<option value="${value}" ${value === selected ? "selected" : ""}>${escapeHtml(label)}</option>`).join("");
}

function openPaycheckModal(existing) {
  const isEdit = !!existing;
  const pay = existing || { name: "", amount: "", categoryId: "income", frequency: "biweekly", anchorDate: todayISO() };

  openModal(`
    <h2>${isEdit ? "Edit" : "Add"} Paycheck</h2>
    <form id="paycheck-form">
      <div class="form-group">
        <label for="paycheck-name">Whose paycheck?</label>
        <input type="text" id="paycheck-name" value="${escapeHtml(pay.name)}" placeholder="e.g. Dad's paycheck" required>
      </div>
      <div class="form-group">
        <label for="paycheck-amount">Amount each payday</label>
        <input type="number" id="paycheck-amount" min="0.01" step="0.01" value="${pay.amount}" placeholder="0.00" required>
      </div>
      <div class="form-group">
        <label for="paycheck-frequency">How often?</label>
        <select id="paycheck-frequency">${frequencyOptions(pay.frequency)}</select>
      </div>
      <div class="form-group" id="paycheck-anchor-group" style="${frequencyNeedsAnchor(pay.frequency) ? "" : "display:none;"}">
        <label for="paycheck-anchor">Any one payday</label>
        <input type="date" id="paycheck-anchor" value="${pay.anchorDate || todayISO()}">
        <p class="help-text">A past or coming payday — we use it to line up the schedule.</p>
      </div>
      <div class="form-group">
        <label for="paycheck-category">Category</label>
        <select id="paycheck-category">${categoryOptions("income", pay.categoryId)}</select>
      </div>
      <p class="help-text">${isEdit ? "A new amount applies to future paychecks. Ones already in your Log stay as they are." : "Paychecks are added to your Log from today on. For earlier ones, use + Add a Transaction."}</p>
      <div class="modal-actions">
        <button type="button" class="btn" data-action="modal-cancel">Cancel</button>
        <button type="submit" class="btn btn-primary">${isEdit ? "Save" : "Add"}</button>
      </div>
      ${isEdit ? '<button type="button" class="btn btn-danger btn-large" style="margin-top:10px;" id="paycheck-delete-btn">Delete Paycheck</button>' : ""}
    </form>
  `);

  byId("paycheck-frequency").addEventListener("change", () => {
    byId("paycheck-anchor-group").style.display = frequencyNeedsAnchor(byId("paycheck-frequency").value) ? "" : "none";
  });

  byId("paycheck-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const frequency = byId("paycheck-frequency").value;
    const anchorDate = frequencyNeedsAnchor(frequency) ? byId("paycheck-anchor").value : null;
    if (frequencyNeedsAnchor(frequency) && !anchorDate) {
      showToast("Pick a payday date first.");
      return;
    }
    const scheduleChanged = !isEdit || pay.frequency !== frequency || (pay.anchorDate || null) !== anchorDate;
    const updated = {
      id: isEdit ? pay.id : uid(),
      name: byId("paycheck-name").value.trim(),
      amount: Math.abs(Number(byId("paycheck-amount").value) || 0),
      categoryId: byId("paycheck-category").value || "income",
      frequency,
      anchorDate,
      // A new schedule starts fresh today, so it can't invent paychecks on dates the old schedule skipped.
      startedOn: scheduleChanged ? todayISO() : pay.startedOn || todayISO(),
    };
    if (!(updated.amount > 0)) { showToast("Enter the paycheck amount."); return; }
    mutateData((d) => {
      if (isEdit) {
        const idx = d.recurringIncome.findIndex((p) => p.id === pay.id);
        if (idx > -1) d.recurringIncome[idx] = updated;
      } else {
        d.recurringIncome.push(updated);
      }
    }, { render: false });
    const added = addDuePaychecks();
    closeModal();
    render();
    showToast(added ? `${isEdit ? "Paycheck updated" : "Paycheck added"} — today's pay is in your Log` : isEdit ? "Paycheck updated" : "Paycheck added");
  });

  if (isEdit) {
    byId("paycheck-delete-btn").addEventListener("click", () => {
      confirmAction(`Delete "${pay.name}"? Paychecks already in your Log stay there.`, () => {
        deleteWithUndo("Paycheck deleted", (d) => {
          d.recurringIncome = d.recurringIncome.filter((p) => p.id !== pay.id);
          d.tombstones.push(`paycheck:${pay.id}`);
        });
        closeModal();
      });
    });
  }
}

// Puts any paychecks that have come due into the Log. Returns how many were added.
function addDuePaychecks() {
  const due = duePaychecks(state.data, new Date());
  if (!due.length) return 0;
  mutateData((d) => { d.transactions.push(...due); }, { render: false });
  return due.length;
}

/* ---------- Large-print bills list ---------- */

function openPrintBillsModal() {
  openModal(`
    <div class="no-print">
      <h2>Print Bills List</h2>
      <div class="print-modes">
        <button class="btn active" data-print-mode="month">All bills this month</button>
        ${state.data.paySchedule ? '<button class="btn" data-print-mode="period">Before next payday</button>' : ""}
      </div>
    </div>
    <div id="print-sheet"></div>
    <div class="modal-actions no-print">
      <button type="button" class="btn" data-action="modal-cancel">Close</button>
      <button type="button" class="btn btn-primary" id="print-now-btn">🖨️ Print</button>
    </div>
  `);
  document.querySelectorAll(".print-modes [data-print-mode]").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".print-modes .btn").forEach((b) => b.classList.toggle("active", b === btn));
      renderPrintSheet(btn.dataset.printMode);
    });
  });
  byId("print-now-btn").addEventListener("click", () => window.print());
  renderPrintSheet("month");
}

function renderPrintSheet(mode) {
  const sheet = billsSheet(state.data, mode, new Date());
  const el = byId("print-sheet");
  if (!el) return;
  if (!sheet) { el.innerHTML = '<p class="help-text">Set up your payday first.</p>'; return; }
  el.innerHTML = `
    <div class="print-sheet">
      <h2>${escapeHtml(sheet.title)}</h2>
      <p class="print-sub">${escapeHtml(sheet.subtitle)}</p>
      ${sheet.rows.length ? `<table>
        <thead><tr><th>Due</th><th>Bill</th><th class="num">Amount</th><th>Paid</th></tr></thead>
        <tbody>${sheet.rows.map((r) => `<tr><td>${escapeHtml(r.due)}</td><td>${escapeHtml(r.name)}</td><td class="num">${formatMoney(r.amount)}</td><td class="paid-box">${r.paid ? "✓" : ""}</td></tr>`).join("")}</tbody>
        <tfoot><tr><td></td><td>Total</td><td class="num">${formatMoney(sheet.total)}</td><td></td></tr></tfoot>
      </table>` : '<p>No bills with a due date fall in this pay period.</p>'}
      ${sheet.skipped.length ? `<p class="print-sub">Not shown (no due date): ${sheet.skipped.map(escapeHtml).join(", ")}</p>` : ""}
    </div>`;
}

function openBillModal(existing) {
  const isEdit = !!existing;
  const bill = existing || { name: "", amount: "", dueDay: "", categoryId: "bills" };

  openModal(`
    <h2>${isEdit ? "Edit" : "Add"} Bill</h2>
    <form id="bill-form">
      <div class="form-group">
        <label for="bill-name">Bill Name</label>
        <input type="text" id="bill-name" value="${escapeHtml(bill.name)}" placeholder="e.g. Electric Bill" required>
      </div>
      <div class="form-group">
        <label for="bill-category">Category</label>
        <select id="bill-category">${categoryOptions("expense", bill.categoryId || "bills")}</select>
      </div>
      ${state.data.debts.length ? `<div class="form-group">
        <label for="bill-debt">Counts toward a debt (optional)</label>
        <select id="bill-debt"><option value="">None</option>${state.data.debts.map((d) => `<option value="${d.id}" ${d.id === bill.debtId ? "selected" : ""}>${escapeHtml(d.name)}</option>`).join("")}</select>
        <p class="help-text">Marking this bill paid will also lower that debt's balance by the same amount.</p>
      </div>` : ""}
      <div class="form-row">
        <div class="form-group">
          <label for="bill-amount">Usual Amount</label>
          <input type="number" id="bill-amount" min="0" step="0.01" value="${bill.amount}" required>
        </div>
        <div class="form-group">
          <label for="bill-due-day">Due Day (optional)</label>
          <input type="number" id="bill-due-day" min="1" max="31" value="${bill.dueDay || ""}" placeholder="e.g. 15">
        </div>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn" data-action="modal-cancel">Cancel</button>
        <button type="submit" class="btn btn-primary">${isEdit ? "Save" : "Add"}</button>
      </div>
      ${isEdit ? '<button type="button" class="btn btn-danger btn-large" style="margin-top:10px;" id="bill-delete-btn">Delete Bill</button>' : ""}
    </form>
  `);

  byId("bill-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const dueDayVal = byId("bill-due-day").value;
    const updated = {
      id: isEdit ? bill.id : uid(),
      addedOn: isEdit ? bill.addedOn : todayISO(),
      name: byId("bill-name").value.trim(),
      categoryId: byId("bill-category").value,
      debtId: byId("bill-debt") && byId("bill-debt").value ? byId("bill-debt").value : null,
      amount: Math.abs(Number(byId("bill-amount").value) || 0),
      dueDay: dueDayVal ? Math.min(31, Math.max(1, Math.round(Number(dueDayVal)))) : null,
    };
    mutateData((d) => {
      if (isEdit) {
        const idx = d.bills.findIndex((b) => b.id === bill.id);
        if (idx > -1) d.bills[idx] = updated;
      } else {
        d.bills.push(updated);
      }
    });
    closeModal();
    showToast(isEdit ? "Bill updated" : "Bill added");
  });

  if (isEdit) {
    byId("bill-delete-btn").addEventListener("click", () => {
      confirmAction(`Delete "${bill.name}"? This won't delete payments you've already logged.`, () => {
        deleteWithUndo("Bill deleted", (d) => {
          d.bills = d.bills.filter((b) => b.id !== bill.id);
          d.tombstones.push(`bill:${bill.id}`);
        });
        closeModal();
      });
    });
  }
}

function openMarkBillPaidModal(bill, dueISO) {
  // Payments count toward the month a bill falls due, so if that month isn't
  // this one (paying early across a month end), default to the due date.
  const defaultDate = dueISO && monthKeyOf(dueISO) !== monthKeyOf(todayISO()) ? dueISO : todayISO();
  const linkedDebt = bill.debtId ? state.data.debts.find((d) => d.id === bill.debtId) : null;
  const last = lastBillPayment(state.data.transactions, bill.id);
  const showLast = !!last && Number(last.amount) !== Number(bill.amount);
  openModal(`
    <h2>Mark Paid: ${escapeHtml(bill.name)}</h2>
    <form id="bill-pay-form">
      <div class="form-group">
        <label for="bill-pay-date">Date</label>
        <input type="date" id="bill-pay-date" value="${defaultDate}" required>
      </div>
      <div class="form-group">
        <label for="bill-pay-amount">Amount</label>
        <input type="number" id="bill-pay-amount" min="0.01" step="0.01" value="${bill.amount || ""}" required>
      </div>
      ${showLast ? `<p class="help-text">Last paid ${formatMoney(last.amount)} on ${shortISODate(last.date)}. <button type="button" class="btn btn-link" id="bill-pay-use-last">Use that amount</button></p>` : ""}
      ${linkedDebt ? `<p class="help-text">This also lowers the <strong>${escapeHtml(linkedDebt.name)}</strong> balance by the same amount.</p>` : ""}
      <div class="modal-actions">
        <button type="button" class="btn" data-action="modal-cancel">Cancel</button>
        <button type="submit" class="btn btn-primary">Mark Paid</button>
      </div>
    </form>
  `);

  if (showLast) byId("bill-pay-use-last").addEventListener("click", () => { byId("bill-pay-amount").value = last.amount; });

  byId("bill-pay-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const amount = Math.abs(Number(byId("bill-pay-amount").value) || 0);
    const date = byId("bill-pay-date").value;
    if (amount <= 0) return;
    mutateData((d) => { recordBillPayment(d, bill, date, amount, uid()); });
    closeModal();
    showToast("Bill marked as paid");
  });
}

function openChangePassphraseModal() {
  openModal(`
    <h2>Change Passphrase</h2>
    <form id="passphrase-form">
      <div class="form-group">
        <label for="new-pass-1">New passphrase</label>
        <input type="password" id="new-pass-1" required>
      </div>
      <div class="form-group">
        <label for="new-pass-2">Type it again</label>
        <input type="password" id="new-pass-2" required>
      </div>
      <p id="passphrase-modal-error" class="error-text hidden"></p>
      <div class="modal-actions">
        <button type="button" class="btn" data-action="modal-cancel">Cancel</button>
        <button type="submit" class="btn btn-primary">Save</button>
      </div>
    </form>
  `);

  byId("passphrase-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const p1 = byId("new-pass-1").value;
    const p2 = byId("new-pass-2").value;
    const errEl = byId("passphrase-modal-error");
    if (p1.length < 4) {
      errEl.textContent = "Please use at least 4 characters.";
      errEl.classList.remove("hidden");
      return;
    }
    if (p1 !== p2) {
      errEl.textContent = "Those don't match.";
      errEl.classList.remove("hidden");
      return;
    }
    const hash = await sha256Hex(p1);
    mutateData((d) => { d.passphraseHash = hash; });
    setUnlockedOnThisDevice(hash);
    closeModal();
    showToast("Passphrase updated — remember to tell everyone who needs it.");
  });
}

/* ---------- Settings actions ---------- */

async function handleSaveGithubConfig() {
  const owner = byId("set-gh-owner").value.trim();
  const repo = byId("set-gh-repo").value.trim();
  const tokenInput = byId("set-gh-token").value.trim();
  if (!owner || !repo) {
    showToast("Enter a username and repository name.");
    return;
  }
  const existing = loadGithubConfig();
  const token = tokenInput || (existing ? existing.token : "");
  if (!token) {
    showToast("Enter an access token.");
    return;
  }
  const config = { owner, repo, token, tokenExpires: byId("set-gh-expires").value || null };
  setSyncStatus("syncing", "Connecting…");
  try {
    const { data, sha } = await syncPull(config);
    saveGithubConfig(config);
    state.githubConfig = config;
    state.data = data;
    state.sha = sha;
    if (sha === null) {
      state.sha = await syncPush(config, state.data, null);
      showToast("Connected to GitHub — this device's data was backed up");
    } else {
      showToast("Connected to GitHub");
    }
    setSyncStatus("ok", "Connected & synced");
    render();
    checkRepoVisibility(true);
  } catch (e) {
    console.error(e);
    setSyncStatus("error", describeSyncError(e));
    showToast(
      e.status === 401 || e.status === 403 ? "That token was rejected — check it, and that it can read and write this repository."
        : e.status === 404 ? "Repository not found — check the username and repository name (and that the token can see it)."
        : "Could not connect — check your internet connection and the details above."
    );
  }
}

async function handleSyncNow() {
  if (!state.githubConfig) return;
  setSyncStatus("syncing", "Syncing…");
  try {
    const { data, sha } = await syncPull(state.githubConfig);
    state.data = data;
    state.sha = sha;
    setSyncStatus("ok", "Synced");
    render();
    if (isDirty()) scheduleSync();
  } catch (e) {
    console.error(e);
    setSyncStatus("error", describeSyncError(e));
  }
}

function handleDisconnectGithub() {
  confirmAction("Disconnect this device from GitHub? Your data stays on this device but will stop syncing.", () => {
    clearGithubConfig();
    state.githubConfig = null;
    state.repoPublic = null;
    setSyncStatus("", "Saved on this device only");
    closeModal();
    render();
  });
}

function handleExportData() {
  const blob = new Blob([JSON.stringify(state.data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `family-budget-backup-${todayISO()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function handleImportFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    let backup;
    try {
      backup = validateBackup(reader.result);
    } catch (e) {
      showToast(e.message);
      return;
    }
    confirmAction("Replace all current data with this backup?", () => {
      mutateData((d) => Object.assign(d, restoreFromBackup(d, backup)));
      closeModal();
      showToast("Backup restored");
    });
  };
  reader.readAsText(file);
  const input = byId("import-file-input");
  if (input) input.value = ""; // lets the same file be chosen again
}

function handleResetData() {
  const message = state.githubConfig
    ? "This erases this device's copy of the budget. Because this device is connected to GitHub, your data will download again the next time it syncs — it does not delete anything from GitHub. Continue?"
    : "This erases all budget data on this device. This cannot be undone. Continue?";
  confirmAction(message, () => {
    saveLocalData(defaultData());
    setDirty(false);
    setUnlockedOnThisDevice(null);
    closeModal();
    location.reload();
  });
}

function handleLockNow() {
  setUnlockedOnThisDevice(null);
  location.reload();
}

/* ---------- Init ---------- */

async function init() {
  applyTextSize();
  state.data = loadLocalData();
  state.githubConfig = loadGithubConfig();
  wireLockScreen();
  wireApp();
  updateLockScreenMode();

  if (isUnlockedOnThisDevice(state.data.passphraseHash)) {
    showApp();
  }

  if (state.githubConfig) {
    try {
      setSyncStatus("syncing", "Checking for updates…");
      const { data, sha } = await syncPull(state.githubConfig);
      state.data = data;
      state.sha = sha;
      setSyncStatus("ok", "Synced");
      if (isDirty()) scheduleSync(); // unsent changes from last time
      checkRepoVisibility(false);
    } catch (e) {
      console.error(e);
      setSyncStatus("error", describeSyncError(e));
    }
    updateLockScreenMode();
    if (byId("app").classList.contains("hidden")) {
      if (isUnlockedOnThisDevice(state.data.passphraseHash)) showApp();
    } else {
      render();
    }
  }
  // Paychecks that came due since the app was last open (also when offline or not connected).
  if (addDuePaychecks() && !byId("app").classList.contains("hidden")) render();
}

document.addEventListener("DOMContentLoaded", init);

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch((e) => console.error("Offline support unavailable:", e)));
}
