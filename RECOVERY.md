# If something goes wrong

A guide for whoever looks after the budget app. Start with the symptom.

**The short version:** the budget lives in two places — on each device, and as one
file in the **private** `family-budget-data` repository on GitHub, which also keeps
every earlier version. Almost nothing here can lose data for good. When in doubt,
**don't erase anything**; work through the steps below.

| What you see | Go to |
|---|---|
| "Token expired or rejected" at the top, or a red banner about the token | [1. The token expired](#1-the-token-expired-or-was-rejected) |
| Someone can't get past the lock screen / forgot the passphrase | [2. The passphrase](#2-nobody-remembers-the-passphrase) |
| A phone opens to an empty budget, or asks for the passphrase setup again | [3. A phone shows nothing](#3-a-phone-shows-an-empty-budget) |
| Something was deleted or changed by mistake | [4. Getting something back](#4-getting-something-back) |
| Phones show different numbers | [5. Devices disagree](#5-two-devices-show-different-numbers) |
| New phone | [6. Setting up a new phone](#6-setting-up-a-new-phone) |
| Phone lost or stolen | [7. A lost phone](#7-a-phone-is-lost-or-stolen) |
| The app looks old after an update | [8. The app didn't update](#8-the-app-looks-out-of-date) |

---

## 1. The token expired (or was rejected)

Each device talks to GitHub with an **access token**. Tokens expire (the longest GitHub
allows is a year). While it's expired, **nothing is lost** — every change stays on
the device and uploads as soon as a working token is entered.

1. On github.com: your picture → **Settings** → **Developer settings** →
   **Personal access tokens** → **Fine-grained tokens** → **Generate new token**.
2. *Repository access*: **Only select repositories** → `family-budget-data`.
3. *Repository permissions*: **Contents → Read and write** (leave everything else off).
4. *Expiration*: pick the longest, and **write the date down**. Generate it, and
   **copy the token right away** — GitHub shows it only once.
5. On **each device**: open the app → **Settings → GitHub Sync** → paste it into
   *Access token*, enter the new *Token expires on* date → **Save & Connect**.

If you forgot to write the date down: github.com → Settings → Developer settings →
Fine-grained tokens lists every token with its expiry date.

> "GitHub can't find the repository" is a different problem: check the username and
> repository name in Settings → GitHub Sync (the repository is `family-budget-data`),
> and that the token was given access to that repository.

## 2. Nobody remembers the passphrase

The passphrase is only a screen lock; the budget itself is safe on GitHub.

**If any device is still unlocked:** Settings → **Change Passphrase**. Other devices
will ask for the new one.

**If every device is locked:**

1. On github.com open the `family-budget-data` repository → `data` →
   `budget-data.json` → the pencil (**Edit**) icon.
2. Find the line `"passphraseHash": "…long text…",` and change the value to
   `null` (so it reads `"passphraseHash": null,`). **Commit** the change.
3. On **each device**, clear this website's saved data (see the box below), open the
   app, connect again (*First time on this device? Connect to GitHub*), and choose a
   new passphrase when asked.

Everything comes back from GitHub when you reconnect.

> **Clearing a website's saved data.**
> *iPhone/iPad:* Settings → Safari → Advanced → Website Data → find the site → delete.
> If it was added to the Home Screen, delete that icon too and add it again.
> *Android (Chrome):* Settings → Site settings → All sites → find the site → Clear & reset.
> *Computer:* click the padlock next to the address → Site settings → Clear data.

## 3. A phone shows an empty budget

This happens when the phone's saved data was cleared (iPhones do this to websites
that haven't been opened for about a week unless they're on the Home Screen). Your
budget is safe on GitHub.

1. Open the app. Tap **First time on this device? Connect to GitHub**.
2. Enter your GitHub username, the repository name (`family-budget-data`), and the
   token (make a new one with [section 1](#1-the-token-expired-or-was-rejected) if
   you don't have it), then **Connect & Sync**.
3. Enter the passphrase. The budget reappears.

Then **add the app to the Home Screen** so it doesn't happen again.

> If an empty phone asks you to *create* a passphrase, connect to GitHub first (step 2).
> If someone already created one, it's fine: connecting replaces it with the family's
> passphrase from GitHub, and the phone then asks for that one.

## 4. Getting something back

**Just now?** Tap **Undo** — it shows for 8 seconds after a delete. A bill marked
paid by mistake has its own **Undo** button next to it.

**Longer ago?** Every saved version is kept on GitHub.

1. github.com → `family-budget-data` → `data` → `budget-data.json` → **History**.
2. Find a version from *before* the mistake (the dates are on the right). Click the
   `<>` button beside it, open `data/budget-data.json` there, and use the
   **Download raw file** button to save it.
3. On a device: **Settings → Restore from Backup** → pick the file you saved → confirm.

Restoring **replaces** everything with that version (the passphrase is kept), so
anything added after that date has to be re-entered. To be safe, first use
**Settings → Download Backup** to save today's version as well.

## 5. Two devices show different numbers

1. On each, open **Settings** and check the line at the top of the screen. It should say
   **Synced**. If it says *Offline*, that device just needs internet.
2. Tap **Settings → Sync Now** on each.
3. Still different? Close the app completely and reopen it. Changes from two devices
   at once are merged (nothing is overwritten), so they should match after a sync.

If a number looks *wrong* rather than different, **Settings → Spreadsheet** downloads
every transaction so you can look through them.

## 6. Setting up a new phone

1. Open the website link. Tap **First time on this device? Connect to GitHub**.
2. Enter your GitHub username, `family-budget-data`, and the token → **Connect & Sync**.
3. Enter the passphrase → **Unlock**.
4. **Settings → Text Size** to taste, and add the page to the **Home Screen**.

No need to make a new token for each phone; they can share one (the app keeps it
only on that phone).

## 7. A phone is lost or stolen

The screen lock only keeps casual snoopers out, so act on both of these:

1. **Cancel the token** so the lost phone can't sync: github.com → Settings → Developer
   settings → Fine-grained tokens → the token → **Delete**.
2. **Change the passphrase** on a device you still have (Settings → Change Passphrase).
3. Make a new token ([section 1](#1-the-token-expired-or-was-rejected)) and enter it on
   the remaining devices.

The lost phone then has no way to read or change the budget on GitHub. (Whatever was
already on it stays on it until it's wiped.)

## 8. The app looks out of date

Close the app completely and open it again while online — it checks for a new version
each time it opens. If it still looks old on a phone, delete the Home Screen icon and
add the page again (your data is on GitHub, so nothing is lost).

---

## Once a year

- Make a new token before the old one expires (the app shows a banner two weeks
  before, on devices where you entered the date) — [section 1](#1-the-token-expired-or-was-rejected).
- **Settings → Download Backup** and keep the file somewhere other than GitHub.

## What the app can't do

- It's one shared passphrase — it doesn't record *who* changed something.
- If two people change the *same* entry at the same moment, the later save wins.
- Changes made with no internet stay on that phone until it reconnects; clearing the
  phone's website data before then loses them.
