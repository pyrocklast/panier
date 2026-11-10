# Panier

A private, collaborative shopping list. Minimal, end-to-end encrypted, on Cloudflare's free plan or your own server.

**Status:** in daily use on two phones, and tested end to end on both servers before every deploy.

## How it behaves

### The list's name

- The list's name is the title at the top, *Shopping list* to start with (*Liste de courses* in French). Tap it to rename it; both phones see the new name. It also names the exported file.
- Like everything else on the list, it's encrypted: the server can't read it.

### Sections

Each section is a card with its name at the top. A list starts with three:

| Section | Colour | For |
| --- | --- | --- |
| Essentials | green | everyday things the home runs on |
| Look out for | amber | things to buy if you come across them |
| Long term | indigo | things to get eventually |

- Tap a section's name to rename it. Both phones see the new name.
- While you rename a section, its colours show under the name: eight, the same in light and dark themes. A tap recolours the section at once, and undo puts the old colour back.
- *Add a section*, below the cards, adds one at the end with its own colour. Its name is typed like a section name; Enter or the `+` adds it, a cross clears it, and the cursor then moves to its *Add item* field.
- While you rename a section that has nothing left to get, a cross appears to delete it. The last section can't be deleted. If the other phone adds an item to a section you deleted meanwhile, the section comes back with it.
- Tick boxes take their section's colour.

### Adding

- Every card ends with an *Add item* row. Tapping the row or its `+` opens the field. Items hold up to 120 characters, about four lines.
- As soon as you type, a cross appears at the end of the row, where it is when editing an item: tapping it throws away what you typed, and the cursor stays in the field. The `+` stays as it is, since nothing is on the list until it's added. Escape does the same from a keyboard, once any suggestions are closed.
- Enter, or the `+`, adds the new item and keeps the field open for the next one. Leaving the field adds it too, so nothing typed is lost. A notification or switching apps doesn't cut it short, and text left in the field when the app closes is added the next time it opens.
- Typing something already on the list highlights it instead of adding a copy.
- Enter adds just what you typed. Typing the full name of something bought before puts that item back as you typed it, into the section you are typing in, rather than adding a copy. A suggestion only comes back when you tap it.
- **Quantities.** A number at the start, such as *2 milk*, *2× milk*, *500 g flour*, *1.5kg potatoes*, *2 litres of milk* or *3 paquets de pâtes*, is shown slightly apart from the name, in bold. It's left out when comparing names, so *2 litres of milk* is still Milk: typing *3 milk* while it's on the list gives it the new quantity, and *mil* suggests Milk.
- A quantity is for one shop. The ticked group still shows it, so unticking a mistake puts the item back as it was, but suggestions show the name alone and bring it back without the old quantity.

### Suggestions

- From three letters, items bought before are suggested above the field, so the phone keyboard never hides them.
- Matching ignores accents and case. Matches at the start of the name come first, then the start of a word, then the most recently bought. Five at most, each name once.
- Tapping a suggestion puts the item back, with the quantity typed so far if there is one: *2 mil*, then a tap on Milk, gives *2 milk*.
- A × at the end of each suggestion removes that item for good, for typos such as *Mlik*. Undo brings it back.

### Ticking

- Tap the square to tick. A short vibration confirms it.
- Ticked items stay in place, greyed out, for 1.5 seconds. Each new tick restarts the wait, so several items ticked in a row move together and the list does not shift under your thumb.
- They then slide to the ticked group below the lists, always at the same pace, however long the list. When the group is below the screen, they slide out of view at its bottom edge rather than racing all the way down. Its heading reads *3 ticked*, with an arrow to fold it away.
- The group shows what was ticked in the last 12 hours. Older items are hidden but still suggested.
- Dragging an item down onto the drop zone that appears under the ticked group's heading ticks it straight away; the item shows as ticked while it's over the group. The heading shows during the drag even when nothing is ticked yet.
- Tapping a ticked square puts the item back at the end of its section, or of the first section if its own was deleted. Dragging a ticked item into a section puts it back right where you drop it.

### Editing and deleting

