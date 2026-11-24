# Roadmap

What's planned, and why. Anything that changes how lists are stored or shared gets a short design note, agreed before it's built (CLAUDE.md, *How to work*): each entry says what that note must settle.

## Snapshots of a list's history

**Status:** planned, not started. Nobody feels it yet; it's worth doing before lists are a few years old.

**Why.** The server keeps every change made to a list, since it can't read them to merge them. Each takes about 380 bytes: padded to 256 bytes, so the server can't tell a tick from an added item, then encrypted. A year of shopping on a list of 100 items, with 25 ticked and put back each week, adds about 1 MB. The phone's own copy stays about 20 KB.

Space isn't the problem: the server's limit of 32 MB a list would take decades to reach, and Cloudflare's storage is free at this size. Joining is. A new phone downloads and replays the whole history: with a year of it, the list showed after 8.7 seconds on a slow phone, against 0.4 seconds on a computer, and that keeps growing.

**The idea.** Now and then, a phone sends the server an encrypted copy of the whole list, and the server drops the changes before it. A new phone then downloads that copy, about 20 KB for 100 items, and the changes since, however old the list is. The server still reads nothing.

**What the design note must settle**
- **When:** every so many changes or bytes, and which phone makes the copy, so two don't race.
- **The swap on the server:** in one step, keeping changes that arrive meanwhile, the same on both servers.
- **A phone offline since before the copy:** it merges the copy as it merges changes, field by field, the latest winning.
- **Deleted items:** the copy keeps them as long as phones do, about six months, so a phone that was offline can't bring them back.
- **Its size:** padded like a change, so it says no more than the history does today: roughly how much the list holds.
- **Older apps:** one that doesn't know copies must say *Update Panier to open it* rather than misread the list, as for any newer format.
- **Tests:** a new phone joining after a copy; a phone offline across one; two phones making one at once.

## Warning about where a link is sent

**Status:** planned, not started. Nothing stored or shared changes, so it needs no design note: the words are chosen on real screens.

**Why.** A list's link is its key, and it never expires. The share sheet says anyone who has it can open the list, but not how it gets out. Sent by email, text message or a chat app that isn't end-to-end encrypted, it can be read by the service that carries it, and it stays in the conversation, and the account, as long as they're kept. A copied link can also linger in a keyboard's clipboard history, or reach other devices through a shared clipboard. The link from *Set up another phone* holds the keys to every list.

**The idea.** One quiet line on the share sheet, where the link is shared or copied: showing the code is safest; otherwise, send the link in an app that encrypts end to end, such as Signal, and delete the message once it's been opened. Nothing to dismiss and no extra step: it's said once, where the choice is made.

**What to settle**
- **The words:** merged with the note already there rather than added as a second, in English and French.
- **The link to every list:** whether *Set up another phone* shows the link at all, since both phones are usually side by side. The code can't hold dozens of lists, though, and a computer may have no camera to scan it.
- **Once it's out:** whether the line points to *Remove someone*, which gives the list a new key.
- **The guides:** SECURITY.md, under *A list's link*, and docs/using.md, under *Starting*.

## Items under items

**Status:** a big maybe, set aside for later. The design note below keeps what's been decided; it isn't agreed, and nothing is built. If it's picked up, the note is agreed first, then the parts marked *on screen* are tried in two or three directions, side by side.

**Why.** Some lists have items with parts: a recipe and its ingredients, a room and its jobs, a bag and what goes in it. Sections group items, but across the whole list, and one level only. Markdown checklists indent items under others; today Panier flattens them as they come in.

**Decided.** One level. An item can't be ticked while anything under it is left to tick, and once nothing is, it waits for its own tap. What's under it stays under it once ticked, struck through, and goes to the ticked group with it. The same name can sit under two items. Deleting an item deletes what's under it.

**Storing it.** One new field on an item, `under`: the id of the item it's under, or nothing. It's merged like every other field, the latest write winning. Among the items under the same one, `pos` orders them, as it orders items in a section. An item under another is always in that one's section: moving the item above, or its section, takes them along without writing to each. Going under, an item also writes that section as its own, for the rule below.

**One level, whatever happens.** An item shows under another only if that one is on the list and under nothing itself. Two phones can put two items each under the other at once, or one can delete an item as the other puts something under it: the items concerned then sit at their own place in their own section. Every phone reaches the same view on its own, and nothing is lost.

