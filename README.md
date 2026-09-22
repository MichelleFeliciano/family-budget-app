# Our Family Budget

A simple, spreadsheet-like household budget app — built to be easy to read and
easy to update, with large text and buttons. It works fully offline (all your
data is saved right in the browser) and can optionally sync across devices
through your own GitHub repository, so everyone always sees the same numbers.

No accounts, no third-party servers, no ads, no analytics. The only network
calls this app makes are to `api.github.com`, to save/load one data file in
*your own* repository.

## What's inside

- **Home** — this month's income, expenses, what's left over, and total debt.
- **Budget** — a simple spreadsheet-style grid: type what you plan to spend
  per category, and it shows what you've actually spent.
- **Log** — every transaction (income or expense), add/edit any time.
- **Debt** — track each debt's balance, see progress, and get a "focus this
  one first" recommendation using either the *Snowball* (smallest balance
  first) or *Avalanche* (highest interest first) method.
- **Settings** — categories, GitHub sync, the passphrase, and backups.

## Important: what the passphrase actually protects

This is a **static site with no server**, hosted from a public repository.
The passphrase is a friendly lock to keep casual visitors from opening the
app and seeing your numbers — it is **not** real security. Anyone who really
wanted to could read the app's own code (or the synced data file) and get
around it. Don't put anything more sensitive in here than you'd be fine with
being technically inspectable by someone determined enough. For a household
budget, that's a normal and accepted trade-off for getting a free, adminless,
cross-device app — just go in with the right expectation.

**If a passphrase is forgotten, it cannot be recovered** (it's stored only as
a one-way scrambled hash, on purpose, so the real passphrase isn't sitting in
plain text in a public repo). Whoever knows the current passphrase can change
it any time from Settings → Passphrase. If nobody remembers it, the only way
back in is Settings-level access isn't possible (you're locked out) — you'd
need to clear the site's data in the browser and start over, which erases
that device's local copy of the budget (a synced copy still exists in GitHub
if any device was connected). Keep the passphrase written down somewhere
safe, like you would a house key.

## One-time setup (you do this once)

1. **Create the repository.** Push this folder to a new **public** GitHub
   repository (e.g. `family-budget-app`).
2. **Turn on GitHub Pages.** In the repo, go to *Settings → Pages*, and under
   "Build and deployment" choose **Deploy from a branch**, branch `main`,
   folder `/ (root)`. Save. GitHub will give you a URL like
   `https://yourusername.github.io/family-budget-app/` — that's the link
   everyone will use.
3. **Create an access token** (this lets the app save data back to your
   repo):
   - Go to **github.com → Settings → Developer settings → Personal access
     tokens → Fine-grained tokens → Generate new token**.
   - Under **Resource owner**, pick yourself. Under **Repository access**,
     choose **Only select repositories** and pick this one repo.
   - Under **Permissions → Repository permissions**, set **Contents** to
     **Read and write**. Leave everything else as "No access."
   - Set an expiration (90 days is a reasonable default — you'll just
     generate a new one and update it on each device when it expires).
   - Generate the token and **copy it somewhere safe** — GitHub only shows
     it once.
4. **Open your Pages URL.** The app will ask you to set up a passphrase
   first — choose one you'll share with your parents. Then expand
   *"First time on this device? Connect to GitHub"* and enter your GitHub
   username, the repository name, and the token from step 3. Once connected,
   your passphrase and data will sync to the repo automatically from then on.

## Setting up your parents' devices

Give them three things: the Pages URL, the passphrase, and the access token
from step 3 above (the same token works on multiple devices — it's tied to
the repository, not the device).

On each device, they should:

1. Open the link.
2. Tap **"First time on this device? Connect to GitHub"**, and enter the
   GitHub username, repository name, and token.
3. Enter the passphrase and tap **Unlock**.

After that, the device remembers it's unlocked and stays connected — they
won't need to repeat this setup. Any changes made on one device sync to the
others automatically whenever there's an internet connection; without one,
everything keeps working from the last saved copy on that device.

## Backups

Settings → **Download Backup** saves a copy of all the data as a file.
**Restore from Backup** loads one back in (this replaces everything current).
It's worth doing this occasionally, and especially before big changes.

## If sync ever fails

The app always saves to the device it's on first, so nothing is ever lost —
a failed sync just means the other devices won't see the update yet. Check
the internet connection and try **Settings → Sync Now**. If it still fails,
the token may have expired (see step 3) — generate a new one and re-enter it
under Settings → GitHub Sync on each device.

## Rotating or revoking a token

If a device is lost, or a token expires, revoke it at **github.com →
Settings → Developer settings → Fine-grained tokens**, generate a new one the
same way as step 3, and enter it on each device under Settings → GitHub
Sync. Because the token only has Contents access to this one repository, a
lost or leaked token can't be used to access anything else on your GitHub
account.
