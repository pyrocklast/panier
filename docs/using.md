# Using Panier

Everything the app does, in detail. The [README](../README.md) has the short version.

## Starting

- **The first phone** opens the app's address and types the server's setup code (see [docs/cloudflare.md](cloudflare.md) or [docs/raspberry-pi.md](raspberry-pi.md) for where it comes from). The first list opens with its name to type.
- **Another phone** joins with *Add someone*, in the list's settings: it shows a QR code to scan, and buttons to share or copy the link.
- **Keep a copy of each list's link** in a password manager. It is the key to the list: it's the only way to get the list back if every phone is lost, and anyone who has it can open the list.
- **Install it** so it opens like an app, full screen and offline: in Firefox, **⋮ → Install** (or **Add to home screen**); in Chrome, **⋮ → Install app**; on an iPhone, Safari's **Share → Add to Home Screen**.
- **Opening a list's link** on a phone that has other lists adds it beside them, and opens it.

## Lists

A phone holds any number of lists, each shared with its own people. The app opens on the list last used.

- **Moving around:** the arrow at the top left of a page goes back up, one level at a time, as does the phone's back gesture: from a list's settings to the list, from a list or Settings to the lists page. *Settings*, at the top right, holds the settings of what's on screen: a list's on a list, the app's on the lists page. What you do every time, ticking and adding, is on the list itself; what you do now and then is a level further.
- **The lists page** is reached with the arrow at the top left of a list, or the phone's back gesture. The lists lie there side by side, two to a row, three on a wider screen, each a sheet of its own paper, lying on a desk a shade deeper: its name, who else has it, the first three things to tick, and how many there are, as this phone last saw them. Lists not on screen catch up as the page shows.
- **Open** a list with a tap. The page turns quietly into it: the desk takes the list's colour as the list's words open out of its sheet. Going back, with the arrow or the back gesture, they draw back into it.
- **New list:** type a name on the blank strip under the sheets; the new list opens ready to write on. The server makes it on the strength of a list this phone already has; if it won't, it asks for the setup code.
- **Move** a list: hold it, then drag it to its new place; the others glide aside. From a keyboard, Alt and an arrow move it one place earlier or later.
- **Delete** a list: drag it onto the zone that appears at the foot, press Delete on it from a keyboard, or use *Delete the list*, in the list's settings. It always asks first, and says what brings it back. *Delete from this phone* leaves it with the others: Undo, at the bottom right, brings it back until Panier closes, and its link after that. *Delete for everyone*, under it, asks again, then closes the list on the server: other phones say *List closed*, and neither Undo nor its link brings it back.
- **Settings**, at the top right of the lists page, are the app's, for this phone.

## The page

The list is written on the page itself, like paper: one left edge, ruled lines between items and under section names, and an underline where you type. Only what is lifted off the page has a shadow: something being dragged, the undo button, the sheets, which rise onto the page as it dims behind them.

- **The list's name** is the title at the top, between the arrow back and *Settings*. With large text, when they leave it too little room, it has a row of its own under them, so its words stay whole; the lists page does the same with its title. A new list is named as it's made, where its name goes; one without a name says *Untitled list*. It's renamed in the list's settings, and also names the exported file.
- **The list's colour** is chosen in its settings, under its name: white and eight hues. The paper is warm paper dyed with the colour, the ruled lines a deeper dye, the title a deep shade of it, and the writing leans its way. The browser's bars follow, and the app opens in the colour without a flash of white.
- **The eight colours weigh the same.** Each is a single hue, and every tone of it, from paper to tick box, is that hue at a lightness set by what it's for, so no colour shouts or fades beside another, in light or dark.
- Every phone sees the name and colour, and undo puts the old ones back.

## A list's settings

*Settings*, at the top right of a list, turns to a page of the list's own, on its paper. What's there is the same for everyone on the list. The arrow at its top left, Escape or the back gesture go back to the list.

- **Name and colour.** Emptying the name puts the old one back.
- **Ticked items stay in view** a day, a week, a month, or always: a week to start with. Nothing is deleted: older ticked items leave the ticked group but are still suggested as you type, and still exported.
- **People:** who's on the list, and *Add someone*.
- **Data:** the room the list takes on this phone, *Export the list* and *Delete the list*.

The share sheet and the question before deleting open over the settings, and close back onto them. A closed list's settings can only be read, but it can still be exported or deleted.

## Sections

A new list is a plain sheet: its items sit under its name, with no heading. *Add a section* adds headings when they help. The items already there stay first, under a heading of their own that quietly says *Untitled section*; tap it to name it. Once there are sections, nothing new goes outside one: when nothing is left to tick in the part without a name, it goes, and an item put back brings it back.

