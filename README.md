# Panier

A private, collaborative shopping list. Minimal, end-to-end encrypted, on Cloudflare's free plan or your own server.

**Status:** in daily use on two phones, and tested end to end on both servers before every deploy.

## How it behaves

### Sections

Each section is a card with its name at the top. A list starts with three:

| Section | Colour | For |
| --- | --- | --- |
| Essentials | green | everyday things the home runs on |
| Look out for | amber | things to buy if you come across them |
| Long term | indigo | things to get eventually |

- Tap a section's name to rename it. Both phones see the new name.
- While you rename a section, its colours show under the name: eight, the same in light and dark themes. A tap recolours the section at once, and undo puts the old colour back.
- *Add a section*, below the cards, adds one at the end with its own colour. Its name is typed like a section name, and the cursor then moves to its *Add item* field.
- While you rename a section that has nothing left to get, a cross appears to delete it. The last section can't be deleted. If the other phone adds an item to a section you deleted meanwhile, the section comes back with it.
- Tick boxes take their section's colour.

### Adding

- Every card ends with an *Add item* row. Tapping the row or its `+` opens the field. Items hold up to 120 characters, about four lines.
- As soon as you type, the `+` becomes a tick box: the row is a new item. Enter adds it and keeps the field open for the next one. Leaving the field adds it too, so nothing typed is lost. A notification or switching apps doesn't cut it short, and text left in the field when the app closes is added the next time it opens.
- Typing something already on the list highlights it instead of adding a copy.
- Typing something bought before puts it back, into the section you are typing in.
- **Quantities.** A number at the start, such as *2 milk*, *2× milk*, *500 g flour* or *1.5kg potatoes*, is shown slightly apart from the name, in bold. It's left out when comparing names, so *2 milk* is still Milk: typing it when Milk is on the list, or was bought before, gives that item the new quantity, and *2 mil* suggests Milk.

### Suggestions

- From three letters, items bought before are suggested above the field, so the phone keyboard never hides them.
- Matching ignores accents and case. Matches at the start of the name come first, then the start of a word, then the most recently bought. Five at most.
- A × at the end of each suggestion removes that item for good, for typos such as *Mlik*. Undo brings it back.

### Ticking

- Tap the square to tick. A short vibration confirms it.
- Ticked items stay in place, greyed out, for 1.5 seconds. Each new tick restarts the wait, so several items ticked in a row move together and the list does not shift under your thumb.
- They then slide to the ticked group below the lists. Its header is a filled tick box, a count and a collapse arrow.
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

- Every change can be undone. A small undo/redo pill appears at the bottom right after the first change and hides while you type.
- With two people, each person will undo only their own changes.

### Pairing and sync

- The first phone starts the list with the server's setup code. *Add someone to this list*, at the bottom of the list, shows a QR code and a link for the second phone.
- Changes appear on the other phone within a second. Without signal, the app keeps working and shows *Offline* with the number of changes waiting; they are sent when the connection returns.

### Settings

*Settings*, at the bottom of the list, opens a page of its own; the phone's back gesture closes it.

- **Appearance:** the same as the phone, light or dark, chosen on each phone.
- **Data:** whether the browser keeps the list even when the phone runs low on space. Panier asks for this when you start or join a list; Firefox asks you once, Chrome decides for itself. If it isn't kept, a button asks again, with a reminder to keep the pairing link somewhere safe. Below, how much space the list takes on the phone, and *Export the list*, which saves it as a text checklist: each section's items to get, then everything bought before.
- **About:** the version, the server, and what the server can and can't see.

### Keyboard and accessibility

- Space ticks, Enter or F2 edits an item or a section name, Delete deletes, Alt+↑/↓ moves an item (across sections at the ends) or, on its name, a section, Ctrl+Z and Ctrl+Shift+Z undo and redo.
- In suggestions, ↓ and ↑ choose one, → moves to its ×, and Enter picks; Shift+Delete removes the one chosen.
- Changes are announced to screen readers. Light and dark themes follow the system unless chosen in Settings; reduced motion is respected.

### Languages

Panier is in English and French, following the phone's language. The default section names follow it too, until one is renamed: *Essentiels*, *À l’occasion*, *À long terme*. The words live in `web/i18n.js`; another language is one more table there.

## How it works

- **App:** an installable web app in plain HTML, CSS and JavaScript ([`web/`](web/)), with no framework and no build step. A service worker keeps it working offline, and an update downloads only the app's own files: fonts, icons and the QR code library (loaded only for pairing) are kept across updates. The list is stored on the phone, written once per burst of changes.
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
