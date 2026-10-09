# Our Family Budget

A simple, spreadsheet-like household budget — built to be easy to read and easy
to update, with big text and big buttons. It works on phones, tablets and
computers, keeps working with no internet, and syncs between everyone's devices
through a **private** GitHub repository so everybody sees the same numbers.

No accounts to create, no ads, no analytics, no third-party servers. The only
place the app ever talks to is `api.github.com`, to save and load one data file
in your own private repository.

## How it's put together (two repositories)

| | What it holds | Visibility |
|---|---|---|
| **`family-budget-app`** | The app itself (this code). GitHub Pages publishes it as the website everyone opens. | Public — it contains no budget information |
| **`family-budget-data`** | One file, `data/budget-data.json`: the actual budget. | **Private** |

Keeping them separate is what keeps the budget private. The website is public,
but the numbers are only reachable with the access token. Never connect the app
to the public repository: the app will show a red warning if it detects that.

## What's inside

- **Home** — **Coming Up** shows the bills due in the next 7 days that aren't
  paid yet, each with a *Mark Paid* button, plus any bill from earlier this
  month that isn't marked paid (tap *Mark Paid* if it was already paid, so it's
  recorded). **Savings Goals** shows progress toward things you're saving for;
  *Add Money* records it in the Log as a Savings expense. Then this month's income, spending,
  what's left over, and total debt. Each spending category says how it compares with last month, and **Month by
  Month** lists the last 6 (or 12) months side by side — tap one to open it.
- **Budget** — plan how much to spend in each category and see what you've
  actually spent. A month you haven't planned yet starts with the most recent
  plan, so amounts don't need retyping each month; change any amount to make
  that month its own. Below it:
  - **This Pay Period** — tell it when you get paid (weekly, every 2 weeks,
    twice a month, or monthly) and it lists the bills due before the next
    paycheck, what's already paid, and how much is still to pay. You can mark
    a bill paid right from there. If regular paychecks are set up, it also shows
    the paychecks landing in the period minus its bills — what's left to spend.
  - **Regular Paychecks** — enter a paycheck once (who, how much, how often)
    and it is added to the Log as income on every payday, on any device that
    opens the app. Paychecks start from the day you set them up; earlier ones
    can be added by hand. Edit a paycheck's amount any time — it applies to
    future paydays only. Deleting a paycheck from the Log keeps it deleted.
  - **Your Bills** — each bill on its own with an amount, due day, how often
    it's due (every month, every 3 or 6 months, or once a year — such a bill
    only shows up in the months it's due), and category
    (change the category right in the list). Check bills off with *Mark Paid* (it offers the last amount paid, handy for
    bills that change),
    sort the list by due day, name or category, and optionally link a bill to a
    debt so paying it also lowers that debt's balance. **Print Bills List**
    makes a large-print sheet (all bills this month, or just those due before
    the next payday) with a box to tick off by hand — handy for the fridge.
- **Log** — every transaction, income or expense. Type in the **Search** box
  (a store, a category, a date or an amount) to find matches across all months,
  with what they add up to.
- **Debt** — each debt's balance and progress, with a "focus this one first"
  suggestion (*Snowball*: smallest first, or *Avalanche*: highest interest first).
  The **Debt-Free Date** card estimates when everything will be paid off, and
  what paying a little extra each month would change.
- **Settings** — GitHub sync, categories, passphrase, **text size** (Normal,
  Large, Extra large — per device), backups, **Spreadsheet** (download your
  transactions as a CSV file for Excel or Google Sheets — all of them or one
  year; spending is negative so a column can be summed), and locking a device.

## Undo

Deleting a transaction, bill, debt, category or paycheck shows **Undo** for a few
seconds. While it's showing, the deletion isn't sent to GitHub yet, so Undo puts
everything back — including a debt's balance — on every device.

## Using it with no internet

After the first visit the app opens even with no connection, and your changes
are kept on the device and synced the next time you're online. Open the site
once while online (and, on a phone, "Add to Home Screen") to set this up.

## The passphrase — what it does and doesn't do

The passphrase is a lock on the screen so that someone who picks up an unlocked
phone can't just look at the budget. It is **not encryption**: it's checked in
the page itself, and the budget is stored on each device as readable text. The
real protection for the numbers is that they live in a private repository that
needs the access token.