- **Rename** a section by tapping its heading. Every phone sees the new name. Emptying the name and leaving puts the old one back.
- **Fold** a section with the chevron at the end of its heading: it shows only its name, and under it what's left to tick, which a tap opens again. It folds on this phone only, and stays folded when the app opens again. Moving an item into it with the keyboard opens it, so the item stays in view.
- **Colour.** While you rename a section, its colours show under the name: ink and eight hues. A tap recolours it, the new colour spreading over it, as it does over the list's paper. Its name is written in a deep shade of the colour above a line of the colour, its tick boxes in the colour, its items in ink that leans a little towards it, and its *Add item* row in a deep shade (grey for ink, so it doesn't pass for an item).
- **Add a section** with *Add a section*, below the last one. It gets the first colour not used yet. Enter or `+` adds it, the cross clears what you typed, and the cursor then moves to its *Add item* row.
- **Delete** a section once nothing is left to tick in it: while you rename it, a cross appears. If the other phone adds an item to a section you deleted meanwhile, the section comes back with it.

## Adding items

- Every section ends with an *Add item* row. Tap it, or its `+`, and type. An item holds up to 300 characters, a few sentences.
- **Enter** or `+` adds the item and keeps the field open for the next one.
- **Leaving the field** adds what you typed, so nothing is lost, and what you tapped to leave stays where it is on screen. A notification or switching apps doesn't cut it short. Text left in the field when the app closes is added the next time it opens.
- **The cross** at the end of the row throws away what you typed, and the cursor stays in the field. Escape does the same from a keyboard, once any suggestions are closed.
- **Something already on the list** is highlighted instead of added twice. Typing the full name of something ticked before puts that item back, into the section you are typing in.
- **Quantities.** A number at the start, such as *2 milk*, *2× milk*, *500 g flour*, *1.5kg potatoes*, *2 litres of milk* or *3 paquets de pâtes*, is shown in bold, slightly apart from the name. It's left out when comparing names: *2 litres of milk* is still Milk, typing *3 milk* while it's on the list changes the quantity, and *mil* suggests Milk.
- A quantity is for this time only. The ticked group still shows it, so unticking a mistake puts the item back as it was, but a suggestion brings the item back without it.

## Suggestions

- From the second letter, items ticked before are suggested above the field, where the phone's keyboard can't hide them.
- Accents and capitals don't matter. Names that start with what you typed come first, then names with a word that does, then the most recently ticked. Five at most.
- **Tap a suggestion** to put the item back, with any quantity typed so far: *2 mil*, then Milk, gives *2 milk*. Enter only adds what you typed.
- **The × on a suggestion** removes that item for good, for typos such as *Mlik*. Undo brings it back.

## Ticking

- **Tap the square** to tick an item: it fills with its section's colour, and the words are struck through, as with a pen. A short vibration confirms it in Chrome and Samsung Internet on Android. Firefox and Safari don't let web pages vibrate.
- Ticked items stay in place, greyed out, for 1.5 seconds. Each new tick restarts the wait, so several items ticked in a row leave together and the list doesn't move under your thumb.
- They then rise off the page, travel to **the ticked group**, taking the size of its smaller rows on the way, and settle into the page there. It lies below the sections, after a dashed tear line. Its boxes fill with the colours of what's been ticked. It shows what was ticked lately, latest first, so you can check what was done: for a week, unless the list's settings say a day, a month, or always. Its heading, such as *3 ticked*, folds it away.
- **Beside each ticked item**, who ticked it and when: *Isabelle, at 12:45*, *Me, yesterday*, then the day of the week, then the date. Someone who hasn't given a name shows as just the time, and so does everything on a list only on your phone. The time follows the phone's clock, 12 or 24 hours, and screen readers read it after the item's name.
- **Untick** an item by tapping its square: it goes back to the end of its section, or of the first section if its own was deleted. Undo ticks it again, still showing who ticked it and when.
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
- While you drag, what's in the way glides aside. What you let go of glides into its place and settles into the page, and anything else that moves after a change glides too, without getting in the way of a tap. What you add stays where you typed it, and what you delete fades where it was.

## Undo and redo

- Every change to a list's items and sections can be undone, and so can a list taken off the phone; the list's other settings and your name can't. The undo button appears at the bottom right after the first change, and hides while you type. Redo joins it once something has been undone.
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

`#` is the list's name, `##` each section in order, `- [ ]` an item to tick, `- [x]` one ticked before, under its section. Items before the first `##` are those without a heading. Colours ride in comments after the headings, which notes apps hide.

