# Panier v2 — bounded API replay and abuse controls

**Status:** isolated Cloudflare Durable Object sandbox, not a production
security perimeter. Stacked on draft PR #28; no production Worker or
Wrangler changes. Independent abuse and E2EE security review required.

## Signed-request replay protection

The earlier API stored one permanent durable record per signed request nonce.
That storage grew indefinitely, even though signatures are only valid for a
two-minute window around the timestamp.

`v2/do-quotas.mjs` replaces that scheme with a **six-slot rotating
ring of minute buckets per registered member**. The signed-request timestamp
determines the nonce slot; the server checks its existing ±120-second
acceptance window before writing. The six-minute reuse gap is longer than
the entire lifetime during which any one signed timestamp can be valid,
so overwriting an older slot cannot revive an otherwise valid replay.

All duplicate checks, bucket writes and rate checks execute within the
same DO storage transaction after verifying the member's signature,
membership status and role. The signed request still binds method, path,
list ID, member, body hash and random 128-bit nonce.

The fixed slots avoid one permanent storage key per request. They do
**not** bound the number of retained member identities: the signed member
history itself still grows, subject to earlier limits.

## List-scoped budgets

Experimental limits, deliberately conservative and reviewable:

- **60** signed requests per active member per wall-clock minute;
- **600** signed requests total per list per minute;
- **30** unsigned bootstrap attempts and **30** QR redemption attempts
  per list per minute (counted separately);
- **5** simultaneously unexpired QR invitations per list.

The active-invitation index is maintained transactionally with issuance,
redemption and cancellation. Expired invitations release their active slot
on the next owner issuance. These limits are **not user identity or
network-wide rate limits**.

A rate limit is reported as HTTP 429 by the isolated API, and a valid
cryptographic replay is still rejected. Client sync must handle 429 by
backoff with a **fresh signed request and nonce** rather than retrying an
identical signed API envelope.

## Critical limitations

- Attackers can create unlimited random list IDs and thus new DO namespaces.
  A per-list budget cannot prevent this. **Cloudflare edge/WAF rate limits,
  bot controls and cost monitoring must be designed before deployment.**
- Malformed unsigned redemption requests still consume a small transaction
  and cannot be globally IP-limited without an external network layer.
- Historical signed membership events and used/expired QR records may still
  grow. Deletion/compaction requires a protocol that preserves cryptographic
  membership proofs, auditability and revocation history; this PR does NOT
  silently prune history or erase single-use evidence.
- Authenticated list members can intentionally exhaust the list's shared
  request budget. The app needs appropriate UX for throttling and fairness.
- Old ECDSA signing keys, browser compromise, nonce clock skew, server
  rollback/fork attacks, owner recovery and offline rebasing remain open
  security gates, and neither an authenticated API nor rate limits makes
  this E2EE protocol ready for real user data.
- The quotas are per Durable Object and use its internal clock; there is
  no external service clock or proof of cross-region freshness.

## Tests

`node --test test/v2-do-quotas.test.mjs` exercises bounded replay slots,
concurrent attempt races, per-minute limits, expiration and deterministic
mock-clock advancement.

The existing real-Wrangler integration suite now tests that five outstanding
QR invitations permit no sixth until one is consumed, and that 60
member-signed requests are accepted while the next is throttled.

All changes remain stacked draft prototypes with no production deployment.
