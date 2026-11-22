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
