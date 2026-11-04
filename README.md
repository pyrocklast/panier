# Panier

A private, collaborative shopping list. Minimal, end-to-end encrypted, self-hosted.

**Status:** the app and its server work and are tested end to end, and the Raspberry Pi setup is written; next is testing on real phones. The interaction prototype the design came from is kept in [`prototype/index.html`](prototype/index.html).

## How it behaves

### Three kinds of list

Each kind is a card, in this order:

| List | Icon | For |
| --- | --- | --- |
| Essentials | house | everyday things the home runs on (the default) |
| Look out for | eye | things to buy if you come across them |
| Long term | bookmark | things to get eventually |

The icon sits in the card's top-right corner and the tick boxes take the list's colour. The names are read out to screen readers.

### Adding

- Every card ends with an *Add item* row. Tapping the row or its `+` opens the field; Enter adds the item to the end of that list and keeps the field open for the next one.
- Typing something already on the list highlights it instead of adding a copy.
- Typing something bought before puts it back, into the list you are typing in.

### Suggestions

- From three letters, items bought before are suggested above the field, so the phone keyboard never hides them.
- Matching ignores accents and case. Matches at the start of the name come first, then the start of a word, then the most recently bought. Five at most.

### Ticking

- Tap the square to tick. A short vibration confirms it.
- Ticked items stay in place, greyed out, for 1.5 seconds. Each new tick restarts the wait, so several items ticked in a row move together and the list does not shift under your thumb.
- They then move to the ticked group below the lists. Its header is a filled tick box, a count and a collapse arrow.
- The group shows what was ticked in the last 12 hours. Older items are hidden but still suggested.
- Tapping a ticked square puts the item back at the end of its list.

### Editing and deleting

- Tap the words to edit them in place; the cursor lands where you tapped. Enter saves, Escape cancels, an empty name restores the old one.
- While editing, a bin appears at the right of the row. Tapping it deletes the item.
- Renaming to the name of another item on screen cancels and highlights that item. Renaming to an older, hidden item merges the two.

### Reordering

- Hold an item for about half a second: it lifts and its tick box turns into a grip. Move to drag it, including into another list; the grip takes the colour of the list it is over. Releasing without moving does nothing.
- With a mouse, dragging starts as soon as you move.
- Until someone has dragged once, the first item lifts briefly when the app opens, to show that items can move.

### Undo and redo

- Every change can be undone. A small undo/redo pill appears at the bottom right after the first change and hides while you type.
- With two people, each person will undo only their own changes.

### Pairing and sync

- The first phone starts the list with the server's setup code. *Add a phone*, at the bottom of the list, shows a QR code and a link for the second phone.
- Changes appear on the other phone within a second. Without signal, the app keeps working and shows *Offline* with the number of changes waiting; they are sent when the connection returns.

### Keyboard and accessibility

- Space ticks, Enter or F2 edits, Delete deletes, Alt+↑/↓ moves an item (across lists at the ends), Ctrl+Z and Ctrl+Shift+Z undo and redo.
- Changes are announced to screen readers. Light and dark themes follow the system; reduced motion is respected.

## How it works

- **App:** an installable web app in plain HTML, CSS and JavaScript ([`web/`](web/)), with no framework and no build step. A service worker keeps it working offline; the list is stored on the phone.
- **One secret per list.** The first phone creates a random 256-bit key. From it, each phone derives (HKDF-SHA-256) the list's id, an access token and an AES-GCM encryption key. The pairing link carries the key after `#`, so it never reaches the server.
- **End-to-end encryption.** Every change is encrypted on the phone before it is sent. The server stores the encrypted changes and a SHA-256 hash of the access token; it never sees item names.
- **Merging.** Each field of each item (name, list, position, ticked) keeps the most recent write, so two phones can edit offline and end up identical. Undo only reverses fields that still hold what you set; if the other phone changed one since, its change stands.
- **Server:** one Go program ([`main.go`](main.go), [`api.go`](api.go), [`store.go`](store.go)) using only the standard library. It serves the app, appends encrypted changes to one log file per list and announces new ones over Server-Sent Events. New lists need the setup code generated on the server's first run.

What the server can see: when changes happen, roughly how big they are, and which addresses connect. What it cannot see: anything written in the list.

Limits to know: anyone with the pairing link can open the list, and a phone cannot be removed from a list yet. To cut a phone off, start a new list. If every phone and every copy of the link is lost, the list cannot be recovered.

## Running it

You need Go 1.22 or later.

```sh
go run . -data ./data              # serves http://127.0.0.1:8080
go run . -data ./data -setup-code  # prints the setup code
```

Open `http://127.0.0.1:8080/#setup=<code>` to start a list. Phones need HTTPS, so on a real server it goes behind a reverse proxy such as Caddy. To set it up on a Raspberry Pi, follow [docs/raspberry-pi.md](docs/raspberry-pi.md); [`deploy/install.sh`](deploy/install.sh) does the work on the Pi.

Publishing a release on GitHub (tag `v…`) builds ready-to-run programs for the Raspberry Pi (`arm64`, `armv7`, `armv6`) and `amd64` and attaches them to it; the install script downloads the latest one.

## Roadmap

1. Interaction prototype ✓
2. Server, encryption, pairing and sync ✓
3. Raspberry Pi install script and setup guide ✓
4. Install on both phones and test in a shop

Later: several lists; lists shared with different groups of people; folding a list by tapping its icon.

## Licence

[MIT](LICENSE)