- **Export the list**, in the list's settings, saves it as a `.md` file named after it.
- **Export all lists**, in Settings, saves every list in one file, each under its own `#`.
- **Bring in from a file**, in Settings, brings in a list, or several from one file, onto the lists page. It reads any Markdown checklist: other bullets, numbered lines, headings of any level, plain lines, where a line followed by items names a section. Items ticked before come in as suggestions, not in the ticked group.
- **From Google Keep:** in [Google Takeout](https://takeout.google.com), choose only Keep and export, then pick the `.zip` it gives with *Bring in from a file*, or the `.json` files inside it. Panier lists the checklists it finds, last edited first, each as its sheet will show; all are ticked to come in but archived ones. Each becomes a list with the note's title and colour, its items in one section, ticked as they were. Text notes and notes in the bin stay behind. Everything is read on the phone.
- **Pasting several lines** into *Add item* adds one item per line, in that section, in one step to undo. Names already on the list are left as they are.

## People

- **Your name** shows to the people you share lists with. It's optional, and the server never sees it. The share sheet asks for it until you've given one; Settings changes it.
- **Who's on a list** shows in its settings and on the share sheet: you, the names people gave, and how many phones gave none. On the lists page, a few quiet words under a list's name say who else has it. Everyone on a list sees who ticked what.
- **Remove someone**, on the share sheet once someone else is on the list, gives the list a new key and closes the old one, for everyone: other phones say *List closed* and keep what they had, until they delete it. Share the new link with those who should keep the list.
- **A closed list is only read**: nothing can be added, edited, moved or ticked, since none of it could be sent, and its boxes show faint. *Export the list* still saves a copy. So does a list changed with a newer Panier, until this one updates.
- **Set up another phone**, in Settings, shows one QR code that brings every list on this phone to another; closing it goes back to Settings.

## Sync and offline

- Changes show on the other phones within a second. What others add, rename, move, tick or untick is tinted briefly where it is, without anything moving.
- Only the list on screen listens. While Panier is out of sight, it stops listening, so it uses no network or battery in the background. Coming back, it catches up in a fraction of a second.
- Without a connection, the app keeps working. A pill at the bottom left shows *Offline*; tap it to see how many changes are waiting. They are sent when the connection returns. *Can't reach the server* means the phone is online but the server isn't answering.
- *List full* means the server has no room left for the list (32 MB, many years of use). Changes are kept on the phone.
- *Phone storage full* means the browser has no room left on this phone to save the lists. Changes still reach the server while online, but those made offline are lost if the app closes. Settings shows the room each list takes; deleting one frees it, and what was waiting is saved then.

## Sideways and on wider screens

On a phone turned on its side, or a tablet or computer, the page uses the width:

- **A list** lies in one wider column, and what's ticked lies beside it, torn off to the side, in view as you scroll. A ticked item crosses over to it, and an item dragged across is ticked.
- **The lists page** has as many sheets to a row as fit.
- **Settings**, and a list's, put each part's heading on the left, beside what it holds.
- **A phone on its side** keeps the layout chosen in Settings: the compact one fits more in its height. The share sheet puts its code beside its words, so it fits.

## Settings

*Settings*, at the top right of the lists page, opens a page of its own; the arrow at its top left, Escape or the phone's back gesture close it. Settings are chosen on each phone. Here and in a list's settings, what's done now and then is a ruled row, as on a list, with a quiet line saying what it does.

- **You:** your name, shown to the people you share lists with.
- **Appearance:** same as the phone, light or dark, and *Compact layout*: shorter rows (44 px instead of 52), smaller gaps and titles, and only each list's name and count on the lists page.
- **Data:**
  - One line: how many lists there are, the room they take on this phone, and whether the browser keeps them even when the phone runs low on space. Panier asks for this when you start or join a list: Firefox asks you once, Chrome decides for itself. If they aren't kept, *Keep lists on this phone* asks again.
  - *Export all lists*, *Bring in from a file* and *Set up another phone*, above.
- **About:** the version, the server, and what the server can and can't see.

## Motion

Panier is paper, and what moves says where it happens:

- **On the page**, what's written fades in or out where it is: an item added or deleted, a box filling, the pen stroke, suggestions, colours under a name, what others change, tinted a moment.
- **Along the page**, rows and sections glide to their new places, the ticked group folds and unfolds, and what's in the way glides aside during a drag.
- **Off the page**, what you hold lifts, with a shadow; a ticked item travels to the ticked group and settles there, who ticked it fading in on the way.
- **On top**, the sheets, undo and the connection's status rise into place, and sink or fade away, quicker, as they go.
- **The page itself** turns, between the lists page, a list and their settings, out of what you tapped and back into it, and takes a new colour.

Each takes 0.15 s to give feedback, 0.24 s to arrive or 0.32 s to move, a little longer for a long trip. When the phone asks for reduced motion, nothing moves.

## Keyboard and screen readers

| Key | Does |
| --- | --- |
| Space | ticks or unticks the item |
| Enter or F2 | edits the item, or renames the section |
| Delete | deletes the item |
| Alt+↑, Alt+↓ | moves the item, into the next section at the ends; on a section's name, moves the section |
| Ctrl+Z, Ctrl+Shift+Z | undo, redo |

In suggestions, ↓ and ↑ choose one, → moves to its ×, Enter picks it and Shift+Delete removes it.

On the lists page, Alt and an arrow move a list, and Delete deletes it, once asked.

Changes are announced to screen readers. Text keeps WCAG AAA contrast, 7:1, and tick boxes and buttons at least AA, on every list and section colour, in both themes, on every screen.

## Languages

Panier is in English and French, following the phone's language. The words live in [`web/i18n.js`](../web/i18n.js); another language is one more table there.