- Changing the passphrase (Settings → Change Passphrase) **locks every other
  device** until the new one is entered there.
- A forgotten passphrase can't be looked up (only a scrambled version is
  stored). If any device is still unlocked, use Settings → Change Passphrase.
  If every device is locked: on github.com open `data/budget-data.json` in the
  private data repository and change the `passphraseHash` value to `null`,
  then on each device clear this site's data in the browser, reconnect, and
  choose a new passphrase.

## One-time setup (you do this once)

1. **The app repository** is the public one that publishes the website. If you
   are starting from scratch: push this folder to a new public repository, then
   *Settings → Pages → Deploy from a branch → `master` / root*. GitHub gives
   you the link everyone will use, like
   `https://yourname.github.io/family-budget-app/`.
2. **Create the data repository.** On GitHub, create a new repository named
   `family-budget-data` and choose **Private**. Leave it empty.
3. **Create an access token.** github.com → *Settings → Developer settings →
   Personal access tokens → Fine-grained tokens → Generate new token*:
   - *Repository access*: **Only select repositories** → `family-budget-data`
     (just that one).
   - *Permissions → Repository permissions → **Contents: Read and write***.
     (*Metadata: Read-only* is added automatically; leave everything else off.)
   - Pick the **longest expiration GitHub offers (1 year)** so there's only one
     renewal a year, and **write the expiry date down** — you'll give it to the
     app so it can remind you.
   - Generate it and copy it right away; GitHub shows it only once.
4. **Open the website** and choose a passphrase. Then open *"First time on this
   device? Connect to GitHub"* and enter your GitHub username, the data
   repository name (`family-budget-data`), the token, and (optional) the date
   the token expires. Your budget now saves to the private repository.

## Setting up your parents' devices

Give them the website link, the passphrase, and the token (plus the data
repository name and your GitHub username). On each device:

1. Open the link and tap **"First time on this device? Connect to GitHub"**,
   fill in the details, and tap **Connect & Sync**.
2. Enter the passphrase and tap **Unlock**.
3. In **Settings → Text Size**, choose a size that's comfortable.

After that the device stays unlocked and connected. Changes on any device show
up on the others whenever there's a connection.

## When the token expires

Fine-grained tokens stop working on their expiry date and GitHub doesn't let a
web page read that date, so the app asks you for it (Settings → GitHub Sync →
*Token expires on*). Two weeks before, a banner appears at the top: make a new
token (step 3 above) and paste it into Settings → GitHub Sync on each device.
If it lapses anyway, the status line at the top says *"Token expired or
rejected"*. Nothing is lost while syncing is stopped — everything stays on the
device and uploads once a working token is entered.

## Backups

Settings → **Download Backup** saves everything as a file. **Restore from
Backup** replaces what's there with that file (your passphrase is kept). The
private repository's history is also a running backup of every saved version.

## If sync has trouble

The status line at the top says what's going on:

| It says | What it means |
|---|---|
| Synced | Everything is saved and shared. |
| Offline — saved here, will sync later | No connection. Nothing is lost; it syncs when you're back online. |
| Token expired or rejected | Enter a new token in Settings → GitHub Sync. |
| GitHub can't find the repository | Check the username and repository name in Settings. |
| Saved here — will retry shortly | Two devices saved at the same moment; it merges them and retries automatically. |

Changes made on two devices at once are **merged**, not overwritten: bills,
payments, and everything else added on each device are kept. Deletions are
remembered so a deleted item doesn't come back.

## For whoever maintains this

- Run the automated checks (Node 20+, nothing to install): `node tests/run-tests.js`.
  They cover the budget and pay-period math (including evenings and daylight
  saving), regular paychecks (every frequency, no duplicates across devices),
  the month-by-month figures, the printable list, undo, the debt-free
  projection, Log search, carried-over budgets, overdue bills, savings goals, bills that aren't monthly,
  the spreadsheet export, the sync merge logic,
  backup/restore, the offline service worker, bill and debt linking, and color
  contrast in light and dark mode.
- Deploying is just pushing to `master`; GitHub Pages publishes it in about a
  minute. Phones pick up the new version the next time the app is opened with a
  connection.
- `data/` is in `.gitignore` so budget data can never be committed to this
  public repository by accident.
