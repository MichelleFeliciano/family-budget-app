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

function defaultData() {
  return {
    version: 1,
    passphraseHash: null,
    categories: DEFAULT_CATEGORIES.map((c) => ({ ...c })),
    transactions: [],
    debts: [],
    budgetPlan: {},
    lastUpdated: new Date().toISOString(),
  };
}

function loadLocalData() {
  try {
    const raw = localStorage.getItem(LOCAL_DATA_KEY);
    if (!raw) return defaultData();
    const parsed = JSON.parse(raw);
    return { ...defaultData(), ...parsed };
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

function isUnlockedOnThisDevice() {
  return localStorage.getItem(LOCAL_UNLOCK_KEY) === "true";
}

function setUnlockedOnThisDevice(value) {
  if (value) localStorage.setItem(LOCAL_UNLOCK_KEY, "true");
  else localStorage.removeItem(LOCAL_UNLOCK_KEY);
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

async function githubFetchFile(config) {
  const res = await fetch(githubApiUrl(config), {
    headers: {
      Authorization: `Bearer ${config.token}`,
      Accept: "application/vnd.github+json",
    },
  });
  if (res.status === 404) return { data: null, sha: null };
  if (!res.ok) throw new Error(`GitHub read failed (${res.status})`);
  const json = await res.json();
  const data = JSON.parse(base64ToUtf8(json.content));
  return { data, sha: json.sha };
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
    throw new Error(`GitHub save failed (${res.status}): ${msg}`);
  }
  const json = await res.json();
  return json.content.sha;
}

async function testGithubConnection(config) {
  await githubFetchFile(config);
  return true;
}

/**
 * Pull the latest shared data. Last-write-wins by lastUpdated timestamp:
 * whichever copy (local vs remote) is newer replaces the other. This is a
 * simple rule that is easy to reason about for two people editing the same
 * household budget; it does not attempt a field-by-field merge.
 */
async function syncPull(config) {
  const { data: remote, sha } = await githubFetchFile(config);
  const local = loadLocalData();
  if (!remote) return { data: local, sha: null };
  const remoteNewer = new Date(remote.lastUpdated) > new Date(local.lastUpdated);
  const winner = remoteNewer ? { ...defaultData(), ...remote } : local;
  saveLocalData(winner);
  return { data: winner, sha };
}

async function syncPush(config, data, sha) {
  const newSha = await githubWriteFile(config, data, sha);
  return newSha;
}