**Ticking**
- An item with something left to tick under it can't be ticked. Its box says so (*on screen*), and a screen reader hears how many are left, such as *2 of 3 left*.
- Ticked, an item under another stays where it is, struck through, as long as the one above is on the list. Once all are ticked, the box above opens.
- Ticking it, by tap or by dragging it to the ticked group, sends it and all under it there together, after the usual 1.5 seconds. There they stay under it, latest first by when it was ticked, and leave the group with it.
- Unticking an item under a ticked one puts both back on the list, in one step to undo. Unticking the one above puts it back with what's under it, still ticked.
- A ticked item with something unticked under it, which only two phones acting at once can make, shows unticked until that's ticked too.
- Who ticked each, and when, shows beside it, as now.

**The same name twice.** Today's rules apply among the items under the same item, and among the items under none: a name already there is highlighted rather than added, and typing a name ticked before brings it back where it's typed, the latest ticked of that name. *Eggs* under Pancakes and *Eggs* under Omelette are two items. Suggestions show each name once.

**Deleting.** Deleting an item deletes what's under it, in one step to undo. Deleting an item under another deletes just that one, as now.

**Moving in and out**
- **Dragging:** an item let go about a box's width right of the item above goes under it; let go further left, it comes out. An item with items under it carries them, and can't go under another.
- **Keyboard:** Alt+→ puts the item under the one above; Alt+← brings it out, just after its item. Alt+↑ and Alt+↓ move it among the items under the same one, and out of it at either end.
- **Without dragging or a keyboard** (*on screen*): another way in and out, for a screen reader on a phone, or anyone who can't drag, such as two buttons while the item is edited.
- **Adding straight under an item** (*on screen*), rather than adding then moving each one: for instance a quiet *Add item* row at the end of what's under an item, or the section's *Add item* row moved under its last item.
- **Splitting and joining:** Enter splits an item into two under the same item, and what's under it stays with the first part. Backspace at the start joins an item onto the one above at its own level; one with items under it doesn't join.
- Each move in or out is one step to undo.

**Showing it**
- What's under an item is indented by about a box's width, its ruled lines starting there, at every text size and in both layouts (*on screen*).
- It's a list inside the item's row, so screen readers say its level, as for any list within a list.
- A folded section's line, and the first three things on a list's sheet, name only items under nothing. The count, such as *5 to tick*, counts every item left to tick.

**Coming in and going out.** Export writes what's under an item indented by two spaces: `  - [ ] Eggs`. Import and pasting put an indented line under the line above it, and deeper indents at the same one level. Google Keep's indents come in too, if Takeout keeps them: to check with a real export.

**Older apps.** They take in fields they don't know as they are, so an older Panier shows items under others as ordinary items in their section until it updates. So the list's format doesn't change, and no list is shut to an older app. An item it ticks before what's under it shows unticked, by the rule above.

**Tests**
- Putting an item under another and back, by drag and by keyboard, with undo.
- Ticking: the box above opens only once all under it are ticked; they go to the ticked group together, and come back together.
- Two phones each putting one item under the other at once; one deleting an item as the other puts something under it; one ticking an item as the other adds under it.
- The same name under two items, and a name ticked before coming back where it's typed.
- Markdown out and back in, and pasting indented lines.

## Colour in a folded section's line

**Status:** planned, not started, and only if it keeps the contrast. Nothing stored changes, so it needs no design note.

**Why.** Folded, a section shows what's left in it on one line under its name. That line is in the list's quiet tone, the same in every section, though unfolded the same items are written in ink that leans to their section's colour. In its section's colour, the line would read as that section's items, as they do unfolded.

**The idea.** Write the line in a tone of its section's colour, at the 7:1 (WCAG AAA) contrast all text keeps, at its smaller size, on every paper, in light and dark. If no tone reaches it on every one, the line stays as it is.

**What to settle**
- **Which tone:** the items' own ink, leaning to the section, since these are its items, or a quiet tone of its colour; not the deep tone of its name, which marks a heading.
- **Measuring it:** each of the nine section colours on each of the nine papers, in both themes, worked out rather than judged by eye, in both layouts. A test could keep it so: nothing checks contrast automatically today.
