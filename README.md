# Panier

A private, collaborative shopping list. Minimal, end-to-end encrypted, on Cloudflare's free plan or your own server.

**Status:** the app works and is tested end to end on both servers, and has run on real phones; next is daily use. The interaction prototype the design came from is kept in [`prototype/index.html`](prototype/index.html).

## How it behaves

### Sections

Each section is a card with its name at the top. A list starts with three:

| Section | Icon | For |
| --- | --- | --- |
| Essentials | house | everyday things the home runs on |
| Look out for | eye | things to buy if you come across them |
| Long term | bookmark | things to get eventually |

- Tap a section's name to rename it. Both phones see the new name.
- *Add a section*, below the cards, adds one at the end with its own colour; the cursor moves to its *Add item* field.
- While you rename a section that has nothing left to get, a bin appears to delete it. The last section can't be deleted. If the other phone adds an item to a section you deleted meanwhile, the section comes back with it.
- Tick boxes take their section's colour.

### Adding

- Every card ends with an *Add item* row. Tapping the row or its `+` opens the field. Items hold up to 120 characters, about four lines.
- As soon as you type, the `+` becomes a tick box: the row is a new item. Enter adds it and keeps the field open for the next one. Leaving the field adds it too, so nothing typed is lost. A notification or switching apps doesn't cut it short, and text left in the field when the app closes is added the next time it opens.
- Typing something already on the list highlights it instead of adding a copy.
- Typing something bought before puts it back, into the section you are typing in.

### Suggestions

- From three letters, items bought before are suggested above the field, so the phone keyboard never hides them.
- Matching ignores accents and case. Matches at the start of the name come first, then the start of a word, then the most recently bought. Five at most.

### Ticking

- Tap the square to tick. A short vibration confirms it.
- Ticked items stay in place, greyed out, for 1.5 seconds. Each new tick restarts the wait, so several items ticked in a row move together and the list does not shift under your thumb.
- They then move to the ticked group below the lists. Its header is a filled tick box, a count and a collapse arrow.
- The group shows what was ticked in the last 12 hours. Older items are hidden but still suggested.
- Dragging an item down onto the drop zone that appears below the sections ticks it straight away; the item shows as ticked while it's over the zone.
- Tapping a ticked square puts the item back at the end of its section, or of the first section if its own was deleted.

### Editing and deleting

- Tap the words to edit them in place; the cursor lands where you tapped. Enter saves, Escape cancels, an empty name restores the old one.
- While editing, a bin appears at the right of the row. Tapping it deletes the item.
- Renaming to the name of another item on screen cancels and highlights that item. Renaming to an older, hidden item merges the two.

### Reordering

- Hold an item for about half a second: it lifts and its tick box turns into a grip. Move to drag it, including into another section; the grip takes the colour of the section it is over. Releasing without moving does nothing.
- With a mouse, dragging starts as soon as you move.
- Until someone has dragged once, the first item lifts briefly when the app opens, to show that items can move.

### Undo and redo

- Every change can be undone. A small undo/redo pill appears at the bottom right after the first change and hides while you type.
- With two people, each person will undo only their own changes.

### Pairing and sync

- The first phone starts the list with the server's setup code. *Add a phone*, at the bottom of the list, shows a QR code and a link for the second phone.
- Changes appear on the other phone within a second. Without signal, the app keeps working and shows *Offline* with the number of changes waiting; they are sent when the connection returns.

### Keyboard and accessibility

- Space ticks, Enter or F2 edits an item or a section name, Delete deletes, Alt+↑/↓ moves an item (across sections at the ends), Ctrl+Z and Ctrl+Shift+Z undo and redo.
- Changes are announced to screen readers. Light and dark themes follow the system; reduced motion is respected.

## How it works

- **App:** an installable web app in plain HTML, CSS and JavaScript ([`web/`](web/)), with no framework and no build step. A service worker keeps it working offline; the list is stored on the phone.
- **One secret per list.** The first phone creates a random 256-bit key. From it, each phone derives (HKDF-SHA-256) the list's id, an access token and an AES-GCM encryption key. The pairing link carries the key after `#`, so it never reaches the server.
- **End-to-end encryption.** Every change is encrypted on the phone before it is sent. The server stores the encrypted changes and a SHA-256 hash of the access token; it never sees item names.
- **Merging.** Each field of each item (name, section, position, ticked) and of each section (name, position, colour) keeps the most recent write, so two phones can edit offline and end up identical. Undo only reverses fields that still hold what you set; if the other phone changed one since, its change stands.
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

[`test/api.test.mjs`](test/api.test.mjs) holds the API tests both servers must pass:

```sh
BASE=http://127.0.0.1:8080 SETUP=<code> node --test test/api.test.mjs
```

## Roadmap

In order of priority. Done so far: the interaction prototype; the server, encryption, pairing and sync; hosting on Cloudflare Workers or your own server; running on two phones.

### 1. Fixes

Small, and felt every day.

1. **Clearer status.** Make being offline or a failed sync obvious and plain, such as a red dot with *Offline*, and say what happens next: changes are kept and sent when the connection returns.
2. Clearing an item's text and leaving it deletes the item, instead of restoring the old text.
3. Enter in the middle of an item's text splits it in two, with the cursor at the start of the second.
4. Ticked items slide into the ticked group again. The page-wide animation was turned off because browsers ignore taps while it plays; the items themselves need animating instead.
5. On Android in dark mode, the navigation bar stays white.
6. The *Add a section* field uses the same type as section names.
7. *Add a phone* reads as adding a person, such as *Add someone to this list*.

### 2. Look and language

Small, and independent of each other.

- Remove the section icons.
- Choose a section's colour from a palette.
- A new app icon: simple and monochrome, in the style of Arcticons, with a monochrome version for Android's themed icons.
- French translation, following the phone's language.

### 3. Settings

One new screen.

- **Appearance:** light, dark, or the same as the phone.
- **Data:** rolling backups, exporting the list, and how much storage it uses.
- **About:** version, server, and what the server can and can't see.

### 4. Bigger features

These change how lists are stored and shared.

- More people, and several lists, each shared with different people.
- Removing a person or phone from a list, by changing the list's key.
- Recurring lists or sections, such as a weekly shop.
- Thematic sub-sections within a section: fruit and vegetables, cleaning, clothes, baby things.
- Folding a section.
- Compacting the change log.

## Licence

[MIT](LICENSE)
