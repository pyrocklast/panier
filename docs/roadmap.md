# Roadmap: several lists, import, more people

The design note for Panier's next version, agreed before building, as the README asks for bigger features. It is built on the `next` branch, which deploys a test copy of its own (see [Testing](#testing)); `main` and the Panier in use change only when `next` is merged.

## Principles

- **A list stays the only unit.** No accounts, no groups, no record of people on the server. A phone holds a set of list keys; everything else lives inside the encrypted list or only on the phone.
- **One list with two people shops exactly as today.** The list gains one control in its header and gives Settings to the lists page. Everything else appears only when needed.
- **Small, plain and fast.** No framework, no build step, no new dependency. The server gains two small additions in total.

## What changes

| Feature | On the phone | On the server |
| --- | --- | --- |
| Several lists | an index of lists and one storage entry per list; the lists page | creating a list by vouching with another |
| Import and export | Markdown, in and out; pasting several lines | nothing |
| More people | wording, names, who is on a list, one link for several lists | nothing |
| Removing someone | changing a list's key; deleting a list for everyone | closing a list |

### A clean start

No stored data is carried over. The phone uses new storage names and the Worker a new Durable Object class, so old and new lists never meet; code that read earlier versions is gone. Lists come back by importing their exports. Links saved before the switch open nothing.

From now on, stored data only gains new kinds of record, under `@`, which older apps pass over. A list can also state the lowest app format able to open it, so an older app says *Update Panier to open this list* instead of misreading it.

### Several lists

The lists page is the surface the lists lie on, side by side, each list a small sheet of its own paper, with its name, who else has it, the first three things left to get, and how many there are. Lists are deleted only there, and only once asked. It is reached from the *Lists* control at the right of a list's header, or the back gesture, and it holds Settings. The app opens on the last list used.

Only the list on screen keeps a live connection. The others catch up when the lists page shows, and send what they have waiting when the connection returns.

A phone that holds a list on a server may create more lists there, proving it with that list's token. The first list on a server still needs the setup code. Lists made this way share one budget with the list that started them (100), so a leaked link can't fill the server.

### Markdown

```markdown
# Shopping list <!-- green -->

## Essentials <!-- ink -->
- [ ] 2 milk
- [x] Eggs

## Look out for <!-- amber -->
- [ ] Ripe avocados
```

`#` is the list's name, `##` each section in order, `- [ ]` an item to get, `- [x]` one bought before, kept under its section so unticking puts it back there. Colours ride in comments after the headings, which Markdown hides: they work for several lists in one file, which a block at the top couldn't. *Export all lists* writes one file with a `#` per list. The reader also takes any Markdown checklist, plain lines, and the `.txt` files the earlier *Export the list* wrote. Pasting several lines into *Add item* adds one item per line.

### More people

Each phone can give itself a name, in Settings, written inside each of its lists. The share sheet shows who is on the list, counting phones without a name. One link can carry several lists, to set up another phone in one scan.

### Removing someone

The link is the key, so removing someone means giving the list a new one: *Remove someone* copies the list to a new one, closes the old one on the server, and shows the new link for the others. A closed list refuses everything; phones still holding it say so. *Delete for everyone* closes it without a copy. A removed person keeps what their phone already had.

## Phases

Each phase ends at a gate that proves it done.

1. **Groundwork.** Storage for several lists, the format guard, changes split to fit the server, a snapshot of a whole list. *Gate: every existing test passes on the new storage.*
2. **Several lists.** *Gate: one list shops as today, and two lists sync independently.*
3. **Import.** *Gate: every export imports back as the same sections and items.* The Panier in use can switch here.
4. **More people.** *Gate: three phones edit offline and end up identical.*
5. **Removing someone.** *Gate: a removed phone can no longer read or write the list.*

## Testing

The `next` branch deploys to `panier-next`, a Worker of its own on the same `workers.dev` subdomain, with lists of its own, named *Panier next* with an amber icon, so it installs beside Panier. It uses the same setup code.

## Switching over

1. Pass the import gate in the test copy, with every export restored there.
2. Merge `next` into `main`. Each phone opens on an empty lists page.
3. One person imports each export, then shares each list with the others. Save the new links.
4. Once every list is back, a Wrangler migration deletes the old Durable Object class and its data. Until then, reverting the merge brings the old Panier back as it was.