- Tap the words to edit them in place; the cursor lands where you tapped. Enter saves, Escape cancels.
- Enter in the middle of the text splits the item in two: the first part stays, the second becomes the next item, with the cursor at its start. One undo joins them again.
- Backspace at the very start of an item joins it onto the item above, the reverse of Enter; straight after a split, the two parts join back exactly. In an emptied item, Backspace deletes it and moves to the end of the item above.
- Clearing the text and leaving deletes the item. An emptied section name goes back to the old one.
- While editing, a cross appears at the right of the row. Tapping it deletes the item.
- Renaming to the name of another item on screen cancels and highlights that item. Renaming to an older, hidden item merges the two.

### Reordering

- Hold an item for about half a second: it lifts and its tick box turns into a grip. Move to drag it, including into another section; the grip takes the colour of the section it is over. Releasing without moving does nothing.
- Sections move the same way, held by their name. While one moves, every section folds down to its name, so even long ones are easy to reorder; they unfold when it's let go.
- When you let go, the item glides into its place. Things that move after a change glide too, without ever getting in the way of a tap.
- With a mouse, dragging starts as soon as you move.
- Until someone has dragged once, the first item lifts briefly when the app opens, to show that items can move.

### Undo and redo

- Every change can be undone. An undo button appears at the bottom right after the first change and hides while you type. Redo joins it once something has been undone.
- For a few seconds after deleting an item, a section or a suggestion, the undo button shows its name: what a tap would bring back.
- With two people, each person will undo only their own changes.

### Pairing and sync

- The first phone starts the list with the server's setup code. *Add someone to this list*, at the bottom of the list, shows a QR code and a link for the second phone.
- Changes appear on the other phone within a second. What the other phone adds, renames, moves to another section, ticks or unticks is tinted briefly where it is, without anything moving. A phone opening a list for the first time sees nothing tinted. Without signal, the app keeps working and shows *Offline* with the number of changes waiting; they are sent when the connection returns.
- Opening the link to a different list, on a phone that already has one, asks first: until there can be several lists, the phone would leave the one it has. It also says if changes made on it haven't been sent yet.

### Settings

*Settings*, at the bottom of the list, opens a page of its own; the phone's back gesture closes it.

- **Appearance:** the same as the phone, light or dark; a style; and a *Compact layout* switch: rows of 44 px instead of 52, with smaller gaps and titles, so more of the list fits on screen. All three are chosen on each phone.
  - *Cards* puts each section on a card of its own.
  - *Paper* writes the list straight on the page: no cards, everything on one left edge, ruled lines between items and under section names, and an underline where you type. Only what's lifted above the page has a shadow: an item or section being dragged, undo, the sheets. Ticked items sit on a stub below a dashed tear line, in smaller grey text.
- **Data:** whether the browser keeps the list even when the phone runs low on space. Panier asks for this when you start or join a list; Firefox asks you once, Chrome decides for itself. If it isn't kept, a button asks again, with a reminder that the pairing link brings the list back. Then *Export the list*, which saves it as a text checklist named after the list: each section's items to get, then everything bought before, by name.
- **About:** the version, the server, how much space the list takes on this phone, and what the server can and can't see.

### Keyboard and accessibility

- Space ticks, Enter or F2 edits an item or a section name, Delete deletes, Alt+↑/↓ moves an item (across sections at the ends) or, on its name, a section, Ctrl+Z and Ctrl+Shift+Z undo and redo.
- In suggestions, ↓ and ↑ choose one, → moves to its ×, and Enter picks; Shift+Delete removes the one chosen.
- Changes are announced to screen readers. Light and dark themes follow the system unless chosen in Settings; reduced motion is respected.

### Languages

Panier is in English and French, following the phone's language. The default section names follow it too, until one is renamed: *Essentiels*, *À l’occasion*, *À long terme*. The words live in `web/i18n.js`; another language is one more table there.

## How it works

