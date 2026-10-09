/* ==========================================================================
   Storage: local cache (always available, offline-first) + optional
   GitHub-repo sync (best-effort, only when online and configured).

   Two separate stores, on purpose:
   - "familyBudget.data"        -> the shared budget data (synced to GitHub)
   - "familyBudget.githubConfig" -> this device's own PAT/repo settings
     (NEVER written into the synced data, since the repo is public)
   ========================================================================== */

const LOCAL_DATA_KEY = "familyBudget.data";
const LOCAL_CONFIG_KEY = "familyBudget.githubConfig";
const LOCAL_UNLOCK_KEY = "familyBudget.unlocked";
const DATA_PATH = "data/budget-data.json";

const DEFAULT_CATEGORIES = [
  { id: "income", name: "Income", type: "income", color: "var(--cat-income)" },
  { id: "food", name: "Food & Groceries", type: "expense", color: "var(--cat-food)" },
  { id: "bills", name: "Bills & Utilities", type: "expense", color: "var(--cat-bills)" },
  { id: "debt", name: "Debt Payments", type: "expense", color: "var(--cat-debt)" },
  { id: "transportation", name: "Transportation", type: "expense", color: "var(--cat-transportation)" },
  { id: "healthcare", name: "Healthcare", type: "expense", color: "var(--cat-healthcare)" },
  { id: "savings", name: "Savings", type: "expense", color: "var(--cat-savings)" },
  { id: "personal", name: "Personal & Fun", type: "expense", color: "var(--cat-personal)" },
  { id: "other", name: "Other", type: "expense", color: "var(--cat-other)" },
];

// An empty budget is "older than everything", so a brand-new device can never
// overwrite real data already on GitHub when the two are merged.
const EPOCH = "1970-01-01T00:00:00.000Z";

function defaultData() {
  return {
    version: 1,
    passphraseHash: null,
    categories: DEFAULT_CATEGORIES.map((c) => ({ ...c })),
    transactions: [],
    debts: [],
    bills: [],
    recurringIncome: [],
    goals: [],
    budgetPlan: {},
    paySchedule: null,
    tombstones: [],
    lastUpdated: EPOCH,
  };
}

// A category colour ends up in a style attribute, so only a hex colour or one of the
// app's own colour variables is allowed through.
function safeCategory(category) {
  const ok = typeof category.color === "string" && /^(#[0-9a-fA-F]{3,8}|var\(--[\w-]+\))$/.test(category.color);
  return ok ? category : { ...category, color: "var(--cat-other)" };
}

/**
 * Makes any parsed JSON safe to use: wrong-typed or missing fields fall back
 * to defaults so a damaged file or a wrong backup can't crash every screen.
 * Fields this version doesn't know about are kept.
 */
function sanitizeData(raw) {
  const base = defaultData();
  const src = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const records = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === "object" && !Array.isArray(x)) : []);
  const validDate = typeof src.lastUpdated === "string" && !isNaN(new Date(src.lastUpdated));
  return {
    ...src,
    version: typeof src.version === "number" ? src.version : base.version,
    passphraseHash: typeof src.passphraseHash === "string" && src.passphraseHash ? src.passphraseHash : null,
    categories: Array.isArray(src.categories) ? records(src.categories).map(safeCategory) : base.categories,
    transactions: records(src.transactions),
    debts: records(src.debts),
    bills: records(src.bills),
    recurringIncome: records(src.recurringIncome),
    goals: records(src.goals),
    budgetPlan: src.budgetPlan && typeof src.budgetPlan === "object" && !Array.isArray(src.budgetPlan) ? src.budgetPlan : {},
    paySchedule: src.paySchedule && typeof src.paySchedule === "object" && typeof src.paySchedule.frequency === "string" ? src.paySchedule : null,
    tombstones: Array.isArray(src.tombstones) ? src.tombstones.filter((t) => typeof t === "string") : [],
    lastUpdated: validDate ? src.lastUpdated : EPOCH,
  };
}

