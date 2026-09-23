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

function mutateData(fn) {
  fn(state.data);
  state.data.lastUpdated = new Date().toISOString();
  saveLocalData(state.data);
  scheduleSync();
  render();
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
    try {
      const newSha = await syncPush(state.githubConfig, state.data, state.sha);
      state.sha = newSha;
      setSyncStatus("ok", "Synced");
    } catch (e) {
      console.error("Push failed, retrying after a fresh merge:", e);
      try {
        const { data, sha } = await syncPull(state.githubConfig);
        state.data = data;
        state.sha = await syncPush(state.githubConfig, state.data, sha);
        setSyncStatus("ok", "Synced");
        render();
      } catch (retryErr) {
        console.error(retryErr);
        setSyncStatus("error", "Saved on this device (sync failed)");
      }
    }
  }, 1200);
}

async function pullAndMergeSilently() {
  if (!state.githubConfig) return;
  try {
    setSyncStatus("syncing", "Checking for updates…");
    const { data, sha } = await syncPull(state.githubConfig);
    state.data = data;
    state.sha = sha;
    setSyncStatus("ok", "Synced");
    if (!byId("app").classList.contains("hidden")) render();
  } catch (e) {
    setSyncStatus("error", "Offline (using saved data)");
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
      setUnlockedOnThisDevice(true);
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
    setUnlockedOnThisDevice(true);
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
    const config = { owner, repo, token };
    try {
      const { data, sha } = await syncPull(config);
      saveGithubConfig(config);
      state.githubConfig = config;
      state.data = data;
      state.sha = sha;
      if (sha === null && state.data.passphraseHash) {
        state.sha = await syncPush(config, state.data, null);
        statusEl.textContent = "Connected! This device's data was backed up to GitHub.";
      } else {
        statusEl.textContent = "Connected! " + (data.passphraseHash ? "Enter the passphrase above." : "No passphrase set yet — create one above.");
      }
      updateLockScreenMode();
      if (isUnlockedOnThisDevice() && state.data.passphraseHash) showApp();
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
  byId("modal-root").addEventListener("click", (e) => {
    if (e.target.closest('[data-action="modal-cancel"]')) closeModal();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && !byId("app").classList.contains("hidden")) {
      pullAndMergeSilently();
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
    case "open-add-bill": openBillModal(null); break;
    case "edit-bill": openBillModal(state.data.bills.find((b) => b.id === btn.dataset.id)); break;
    case "mark-bill-paid": openMarkBillPaidModal(state.data.bills.find((b) => b.id === btn.dataset.id)); break;
    case "undo-bill-payment":
      confirmAction("Remove this payment record?", () => {
        mutateData((d) => {
          d.transactions = d.transactions.filter((t) => t.id !== btn.dataset.txnId);
          d.tombstones.push(`transaction:${btn.dataset.txnId}`);
        });
        closeModal();
        showToast("Payment removed");
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
    case "lock-now": handleLockNow(); break;
  }
}

function handleViewChange(e) {
  const el = e.target;
  if (el.matches(".planned-input")) {
    const catId = el.dataset.categoryId;
    const value = Math.abs(Number(el.value) || 0);
    mutateData((d) => {
      if (!d.budgetPlan[state.month]) d.budgetPlan[state.month] = {};
      d.budgetPlan[state.month][catId] = value;
    });
  }
  if (el.id === "import-file-input") {
    handleImportFile(el.files[0]);
  }
}

/* ---------- Render dispatcher ---------- */

function render() {
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

  const bars = cats.map((c, i) => {
    const amt = amounts[i];
    const pct = Math.round((amt / maxCat) * 100);
    return `<div class="bar-row">
      <div class="bar-label">${escapeHtml(c.name)}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${pct}%; background:${c.color};"></div></div>
      <div class="bar-amount">${formatMoney(amt)}</div>
    </div>`;
  }).join("");

  const anySpending = amounts.some((a) => a > 0);

  return `
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
    <button class="btn btn-primary btn-large" data-action="open-add-transaction">+ Add a Transaction</button>
  `;
}

function renderBudget() {
  const cats = state.data.categories.filter((c) => c.type === "expense");
  const plan = state.data.budgetPlan[state.month] || {};

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
               data-category-id="${c.id}">
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
      ${cats.length ? rows : '<p class="empty-state">No expense categories yet. Add one in Settings.</p>'}
      <div class="budget-total-row">
        <span>Total Spent</span>
        <span>${formatMoney(totalActual)}</span>
      </div>
      <p class="help-text">Planned total: ${formatMoney(totalPlanned)}</p>
    </div>
    ${renderBillsSection()}
  `;
}

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

function renderBillsSection() {
  const bills = state.data.bills;

  const rows = bills.map((b) => {
    const paidTxn = findBillPayment(state.data.transactions, b.id, state.month);
    const cat = getCategory(b.categoryId) || getCategory("bills");
    return `
      <div class="bill-item">
        <div class="bill-main">
          <div class="bill-name">${escapeHtml(b.name)}</div>
          <div class="bill-meta">
            <span class="cat-dot" style="background:${cat ? cat.color : "var(--cat-other)"}"></span>${cat ? escapeHtml(cat.name) : "Uncategorized"} • ${formatMoney(b.amount)}${b.dueDay ? ` • Due on the ${ordinal(b.dueDay)}` : ""}
          </div>
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
      ${bills.length ? rows : '<p class="empty-state">No bills added yet.</p>'}
      <button class="btn btn-primary btn-large" style="margin-top:12px;" data-action="open-add-bill">+ Add a Bill</button>
    </div>
  `;
}

function renderTransactions() {
  const list = state.data.transactions
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
    </div>
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
    ${ordered.length ? cards : '<p class="empty-state">No debts added yet. Add one to start tracking payoff progress.</p>'}
    <button class="btn btn-primary btn-large" data-action="open-add-debt">+ Add a Debt</button>
  `;
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
      <div class="form-group">
        <label for="set-gh-owner">GitHub username</label>
        <input type="text" id="set-gh-owner" value="${gh ? escapeHtml(gh.owner) : ""}">
      </div>
      <div class="form-group">
        <label for="set-gh-repo">Repository name</label>
        <input type="text" id="set-gh-repo" value="${gh ? escapeHtml(gh.repo) : ""}">
      </div>
      <div class="form-group">
        <label for="set-gh-token">Access token</label>
        <input type="password" id="set-gh-token" placeholder="${gh ? "Leave blank to keep current token" : ""}">
      </div>
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
  const txn = existing || { type: "expense", date: new Date().toISOString().slice(0, 10), categoryId: "", description: "", amount: "" };
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
      id: isEdit ? txn.id : uid(),
      type: currentType,
      date: byId("txn-date").value,
      categoryId: byId("txn-category").value,
      description: byId("txn-desc").value.trim(),
      amount: Math.abs(Number(byId("txn-amount").value) || 0),
      debtId: isEdit ? txn.debtId : undefined,
    };
    mutateData((d) => {
      if (isEdit) {
        const idx = d.transactions.findIndex((t) => t.id === txn.id);
        if (idx > -1) d.transactions[idx] = updated;
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
        mutateData((d) => {
          d.transactions = d.transactions.filter((t) => t.id !== txn.id);
          d.tombstones.push(`transaction:${txn.id}`);
        });
        closeModal();
        showToast("Transaction deleted");
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
        mutateData((d) => {
          d.categories = d.categories.filter((c) => c.id !== cat.id);
          d.tombstones.push(`category:${cat.id}`);
        });
        closeModal();
        showToast("Category deleted");
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
        mutateData((d) => {
          d.debts = d.debts.filter((x) => x.id !== debt.id);
          d.tombstones.push(`debt:${debt.id}`);
        });
        closeModal();
        showToast("Debt deleted");
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
        <input type="date" id="pay-date" value="${new Date().toISOString().slice(0, 10)}" required>
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
      d.transactions.push({
        id: uid(),
        type: "expense",
        date,
        categoryId: debtCategory ? debtCategory.id : "debt",
        description: `Payment: ${debt.name}`,
        amount,
        debtId: debt.id,
      });
      const target = d.debts.find((x) => x.id === debt.id);
      if (target) target.currentBalance = Math.max(0, Number(target.currentBalance) - amount);
    });
    closeModal();
    showToast("Payment logged");
  });
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
      name: byId("bill-name").value.trim(),
      categoryId: byId("bill-category").value,
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
        mutateData((d) => {
          d.bills = d.bills.filter((b) => b.id !== bill.id);
          d.tombstones.push(`bill:${bill.id}`);
        });
        closeModal();
        showToast("Bill deleted");
      });
    });
  }
}

