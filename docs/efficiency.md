# Efficiency

Panier should cost as little as it can: in the person's time and battery, in the phone's storage, and in what the server costs to run. This guide says how that's measured, what each number may be, and the steps to bring it down. Follow it after a batch of changes, before a release, or when a number creeps up.

## The measures

`test/efficiency.mjs` measures everything below the same way each time. Times are taken on a **slow phone**: four times slower than the computer running it, on a slow 4G connection (150 ms each way, 1.6 Mbit/s down, 750 kbit/s up). The **long list** has 300 items to tick in six sections, and 1,000 ticked items kept in view.

| CLAUDE.md asks | Measured | Budget |
| --- | --- | --- |
| **Light on hardware:** what does it do when nobody is looking? | On a list, on screen and untouched: requests, timers and frames, and time spent running, a minute | No requests; 30 timers and frames; 100 ms |
| | The same, put away | Nothing at all; 10 ms |
| **Light on hardware:** does it fetch only for a reason? | The app's files, gzipped: what each update downloads | 100 KB (85 KB with Brotli) |
| | Fonts, icons and the QR code library, kept across updates | 75 KB |
| | Everything a first visit downloads | 300 KB |
| | Opening the app again | The API only |
| **Light on the person:** how much waiting? | From the setup link to naming the first list | 3 s |
| | Opening the app on the long list | 1.5 s, with at most 3 tasks over 50 ms |
| | Ticking, and adding an item, on the long list: from the tap to the next frame | 150 ms each |
| **Low cost:** what will it cost in a year? | What one tick sends | 2 KB |
| | Opening the lists page: requests | One a list |
| | The long list's storage on the phone | 400 KB |
| **Small:** could it be smaller and still work? | Lines of code in the app and each server | No budget: compare with the last run |

A phone feels a response within 200 ms as immediate, hence 150 ms on the slow phone. Over a budget, the report says so. It doesn't fail: a person judges.

## Running it

With Go and Playwright's Chromium (see the README's *Development*):

```sh
node test/efficiency.mjs
```

This builds the Go server from your copy, as a release would be, runs it, and measures it. It takes about five minutes, two of them waiting idle. It prints the report and leaves nothing behind.

- **Compare with an earlier run:** `OUT=before.json node test/efficiency.mjs`, then after your changes `BEFORE=before.json node test/efficiency.mjs`. Each number shows what it was beside it.
- **The Cloudflare server:** start it with `npx wrangler dev --var SETUP_CODE:TEST-CODE-1234`, then `BASE=http://127.0.0.1:8787 SETUP=TEST-CODE-1234 node test/efficiency.mjs`. Never point it at a server people use: it makes lists there. Run locally, it serves the app as a "dev" copy, which fetches its files afresh each time, so *Opening the app again* counts them: the report says so. The rest compares with the Go server.
- **Shorter:** `IDLE=10` waits 10 seconds instead of 60 on each idle measure. Those numbers are then rough: a single stray task counts six times over.

Sizes and counts are exact and compare from any computer. Times compare only between runs on the same computer, and vary by about a third from one run to the next: a time just over its budget is worth a second run.

## The procedure

1. **Measure first.** On `main`, save a run: `OUT=before.json`. Note what's over budget, and what grew since the last line of *Results* below.
2. **Find where it goes.** For each area over budget or growing, look where the table below points. Measure, don't guess: Chrome's *Performance* panel, with the CPU slowed four times, shows where the time goes on the long list. Start the profile at the tap.
3. **Choose by what people feel.** Waiting and battery first, then the server's costs, then bytes and lines. One change at a time, so each one's effect shows.
4. **Change it, then measure again** with `BEFORE=before.json`. Keep a change only if its number moved. Undo the ones that didn't, however neat.
5. **Test** as for any change: the browser tests on both servers and in both layouts, the API tests, and the update test if the service worker or caching changed.
6. **Prune:** whatever the change left unused goes too (CLAUDE.md, *How to work*).
7. **Write it down.** Add a line to *Results*. Change a budget only for a reason, written beside it.

## Where to look

| Area | Where it goes, and what to try |
| --- | --- |
| **The app's download** | Unused exports, functions and CSS rules. Code doing what another part already does. Comments describing what's gone. `vendor/qrcode.js` and the fonts download once and stay across updates; the app's files download again with every update (`sw.js`). |
| **First visit** | `sw.js` installs by fetching every file again, bypassing the browser's cache, after the page has already fetched them. |
| **Opening and waiting** | `list.js`'s `render()` draws every section and row; rows are kept between draws (`rowOf`), so only what changed is written. Before an animated change, `motion.js` measures every row (`snapshot`), then again after (`glide`). Ticked rows off screen aren't laid out (`content-visibility` in `app.css`). |
| **Nobody looking** | Anything repeating: `setInterval`, `setTimeout` that sets itself again, `requestAnimationFrame` loops, CSS animations left running. The live connection (`store.js`, `listen`) pings every 30 seconds while on screen. Cloudflare answers those without waking the list. Put away, it closes. |
| **Network** | `store.js` sends what's waiting 150 ms after the last change (`flushSoon`), in batches. The lists page catches up each list not on screen with a request of its own (`refreshAll`). |
| **Storage** | `store.js` keeps each list on the phone in full, deleted items for about six months so a late change can't bring them back. The servers keep every change, up to 32 MB a list. |
| **The server's cost** | Cloudflare charges for requests to the lists and the time they're awake. Each list is asleep between changes, and pings don't wake it (`worker/index.js`). |
| **Upkeep** | Dependencies: the app has one, the QR code library; the servers use their platform's standard library only. Code kept for the past: look for comments saying it can go once something has happened. |

## Known costs

What the first run found, to start from:

- **A first visit downloads the app twice:** once for the page, then again as the service worker fills its cache. That's about 135 KB more than needed, on a slow connection.
- **Every update downloads all the app's files,** about 88 KB gzipped, even those that didn't change.
- **Adding an item on a long list** takes about 120 ms on the slow phone, against about 60 to 100 ms for a tick. Adding animates the list, and measures every row before and after, ticked rows included.
- **The lists page** sends one request for each list. That's fine at eight lists, but it grows with every list.
- **A new phone joining downloads a list's whole history,** about 1 MB for a year of shopping. That showed the list after 8.7 seconds on the slow phone. Snapshots, on the [roadmap](roadmap.md), would fix it.

## Results

The Go server unless noted. Times are from the same computer as the line before, where they compare.

| Date | Commit | Update | First visit | Opening the long list | Tick | Add | Idle, on screen | Long list stored |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-11-21 | `7f55741` | 88.2 KB | 1.5 s, 272 KB | 0.9 s | 97 ms | 122 ms | 93 ms a minute | 283 KB |
