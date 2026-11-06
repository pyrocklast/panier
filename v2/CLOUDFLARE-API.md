# Panier v2 isolated Cloudflare Worker API sandbox

**Draft/prototype only. This is not an application deployment or a release
candidate.** Uses `wrangler.v2.jsonc`, not the production `wrangler.jsonc`.
The existing `worker/index.js` and v1 endpoints remain untouched.

## Run locally

```sh
npx --yes wrangler@4.151.2 dev --config wrangler.v2.jsonc --ip 127.0.0.1 --port 8799
V2_BASE=http://127.0.0.1:8799 node --test test/v2-worker-api.test.mjs
```

The config allocates a **different** SQLite-backed Durable Object class
`V2List`, namespace `V2_LISTS`, and worker name
`panier-v2-protocol-sandbox`. No production secret, domain, or deployment
permission is needed for the local tests.

## Isolated routes

Every endpoint is `POST /v2/lists/:listId/:action`; JSON request and
response; no cross-origin browser integration is enabled.

| Action | Authentication | Scope |
|---|---|---|
| `bootstrap` | Locally generated owner-signed genesis (self-signed first-write) | Create initial owner ledger; exact signed-byte retry is idempotent |
| `invitations` | Signed owner device request + signed invitation | Register physical-QR invitation |
| `redeem` | QR-derived token + recipient signing/ECDH binding | Atomically enroll one member; the same active device can recover a lost response without enrolling again |
| `history` | Signed active member request | Fetch owner-signed membership events |
| `rotate` | Signed owner request + signed rotation | Atomically publish epoch and encrypted packages |
| `key-package` | Signed active member request | Retrieve own current encrypted key |
| `rekey-receipt` | Signed active recipient request + inner receipt signature | Store recipient receipt for exact new-epoch ciphertext (NOT owner-confirmed) |
| `rekey-receipts` | Signed owner request | Fetch member-signed receipts for local secret-derived HMAC verification |
| `mutations` | Signed active member request + signed mutation envelope | Append ciphertext with idempotent mutation ID and epoch fence |
| `pull` | Signed active member request | Fetch ordered encrypted mutation log |

The wire protocol for signed HTTP requests is in `v2/api-auth.mjs`.
Requests bind list ID, member ID, method, exact path, SHA-256 of JSON request
body, 128-bit random nonce and issued-at timestamp (±120 seconds) into
ECDSA P-256 signature. The Durable Object reads current membership,
verifies the registered signing public key, and consumes the nonce in
six rotating minute slots per member. Replaying the same signed request
is rejected within its timestamp validity window. List/member/unsigned
claim budgets and the five-active-QR limit are experimental and enforced
in the isolated DO; see `v2/BOUNDED-API.md`.

Mutation uploads additionally verify the immutable, client-signed
versioned ciphertext envelope (including actor, list, ID and epoch).
Accepted revisions are allocated in a Durable Object transaction after
checking the current membership epoch and active status. A duplicate
mutation ID with identical signed bytes returns its original revision.
The server stores opaque ciphertext only; clients MUST still decrypt and
verify accepted revisions before acknowledging their outbox.

## Security limitations that remain

1. **Genesis first-write attack:** a signed genesis is not independently
   authenticated by the Cloudflare service. Clients MUST pin the owner's
   authentic genesis public key through a reviewed trusted bootstrap flow;
   otherwise a malicious server can install its own list identity.
2. **Server freshness/equivocation:** signed membership history can be
   withheld, replayed, or forked. Clients need verified pinned-head
   checkpoints and a consistency policy before production.
3. **Nonce retention and abuse:** a bounded nonce ring and per-list/request
   quotas now exist, but **global** edge controls against random new list IDs,
   abuse monitoring, storage retention and cost protection do not. These
   local budgets are not a production denial-of-service perimeter.
4. **Unfinished end-to-end protocol:** member-signed rekey receipts are now
   stored durably but Cloudflare cannot verify the secret-derived HMAC.
   Only the owner can determine successful key delivery. Same-device QR
   redemption retry after lost HTTP response is supported, but owner
   recovery/transfer, invalid signed receipt replacement, offline conflict
   rebase, encrypted snapshots, multi-rotation key history and client UI
   remain unresolved.
5. **Cloudflare API hardening:** HTTP authorization is preliminary. It
   requires security review, body/ciphertext size and operation volume
   quotas, authentication challenge/clock drift policy, canonical test
   vectors, bounded JSON parsing and reliable handling of partial failures.
6. **Availability and local threats:** Cloudflare can suppress changes or
   deny service. Same-origin scripts can still read plaintext optimistic
   client state and manipulate calls. A photographed QR reveals the
   current epoch secret independently of one-time membership enrollment.
7. **No secret transport:** raw list encryption keys are never sent to the
   server. Signing proof or public keys are not a substitute for the owner's
   independent authorization.

The app currently remains unchanged. There is no production routing to this
Worker. Do **not** deploy it merely because local-runtime and CI tests pass.
Independent protocol review of draft PR #12 and successors remains required.