function openMarkBillPaidModal(bill) {
  openModal(`
    <h2>Mark Paid: ${escapeHtml(bill.name)}</h2>
    <form id="bill-pay-form">
      <div class="form-group">
        <label for="bill-pay-date">Date</label>
        <input type="date" id="bill-pay-date" value="${new Date().toISOString().slice(0, 10)}" required>
      </div>
      <div class="form-group">
        <label for="bill-pay-amount">Amount</label>
        <input type="number" id="bill-pay-amount" min="0.01" step="0.01" value="${bill.amount || ""}" required>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn" data-action="modal-cancel">Cancel</button>
        <button type="submit" class="btn btn-primary">Mark Paid</button>
      </div>
    </form>
  `);

  byId("bill-pay-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const amount = Math.abs(Number(byId("bill-pay-amount").value) || 0);
    const date = byId("bill-pay-date").value;
    if (amount <= 0) return;
    mutateData((d) => {
      const cat = d.categories.find((c) => c.id === bill.categoryId) || d.categories.find((c) => c.id === "bills") || d.categories.find((c) => c.type === "expense");
      d.transactions.push({
        id: uid(),
        type: "expense",
        date,
        categoryId: cat ? cat.id : "bills",
        description: `Bill: ${bill.name}`,
        amount,
        billId: bill.id,
      });
    });
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
  const config = { owner, repo, token };
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
  } catch (e) {
    console.error(e);
    setSyncStatus("error", "Could not connect");
    showToast("Could not connect — check the username, repo, and token.");
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
  } catch (e) {
    console.error(e);
    setSyncStatus("error", "Could not sync");
  }
}

