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

## Deleting a list nobody else has

**Status:** planned, not started.

**Why.** *Delete from this phone* leaves the list on the server, for the others. When there are none, it stays there for nobody: encrypted, but kept for good, and anyone who finds an old copy of its link can still open it. *Delete for everyone* would close it, but someone alone on a list has no reason to reach for it.

**The idea.** When no other phone is on the list, deleting it also closes it on the server, once Undo can no longer bring it back. The question then offers a single *Delete*, and says so: after that, its link won't bring it back, including a copy kept in a password manager, as the share sheet advises.

**What the design note must settle**
- **Who's alone:** the phones on the list, as this phone last heard from the server. One that joined meanwhile keeps it, so the list is checked once more just before it closes. Another phone of one's own, set up with *Set up another phone*, counts. A link sent but never opened can't be known: the question's words cover it.
- **When:** Undo brings the list back until Panier closes, so the server can't close it before then. Either the close waits on this phone and goes when Panier next opens, or the list closes at once and Undo makes it again under a new key, from what this phone holds, as *Remove someone* does; that spends one of the 100 lists its family may make.
- **Offline:** the close waits, survives the app closing, and goes when the server answers.
- **Tests:** deleting alone, then undoing; deleting alone offline, then reopening; another phone joining just before the close.

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

**Status:** planned, not started.

**Why.** Some lists have items with parts: a recipe and its ingredients, a room and its jobs, a bag and what goes in it. Sections group items, but across the whole list, and one level only. Markdown checklists indent items under others; today Panier flattens them as they come in.

**The idea.** An item can hold items, indented under it. Each stores the item it's under, merged field by field like its section and place, the latest winning. One level is likely enough, and simpler to show and to drag.

**What the design note must settle**
- **How deep:** one level, or more.
- **Conflicts:** two phones putting two items each under the other at once; an item put under one that's deleted, or moved to another section, meanwhile. It needs a rule each phone reaches alone, such as: an item whose own item is under another, deleted, or in another section sits at the top of its section.
- **Ticking:** whether ticking an item ticks what's under it, whether it ticks itself once they all are, and how they travel to the ticked group and back: together, or one by one.
- **Moving in and out:** dragging sideways; from a keyboard, Alt+→ and Alt+←, beside Alt+↑ and Alt+↓; Enter in an empty item under another, which brings it out, as in notes apps; splitting and joining with Enter and Backspace.
- **Deleting:** whether what's under an item goes with it, in one undo.
- **The same name twice:** *Eggs* under two recipes. Today a name already on the list is highlighted instead of added, and suggestions and merging go by name.
- **Showing it:** the indent, at every text size and in the compact layout; a folded section's line, and the first three items on the lists page; what a screen reader says of each item's level.
- **Coming in and going out:** indented Markdown checklists, and Google Keep's indents, if Takeout keeps them.
- **Older apps:** whether one that doesn't know them shows them flat, or says *Update Panier to open it*.
- **Tests:** two phones nesting at once; deleting an item as another goes under it; Markdown out and back in.

## Colour in a folded section's line

**Status:** planned, not started, and only if it keeps the contrast. Nothing stored changes, so it needs no design note.

**Why.** Folded, a section shows what's left in it on one line under its name. That line is in the list's quiet tone, the same in every section, though unfolded the same items are written in ink that leans to their section's colour. In its section's colour, the line would read as that section's items, as they do unfolded.

**The idea.** Write the line in a tone of its section's colour, at the 7:1 (WCAG AAA) contrast all text keeps, at its smaller size, on every paper, in light and dark. If no tone reaches it on every one, the line stays as it is.

**What to settle**
- **Which tone:** the items' own ink, leaning to the section, since these are its items, or a quiet tone of its colour; not the deep tone of its name, which marks a heading.
- **Measuring it:** each of the nine section colours on each of the nine papers, in both themes, worked out rather than judged by eye, in both layouts. A test could keep it so: nothing checks contrast automatically today.
