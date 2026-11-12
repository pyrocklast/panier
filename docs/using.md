# Using Panier

Everything the app does, in detail. The [README](../README.md) has the short version.

## Starting

- **The first phone** opens the app's address and types the server's setup code (see [docs/cloudflare.md](cloudflare.md) or [docs/raspberry-pi.md](raspberry-pi.md) for where it comes from). The first list starts with three sections.
- **Another phone** joins with *Add someone to this list*, at the bottom of the list: it shows a QR code to scan, and buttons to share or copy the link.
- **Keep a copy of each list's link** in a password manager. It is the key to the list: it's the only way to get the list back if every phone is lost, and anyone who has it can open the list.
- **Install it** so it opens like an app, full screen and offline: in Firefox, **⋮ → Install** (or **Add to home screen**); in Chrome, **⋮ → Install app**; on an iPhone, Safari's **Share → Add to Home Screen**.
- **Opening a list's link** on a phone that has other lists adds it beside them, and opens it.

## Lists

A phone holds any number of lists, each shared with its own people. The app opens on the list last used.

- **The lists page** is reached with the sheets at the top right of a list, or the phone's back gesture. Each list lies there as a sheet in its own tint: its name, what's left to get, and the first two of those, as this phone last saw them. Lists not on screen catch up as the page shows.
- **Open** a list with a tap.
- **New list:** type a name on the blank sheet below the others. The server makes it on the strength of a list this phone already has; if it won't, it asks for the setup code.
- **Move** a list: hold it, then drag. From a keyboard, Alt+↑ and Alt+↓.
- **Take a list off this phone:** drag it onto the zone that appears at the foot, or tap the cross by its name while renaming it. It stays on the server for the others, and its link brings it back. Undo, at the bottom right, puts it back where it was.
- **Settings** is at the top right of the lists page.

## The page

The list is written on the page itself, like paper: one left edge, ruled lines between items and under section names, and an underline where you type. Only what is lifted off the page has a shadow: something being dragged, the undo button, the sheets.

- **The list's name** is the title at the top, *Shopping list* to start with. Tap it to rename it. It also names the exported file. At its right, the sheets lead to the lists page.
- **The list's colour.** While you rename the list, colours show under its name: white and eight hues. The paper takes a light tint of the colour, the ruled lines and quieter text a deeper one, and the title a deep shade. The browser's bars follow, and the app opens in the colour without a flash of white.
- Both phones see the name and colour, and undo puts the old ones back.

## Sections

A list starts with three sections:

| Section | Colour | For |
| --- | --- | --- |
| Essentials | ink | everyday things the home runs on |
| Look out for | amber | things to buy if you come across them |
| Long term | indigo | things to get eventually |