function handleDisconnectGithub() {
  confirmAction("Disconnect this device from GitHub? Your data stays on this device but will stop syncing.", () => {
    clearGithubConfig();
    state.githubConfig = null;
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
  a.download = `family-budget-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function handleImportFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(reader.result);
      confirmAction("Replace all current data with this backup?", () => {
        mutateData((d) => Object.assign(d, defaultData(), parsed));
        closeModal();
        showToast("Backup restored");
      });
    } catch (e) {
      showToast("That file could not be read as a backup.");
    }
  };
  reader.readAsText(file);
}

function handleResetData() {
  confirmAction("This will erase all budget data on this device (and push the reset if connected to GitHub). This cannot be undone. Continue?", () => {
    mutateData((d) => Object.assign(d, defaultData()));
    setUnlockedOnThisDevice(false);
    closeModal();
    location.reload();
  });
}

function handleLockNow() {
  setUnlockedOnThisDevice(false);
  location.reload();
}

/* ---------- Init ---------- */

async function init() {
  state.data = loadLocalData();
  state.githubConfig = loadGithubConfig();
  wireLockScreen();
  wireApp();
  updateLockScreenMode();

  if (isUnlockedOnThisDevice() && state.data.passphraseHash) {
    showApp();
  }

  if (state.githubConfig) {
    try {
      setSyncStatus("syncing", "Checking for updates…");
      const { data, sha } = await syncPull(state.githubConfig);
      state.data = data;
      state.sha = sha;
      setSyncStatus("ok", "Synced");
    } catch (e) {
      console.error(e);
      setSyncStatus("error", "Offline (using saved data)");
    }
    updateLockScreenMode();
    if (byId("app").classList.contains("hidden")) {
      if (isUnlockedOnThisDevice() && state.data.passphraseHash) showApp();
    } else {
      render();
    }
  }
}

document.addEventListener("DOMContentLoaded", init);