/** Parses a backup file; throws a readable error if it isn't a budget backup. */
function validateBackup(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error("That file isn't a valid backup.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Array.isArray(parsed.categories) || !Array.isArray(parsed.transactions)) {
    throw new Error("That file doesn't look like a budget backup.");
  }
  return sanitizeData(parsed);
}

/**
 * Applies a validated backup to the current data without losing the passphrase,
 * and without letting old delete-markers immediately remove what was restored.
 */
function restoreFromBackup(current, backup) {
  const keys = (d) => new Set([
    ...d.categories.map((r) => `category:${r.id}`), ...d.transactions.map((r) => `transaction:${r.id}`),
    ...d.debts.map((r) => `debt:${r.id}`), ...d.bills.map((r) => `bill:${r.id}`),
    ...(d.recurringIncome || []).map((r) => `paycheck:${r.id}`), ...(d.goals || []).map((r) => `goal:${r.id}`),
  ]);
  const present = keys(backup);
  // Anything not in the backup is marked deleted, so "replace" really replaces
  // even after the merge with GitHub; anything in the backup is un-deleted.
  const removed = [...keys(current)].filter((k) => !present.has(k));
  const tombstones = Array.from(new Set([...(current.tombstones || []), ...backup.tombstones, ...removed])).filter((t) => !present.has(t));
  return { ...backup, passphraseHash: backup.passphraseHash || current.passphraseHash || null, tombstones };
}

function loadLocalData() {
  try {
    const raw = localStorage.getItem(LOCAL_DATA_KEY);
    if (!raw) return defaultData();
    return sanitizeData(JSON.parse(raw));
  } catch (e) {
    console.error("Failed to read local data, starting fresh.", e);
    return defaultData();
  }
}

function saveLocalData(data) {
  localStorage.setItem(LOCAL_DATA_KEY, JSON.stringify(data));
}