- **Rename** a section by tapping its name. Both phones see the new name. Emptying the name and leaving puts the old one back.
- **Colour.** While you rename a section, its colours show under the name: ink and eight hues. A tap recolours it at once. Its tick boxes take the colour, and its *Add item* row a deep shade of it (grey for ink, so it doesn't pass for an item).
- **Add a section** with *Add a section*, below the last one. It gets the first colour not used yet. Enter or `+` adds it, the cross clears what you typed, and the cursor then moves to its *Add item* row.
- **Delete** a section once nothing is left to get in it: while you rename it, a cross appears. The last section can't be deleted. If the other phone adds an item to a section you deleted meanwhile, the section comes back with it.

## Adding items

- Every section ends with an *Add item* row. Tap it, or its `+`, and type. An item holds up to 120 characters, about three lines.
- **Enter** or `+` adds the item and keeps the field open for the next one.
- **Leaving the field** adds what you typed, so nothing is lost, and what you tapped to leave stays where it is on screen. A notification or switching apps doesn't cut it short. Text left in the field when the app closes is added the next time it opens.
- **The cross** at the end of the row throws away what you typed, and the cursor stays in the field. Escape does the same from a keyboard, once any suggestions are closed.
- **Something already on the list** is highlighted instead of added twice. Typing the full name of something bought before puts that item back, into the section you are typing in.
- **Quantities.** A number at the start, such as *2 milk*, *2× milk*, *500 g flour*, *1.5kg potatoes*, *2 litres of milk* or *3 paquets de pâtes*, is shown in bold, slightly apart from the name. It's left out when comparing names: *2 litres of milk* is still Milk, typing *3 milk* while it's on the list changes the quantity, and *mil* suggests Milk.
- A quantity is for one shop. The ticked group still shows it, so unticking a mistake puts the item back as it was, but a suggestion brings the item back without it.

## Suggestions

- From the second letter, items bought before are suggested above the field, where the phone's keyboard can't hide them.
- Accents and capitals don't matter. Names that start with what you typed come first, then names with a word that does, then the most recently bought. Five at most.
- **Tap a suggestion** to put the item back, with any quantity typed so far: *2 mil*, then Milk, gives *2 milk*. Enter only adds what you typed.
- **The × on a suggestion** removes that item for good, for typos such as *Mlik*. Undo brings it back.

## Ticking

- **Tap the square** to tick an item. A short vibration confirms it in Chrome and Samsung Internet on Android. Firefox and Safari don't let web pages vibrate.
- Ticked items stay in place, greyed out, for 1.5 seconds. Each new tick restarts the wait, so several items ticked in a row leave together and the list doesn't move under your thumb.
- They then slide into **the ticked group**, below the sections, after a dashed tear line. It shows what was ticked in the last five days, latest first, so you can check what was bought lately. Its heading, such as *3 ticked*, folds it away.
- Older ticked items are hidden, but still suggested when you type.
- **Untick** an item by tapping its square: it goes back to the end of its section, or of the first section if its own was deleted.
- **Drag** an item onto the drop zone under the ticked group's heading to tick it, or drag a ticked item into a section to put it back exactly where you drop it.

## Editing and deleting

- **Tap the words** to edit them; the cursor lands where you tapped. Enter saves, Escape cancels.
- **Enter in the middle** splits the item in two, with the cursor at the start of the second. One undo joins them again.
- **Backspace at the start** joins the item onto the one above. Straight after a split, it joins the two parts back exactly.
- **Delete** an item with the cross at the right of the row while editing, or by clearing its text and leaving. In an empty item, Backspace deletes it and moves to the end of the item above.
- **Renaming to the name of another item** on screen cancels and highlights that item. Renaming to an older, hidden item merges the two.

## Reordering

- **Hold an item** for about half a second: it lifts and its tick box turns into a grip. Drag it anywhere, including into another section; the grip takes the colour of the section it's over. Letting go without moving does nothing. With a mouse, dragging starts as soon as you move.
- **Hold a section's name** to move the section. While it moves, every section folds down to its name, so long ones are easy to reorder; they unfold when you let go, and the one you moved stays where you dropped it.
- What you let go of glides into its place, and anything else that moves after a change glides too, without getting in the way of a tap.
- Until someone has dragged once, the first item lifts briefly when the app opens, to show that items can move.

## Undo and redo

- Every change can be undone. The undo button appears at the bottom right after the first change, and hides while you type. Redo joins it once something has been undone.
- For a few seconds after deleting an item, a section or a suggestion, or taking a list off the phone, the undo button shows its name, so you know what a tap brings back.
- Each person undoes only their own changes. If someone else has changed something since, their change stands, and undo says who, by the name they gave.

## Import and export

Lists go out and come in as Markdown checklists, readable in any notes app:

```markdown
# Shopping list <!-- green -->

## Essentials <!-- ink -->
- [ ] 2 milk
- [x] Eggs
```

`#` is the list's name, `##` each section in order, `- [ ]` an item to get, `- [x]` one bought before, under its section. Colours ride in comments after the headings, which notes apps hide.

- **Export the list**, at the bottom of a list, saves it as a `.md` file named after it.
- **Export all lists**, in Settings, saves every list in one file, each under its own `#`.
- **From a file**, on the lists page, brings in a list, or several from one file. It reads any Markdown checklist: other bullets, numbered lines, headings of any level, plain lines. It also reads the `.txt` files the earlier *Export the list* saved. Items bought before come in as suggestions, not ticked.
- **Pasting several lines** into *Add item* adds one item per line, in that section, in one step to undo. Names already on the list are left as they are.

## People

- **Your name**, in Settings, shows to the people you share lists with. It's optional, and the server never sees it.
- **Who's on a list** shows in *Add someone to this list*: you, the names people gave, and how many phones gave none.
- **Remove someone**, in the same place once someone else is on the list, gives the list a new key and closes the old one, for everyone: other phones say *List closed*, keep what they had, and offer to take it off the phone. Share the new link with those who should keep the list.
- **Delete for everyone** closes the list on the server and takes it off this phone. Other phones say *List closed*. It can't be undone.
- **Set up another phone**, in Settings, shows one QR code that brings every list on this phone to another.

## Sync and offline

- Changes show on the other phones within a second. What others add, rename, move, tick or untick is tinted briefly where it is, without anything moving.
- Only the list on screen listens. While Panier is out of sight, it stops listening, so it uses no network or battery in the background. Coming back, it catches up in a fraction of a second.
- Without a connection, the app keeps working. A pill at the bottom left shows *Offline*; tap it to see how many changes are waiting. They are sent when the connection returns. *Can't reach the server* means the phone is online but the server isn't answering.
- *List full* means the server has no room left for the list (32 MB, many years of use). Changes are kept on the phone.

## Settings

*Settings*, at the top of the lists page, opens a page of its own; the phone's back gesture closes it. Settings are chosen on each phone.

- **You:** your name, shown to the people you share lists with.
- **Appearance:** same as the phone, light or dark, and *Compact layout*: shorter rows (44 px instead of 52), smaller gaps and titles, and each list on one line on the lists page.
- **Data:**
  - Whether the browser keeps the lists even when the phone runs low on space. Panier asks for this when you start or join a list: Firefox asks you once, Chrome decides for itself. If they aren't kept, *Keep them on this phone* asks again.
  - How much space each list takes on this phone.
  - *Export all lists* and *Set up another phone*, above.
- **About:** the version, the server, and what the server can and can't see.

## Keyboard and screen readers

| Key | Does |
| --- | --- |
| Space | ticks or unticks the item |
| Enter or F2 | edits the item, or renames the section |
| Delete | deletes the item |
| Alt+↑, Alt+↓ | moves the item, into the next section at the ends; on a section's name, moves the section |
| Ctrl+Z, Ctrl+Shift+Z | undo, redo |

In suggestions, ↓ and ↑ choose one, → moves to its ×, Enter picks it and Shift+Delete removes it.

Changes are announced to screen readers. Light and dark follow the phone unless chosen in Settings, and reduced motion is respected. On the list, text, tick boxes and buttons keep WCAG AA contrast on every list and section colour, in both themes.

## Languages

Panier is in English and French, following the phone's language. The starting section names follow it too, until one is renamed: *Essentiels*, *À l’occasion*, *À long terme*, and the list is called *Liste de courses*. The words live in [`web/i18n.js`](../web/i18n.js); another language is one more table there.
