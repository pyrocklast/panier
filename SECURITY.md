# Security

## Reporting a problem

Report security problems privately through GitHub: open this repository's **Security** tab and choose **Report a vulnerability**. Please don't open a public issue.

## What Panier protects

- **The contents of the lists.** Item names, sections, their order, whether they're ticked, the list's name and the names people give themselves are encrypted on the phone before they're sent. The server, whoever runs it, and anyone watching the network see only encrypted data.
- **Integrity.** Each change is authenticated and bound to its list. A change that was altered, or written without the key, fails to decrypt and is ignored.

## What it doesn't protect

- **Metadata.** The server sees when changes are made, how many, which IP addresses connect, and approximate sizes (changes are padded to 256-byte blocks). It also sees which list vouched for the creation of which, and when a list is closed.
- **Availability.** Whoever controls the server can withhold or delay changes, or delete a list. On Cloudflare, that includes Cloudflare itself. Replaying old changes has no effect. They cannot read or forge changes.
- **The app's code.** Phones load the app from the server, so whoever controls it could serve a modified app that leaks the key: on Cloudflare, that means Cloudflare, or anyone who gets into the Cloudflare or GitHub account that deploys it. Turn on two-factor authentication on both. Running your own server removes Cloudflare from that list.
- **A list's link.** It is the key: anyone who has it can read and change the list, and close it. It doesn't expire. To cut someone off, *Change the key*: the list is copied under a new key, the old one is closed on the server, and only those given the new link have the list from then on. Someone cut off keeps what their phone already had.
- **Names.** Each phone names itself; nothing proves a name. The share sheet counts every phone on the list, named or not.
- **The phones.** The key is kept in the browser's storage on each phone. Use a screen lock.
- **Loss.** If every phone and every copy of the link are lost, nobody can decrypt the list, including you.

## Design

- **Keys.** The first phone generates a random 256-bit key. HKDF-SHA-256 (empty salt, a distinct `info` string for each) derives the list id (128 bits), an access token (256 bits) and an AES-256-GCM key from it. The pairing link carries the key in the URL fragment (`#k=…`), which browsers don't send to servers, and the app removes it from the address bar and history as soon as it loads.
- **Encryption.** Each change is JSON, padded with spaces to a multiple of 256 bytes, encrypted with AES-256-GCM under a fresh random 96-bit nonce, with the list id as additional authenticated data. Random nonces are safe for far more changes than a shopping list will ever make.
- **Access.** The server stores only the SHA-256 hash of the access token and compares tokens in constant time. The token travels in the `Authorization` header, or, for the live-update WebSocket, as a subprotocol, since browsers can't set headers on WebSockets. Creating a list needs the setup code (generated on the Go server's first run, or set as a secret on Cloudflare), or the token of a list already on the server, which vouches for it; wrong codes and tokens are answered after a one-second delay. A list made by vouching joins the family of the list created with the setup code that it descends from, and a family holds 100 lists at most, so a leaked link can't fill the server.
- **Closing.** Anyone with a list's token can close it: the server deletes its changes, refuses everything for that list from then on, and tells phones listening. The list's id stays taken.
- **Merging.** Each field keeps the write with the highest (logical time, device id). A duplicated or replayed change can't overwrite a newer value, and a phone with a wrong clock can't freeze a field, because each phone's logical time moves past any time it has seen.
- **Server limits.** The same on both servers: 256 KiB per request, 16 KiB per change, 200 changes per request, 32 MiB per list, 16 live connections per list, 100 lists per family. A large change, such as an import, is sent as several, each under the limit. Changes are saved all or nothing: on Cloudflare in a single SQLite transaction; on the Go server, a failed disk write is cut back off the log. Either way, what's stored always matches what phones have been told.
- **Browser.** A strict Content Security Policy allows only the app's own scripts, styles, fonts and connections. There are no third-party scripts, fonts or trackers. The service worker caches the app's files, never list data.
