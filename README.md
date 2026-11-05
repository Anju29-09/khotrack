# KhoTrack

Live Kho Kho match scoring, team registration and score sheets. Runs in any browser
and installs as an app on a laptop, phone or tablet.

**Open it:** https://anju29-09.github.io/khotrack/

## Install it

| Device | How |
|---|---|
| Laptop / PC | Open in Chrome or Edge, click the **install** icon at the right of the address bar |
| Android | Open in Chrome, then **Add to Home screen** |
| iPhone / iPad | Open in Safari, then Share → **Add to Home Screen** |

Once installed it works with no internet.

## What it does

- **Register teams** — Men/Women, U14/U18/Open, up to 15 players. Invite a team by
  WhatsApp and paste their reply straight into the form.
- **Score a match live** — batches and cycles, Dream Run bonuses, 1 or 2 points per
  wicket, sudden death, undo, and a clock that survives the app being closed.
- **Score sheets** — ball-by-ball with per-attacker wicket totals, editable after the
  match, and printed, downloaded or shared as a PDF.

### Keyboard shortcuts (laptop)

`Space` start / pause / resume · `L` lap · `U` undo · `D` delete batch ·
`H` reset half · `S` skip · `F` finish · `Esc` clear

Jerseys `2`-`9` land on a single key. `1` and `10`-`15` take two digits - `01` is
jersey 1, `12` is jersey 12 - and land on the second one with no wait. `00` means no
jersey. First number is the attacker, second is the defender.

## Your data stays on your device

Teams and matches are kept in the browser's own storage on the device you used. Nothing
is uploaded, there is no account and no server holding your data. Two devices therefore
never see each other's matches, and clearing the browser's site data clears the app the
same way uninstalling would. Save a match as a PDF if you need a copy.

## Running it locally

Any static file server will do — the service worker needs `http://`, not a `file://`
path:

```
python -m http.server 8777
```

then open <http://127.0.0.1:8777/index.html>.

After changing any file, bump the version in `sw.js` (`khotrack-v28` → `v29`) or the
old cached copy keeps being served.

| File | What it is |
|---|---|
| `index.html` | every screen's markup |
| `styles.css` | shared styling |
| `share.js` | the WhatsApp registration format |
| `app.js` | storage, navigation, registration, teams, match selection, toss |
| `scoring.js` | the live scoring engine |
| `detail.js` | score sheet, editing, and the PDF layout |
| `pdf.js` | a small PDF writer, so exporting works with no internet |
| `sw.js` | offline cache |
