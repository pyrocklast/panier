# Running Panier on Cloudflare

Panier can run on Cloudflare Workers' free plan, with nothing to install or keep running yourself. GitHub deploys it each time `main` changes, after the tests pass.

The free plan allows 100,000 requests and 13,000 GB-s of server time a day; a shopping list for two uses a small fraction of that. Lists stay end-to-end encrypted: Cloudflare stores only encrypted changes. [SECURITY.md](../SECURITY.md) explains what Cloudflare can and can't see.

Allow about 20 minutes.

## 1. Cloudflare

1. Create a free account at [cloudflare.com](https://dash.cloudflare.com/sign-up).
2. Open **Workers & Pages**. The first time, Cloudflare asks you to choose a `workers.dev` subdomain. Your app's address will be `https://panier.<subdomain>.workers.dev`, so choose something that doesn't identify you if that matters to you.
3. Create an access token for GitHub. It lets GitHub deploy Panier and nothing outside Workers; treat it like a password.
   1. Click the profile icon at the top right, then **My Profile → API Tokens → Create Token**.
   2. Next to **Edit Cloudflare Workers**, click **Use template**.
   3. Click the pencil next to the token name and call it something like `Panier deploy`.
   4. Leave **Permissions** as the template set them.
   5. **Account Resources:** *Include* → your account.
   6. **Zone Resources:** *Include* → *All zones from an account* → your account. With no domain on Cloudflare this does nothing yet; it's ready for when you add one.
   7. Leave **Client IP Address Filtering** empty, since GitHub deploys from changing addresses, and **TTL** empty, so deploys don't stop working when the token expires.
   8. **Continue to summary → Create Token.** Copy the token straight into the GitHub secret in step 3 below. Cloudflare shows it only once; if you lose it, **Roll** it on the API Tokens page for a new one, or **Delete** it to cut off access.
4. Copy your **Account ID**. It's on the **Workers & Pages** overview page, and on your account's home page.

## 2. A setup code

Make up a setup code: it lets whoever has it create lists on your server. Use at least 16 letters, digits and hyphens; a password manager can generate one. You type it once, on the first phone.

## 3. GitHub

In your copy of the repository, open **Settings → Secrets and variables → Actions** and add three **repository secrets**:

| Name | Value |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | the token from step 1 |
| `CLOUDFLARE_ACCOUNT_ID` | the account ID from step 1 |
| `PANIER_SETUP_CODE` | the setup code from step 2 |

Then open **Actions → CI → Run workflow** on `main`. After about three minutes, the **deploy** job is green.

The deploy log hides your address, because a public repository's logs are public. Find the address in Cloudflare under **Workers & Pages → panier**.

## 4. The phones

1. On your phone, open `https://panier.<subdomain>.workers.dev/#setup=<your setup code>`. Panier creates the list and shows **Add someone to this list**.
2. On the other phone, scan the QR code with the camera, or send the link through a private messenger.
3. Install the app on each phone: in Firefox, **⋮ → Install** (or **Add to home screen**); in Chrome, **⋮ → Install app**; on an iPhone, Safari's **Share → Add to Home Screen**.
4. Save the pairing link in your password manager. It is the key to the list: with it you can recover the list on a new phone; without it, nobody can, not even you.

## Updating

Every change to `main` is deployed once the tests pass. Lists are kept.

## Your own domain, later

Cloudflare can only serve a Worker on your own domain if the domain's DNS is managed by Cloudflare.

1. Add the domain to Cloudflare, check the DNS records it imports (especially email), and replace the nameservers at your registrar with Cloudflare's. If your registrar has DNSSEC turned on, turn it off first and wait a day.
2. Once Cloudflare shows the domain as **Active**, add a fourth secret, `PANIER_DOMAIN`, set to the full address, such as `list.example.com`. Then run the workflow again.

The app on the new address is a separate copy for the browser: open the pairing link with the new address on each phone. The list itself is the same.

## Security

Anyone with your Cloudflare or GitHub account could change the app the phones load. Turn on two-factor authentication on both.