function loadGithubConfig() {
  try {
    const raw = localStorage.getItem(LOCAL_CONFIG_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

function saveGithubConfig(config) {
  localStorage.setItem(LOCAL_CONFIG_KEY, JSON.stringify(config));
}

function clearGithubConfig() {
  localStorage.removeItem(LOCAL_CONFIG_KEY);
}

// A device stays unlocked only for the passphrase it was unlocked with, so
// changing the passphrase locks out every other device until it's re-entered.
function isUnlockedOnThisDevice(passphraseHash) {
  const saved = localStorage.getItem(LOCAL_UNLOCK_KEY);
  if (!saved || !passphraseHash) return false;
  if (saved === "true") {
    // Older versions stored a plain "true"; adopt the current passphrase once.
    localStorage.setItem(LOCAL_UNLOCK_KEY, passphraseHash);
    return true;
  }
  return saved === passphraseHash;
}

function setUnlockedOnThisDevice(passphraseHash) {
  if (passphraseHash) localStorage.setItem(LOCAL_UNLOCK_KEY, passphraseHash);
  else localStorage.removeItem(LOCAL_UNLOCK_KEY);
}

// How big text is on THIS device (a display preference, so it isn't synced).
const LOCAL_TEXT_SIZE_KEY = "familyBudget.textSize";
const TEXT_SIZES = ["normal", "large", "xlarge"];

function getTextSize() {
  const saved = localStorage.getItem(LOCAL_TEXT_SIZE_KEY);
  return TEXT_SIZES.includes(saved) ? saved : "normal";
}

function setTextSize(size) {
  if (TEXT_SIZES.includes(size) && size !== "normal") localStorage.setItem(LOCAL_TEXT_SIZE_KEY, size);
  else localStorage.removeItem(LOCAL_TEXT_SIZE_KEY);
}

// How the bills list is ordered on this device.
const LOCAL_BILL_SORT_KEY = "familyBudget.billSort";
const BILL_SORTS = ["due", "name", "category"];

function getBillSort() {
  const saved = localStorage.getItem(LOCAL_BILL_SORT_KEY);
  return BILL_SORTS.includes(saved) ? saved : "due";
}

function setBillSort(mode) {
  if (BILL_SORTS.includes(mode)) localStorage.setItem(LOCAL_BILL_SORT_KEY, mode);
}

// "Has changes GitHub hasn't confirmed yet" — survives closing the tab, so a
// push that never ran (or failed) is retried the next time the app opens.
const LOCAL_DIRTY_KEY = "familyBudget.unsynced";

function isDirty() {
  return localStorage.getItem(LOCAL_DIRTY_KEY) === "1";
}

function setDirty(value) {
  if (value) localStorage.setItem(LOCAL_DIRTY_KEY, "1");
  else localStorage.removeItem(LOCAL_DIRTY_KEY);
}

/* ---------- Passphrase hashing (UX gate only — see README for the
   accepted limitations of a client-side-only check). ---------- */
async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const hashBuffer = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/* ---------- UTF-8 safe base64 helpers (GitHub Contents API requires
   base64; plain btoa/atob only handle Latin-1). ---------- */
function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary);
}

function base64ToUtf8(b64) {
  const binary = atob(b64.replace(/\n/g, ""));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/* ---------- GitHub sync ----------
   Uses the Contents API on the device's configured repo. Requires a
   fine-grained PAT scoped to that one repo with Contents: Read & write.
   This talks to api.github.com only — the same GitHub account/repo the
   app is already hosted from, not a third-party service. */

function githubApiUrl(config) {
  return `https://api.github.com/repos/${config.owner}/${config.repo}/contents/${DATA_PATH}`;
}

function githubError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// Short, plain-language reason for the sync status line.
function describeSyncError(err) {
  const status = err && err.status;
  if (status === 401 || status === 403) return "Token expired or rejected — update it in Settings";
  if (status === 404) return "GitHub can't find the repository — check Settings";
  if (status === 409 || status === 422) return "Saved here — will retry shortly";
  if (!status) return "Offline — saved here, will sync later";
  return `GitHub problem (${status}) — saved on this device`;
}

async function githubFetchFile(config) {
  const res = await fetch(githubApiUrl(config), {
    // GitHub answers GETs with "Cache-Control: max-age=60"; without this the
    // browser can hand back a minute-old copy and an out-of-date sha, which
    // makes the next save fail.
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${config.token}`,
      Accept: "application/vnd.github+json",
    },
  });
  if (res.status === 404) return { data: null, sha: null };
  if (!res.ok) throw githubError(`GitHub read failed (${res.status})`, res.status);
  const json = await res.json();
  let text;
  if (typeof json.content === "string" && json.content && json.encoding !== "none") {
    text = base64ToUtf8(json.content);
  } else {
    // GitHub leaves the content out of files over 1 MB; ask for the raw file instead.
    const raw = await fetch(githubApiUrl(config), {
      cache: "no-store",
      headers: { Authorization: `Bearer ${config.token}`, Accept: "application/vnd.github.raw+json" },
    });
    if (!raw.ok) throw githubError(`GitHub read failed (${raw.status})`, raw.status);
    text = await raw.text();
  }
  return { data: JSON.parse(text), sha: json.sha };
}

/**
 * Is the repository the budget is saved in public? Returns true / false, or
 * null if GitHub couldn't say (never blocks anything — it only powers a warning).
 */
async function githubRepoIsPublic(config) {
  try {
    const res = await fetch(`https://api.github.com/repos/${config.owner}/${config.repo}`, {
      cache: "no-store",
      headers: { Authorization: `Bearer ${config.token}`, Accept: "application/vnd.github+json" },
    });
    if (!res.ok) return null;
    const info = await res.json();
    return typeof info.private === "boolean" ? !info.private : null;
  } catch (e) {
    return null;
  }
}

async function githubWriteFile(config, data, sha) {
  const body = {
    message: "Update budget data",
    content: utf8ToBase64(JSON.stringify(data, null, 2)),
    committer: { name: "Family Budget App", email: "noreply@localhost" },
  };
  if (sha) body.sha = sha;
  const res = await fetch(githubApiUrl(config), {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${config.token}`,
      Accept: "application/vnd.github+json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => "");
    throw githubError(`GitHub save failed (${res.status}): ${msg}`, res.status);
  }
  const json = await res.json();
  return json.content.sha;
}

async function testGithubConnection(config) {
  await githubFetchFile(config);
  return true;
}

/**
 * Union-merge two lists of the same record type by id, so an addition on
 * one device is never discarded just because the other device's copy has
 * a newer overall timestamp. On an actual same-id collision (both sides
 * edited the same existing record), `winner`'s version is kept.
 */
function mergeArraysById(loser, winner) {
  const map = new Map();
  (loser || []).forEach((item) => map.set(item.id, item));
  (winner || []).forEach((item) => map.set(item.id, item));
  return Array.from(map.values());
}

function mergeBudgetPlan(loser, winner) {
  const merged = {};
  const months = new Set([...Object.keys(loser || {}), ...Object.keys(winner || {})]);
  months.forEach((month) => {
    merged[month] = { ...(loser && loser[month]), ...(winner && winner[month]) };
  });
  return merged;
}

/**
 * Merge local and remote data instead of picking one wholesale. Records
 * (categories/transactions/debts/bills) are unioned by id — deleting a
 * record on one device only sticks once its id is recorded as a
 * tombstone, since a plain union would otherwise let a stale copy on
 * another device silently resurrect it.
 */
function mergeData(localRaw, remoteRaw) {
  const local = sanitizeData(localRaw);
  const remote = sanitizeData(remoteRaw);
  const remoteNewer = new Date(remote.lastUpdated) > new Date(local.lastUpdated);
  const winner = remoteNewer ? remote : local;
  const loser = remoteNewer ? local : remote;

  const tombstones = Array.from(new Set([...loser.tombstones, ...winner.tombstones]));
  const deleted = new Set(tombstones);
  const isDeleted = (type, id) => deleted.has(`${type}:${id}`);

  return {
    ...loser,
    ...winner,
    paySchedule: winner.paySchedule || loser.paySchedule || null,
    passphraseHash: winner.passphraseHash || loser.passphraseHash || null,
    categories: mergeArraysById(loser.categories, winner.categories).filter((c) => !isDeleted("category", c.id)),
    transactions: mergeArraysById(loser.transactions, winner.transactions).filter((t) => !isDeleted("transaction", t.id)),
    debts: mergeArraysById(loser.debts, winner.debts).filter((d) => !isDeleted("debt", d.id)),
    bills: mergeArraysById(loser.bills, winner.bills).filter((b) => !isDeleted("bill", b.id)),
    recurringIncome: mergeArraysById(loser.recurringIncome, winner.recurringIncome).filter((p) => !isDeleted("paycheck", p.id)),
    goals: mergeArraysById(loser.goals, winner.goals).filter((g) => !isDeleted("goal", g.id)),
    budgetPlan: mergeBudgetPlan(loser.budgetPlan, winner.budgetPlan),
    tombstones,
    lastUpdated: winner.lastUpdated,
  };
}

/**
 * Downloads the shared file and merges it with this device's copy. When a device
 * is being connected to GitHub for the first time, pass preferRemotePassphrase:
 * the family's passphrase on GitHub must win over one this device only just
 * created, or connecting a new phone would lock everyone else out.
 */
async function syncPull(config, { preferRemotePassphrase = false } = {}) {
  const { data: remote, sha } = await githubFetchFile(config);
  const local = loadLocalData();
  if (!remote) return { data: local, sha: null };
  const merged = mergeData(local, remote);
  if (preferRemotePassphrase) {
    const remotePassphrase = sanitizeData(remote).passphraseHash;
    if (remotePassphrase) merged.passphraseHash = remotePassphrase;
  }
  saveLocalData(merged);
  return { data: merged, sha };
}

async function syncPush(config, data, sha) {
  const newSha = await githubWriteFile(config, data, sha);
  return newSha;
}