- **App:** an installable web app in plain HTML, CSS and JavaScript ([`web/`](web/)), with no framework and no build step. A service worker keeps it working offline, and an update downloads only the app's own files: fonts, icons and the QR code library (loaded only for pairing) are kept across updates. The list is stored on the phone, written once per burst of changes.
- **Font:** Atkinson Hyperlegible Next, designed to keep letters such as I, l and 1 apart, under the SIL Open Font License ([`web/fonts/OFL.txt`](web/fonts/OFL.txt)).
- **One secret per list.** The first phone creates a random 256-bit key. From it, each phone derives (HKDF-SHA-256) the list's id, an access token and an AES-GCM encryption key. The pairing link carries the key after `#`, so it never reaches the server.
- **End-to-end encryption.** Every change is encrypted on the phone before it is sent. The server stores the encrypted changes and a SHA-256 hash of the access token; it never sees item names.
- **Merging.** Each field of each item (name, section, position, ticked) and of each section (name, position, colour) keeps the most recent write, so two phones can edit offline and end up identical. Undo only reverses fields that still hold what you set; if the other phone changed one since, its change stands. Deleted items are remembered for about six months, so a late change from a phone that was offline can't bring them back, then forgotten.
- **Server:** two interchangeable servers implement the same small API, and the app works with either. Both store the encrypted changes for each list in arrival order and announce new ones over a WebSocket. New lists need a setup code.
  - **Cloudflare Workers** ([`worker/index.js`](worker/index.js)): one Durable Object, with its own SQLite database, per list. It sleeps between changes.
  - **Go** ([`main.go`](main.go), [`api.go`](api.go), [`store.go`](store.go), [`live.go`](live.go)): one program using only the standard library, with one log file per list, for running on your own machine.

[SECURITY.md](SECURITY.md) explains what Panier protects and what it doesn't, and how to report a problem.

## Running it

- **On Cloudflare (free, nothing to keep running):** follow [docs/cloudflare.md](docs/cloudflare.md). GitHub deploys each change to `main` once the tests pass.
- **On your own server, such as a Raspberry Pi:** follow [docs/raspberry-pi.md](docs/raspberry-pi.md); [`deploy/install.sh`](deploy/install.sh) does the work on the server. Publishing a release on GitHub (tag `v…`) builds ready-to-run programs for the Raspberry Pi (`arm64`, `armv7`, `armv6`) and `amd64`; the install script downloads the latest one.

To try it on a computer, with Go 1.22 or later:

```sh
go run . -data ./data              # serves http://127.0.0.1:8080
go run . -data ./data -setup-code  # prints the setup code
```

Then open `http://127.0.0.1:8080/#setup=<code>`. Phones need HTTPS, or `localhost`: with USB debugging, `adb reverse tcp:8080 tcp:8080` lets an Android phone open `http://localhost:8080`.

Both servers must pass the same tests, which GitHub runs before every deploy: [`test/api.test.mjs`](test/api.test.mjs) for the API, [`test/browser.test.mjs`](test/browser.test.mjs) with two simulated phones using the app, and [`test/update.test.mjs`](test/update.test.mjs), which swaps two builds while the app is open, as a deploy does. The browser tests need Playwright with Chromium.

```sh
BASE=http://127.0.0.1:8080 SETUP=<code> node --test test/api.test.mjs
BASE=http://127.0.0.1:8080 SETUP=<code> STORE=./data node --test test/browser.test.mjs
```

## Roadmap

In order. Each batch is built, tested on both servers, deployed, and tried on the phones before the next.

Done so far: the server, encryption, pairing and sync; hosting on Cloudflare Workers or your own server; editable sections, dragging to tick, adding without Enter; browser tests on every deploy; a clear status when offline; updates in one launch; *Add someone to this list*; splitting an item with Enter and joining it back with Backspace, deleting it by clearing its text, removing suggestions; a tap that leaves a field always lands, on touch screens too; the drop zone inside the ticked group, dragging ticked items back, and items gliding into place again; sections without icons, with a colour chosen from a palette; reordering sections by dragging; quantities; a new app icon; Settings; French.

### 1. Bigger features

These change how lists are stored and shared, so each starts with a short design note and sketches of the screens, agreed before building.

- Rolling backups, kept on the server and encrypted like everything else.
- More people, and several lists, each shared with different people.
- Removing a person or phone from a list, by changing the list's key.
- Recurring lists or sections, such as a weekly shop.
- Thematic sub-sections within a section: fruit and vegetables, cleaning, clothes, baby things.
- Folding a section.
- Compacting the change log.

Waiting on browsers: the app icon has a monochrome version, for Android's themed icons, but no browser on Android uses it for installed web apps yet. The Android navigation bar's colour is the browser's to choose. Chrome takes it from one manifest colour, now dark, so it's dark in light mode too until Chrome supports separate dark-mode colours (`color_scheme_dark`, already in the manifest). Firefox appears to use its own theme; to check on a phone.

## Licence

[MIT](LICENSE)
