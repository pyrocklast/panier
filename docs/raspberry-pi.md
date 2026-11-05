# Setting up Panier on a Raspberry Pi

This guide puts Panier on a Raspberry Pi at home, reachable at your own address with HTTPS.

Throughout, `list.example.com` stands for your address. Replace it with yours.

You need:

- a Raspberry Pi 3 or newer, a microSD card (8 GB is plenty) and a power supply
- an Ethernet cable to your router (more reliable than Wi-Fi)
- a computer with [Raspberry Pi Imager](https://www.raspberrypi.com/software/)
- a domain name at a DNS provider that supports dynamic DNS updates (see step 3)

Allow about an hour. The order matters: the address and the router must be ready before the install, so the Pi can get its certificate.

## 1. Prepare the Pi

1. In Raspberry Pi Imager, choose your Pi model, then **Raspberry Pi OS (other) → Raspberry Pi OS Lite (64-bit)**, then the SD card.
2. When it offers to customise the settings, set:
   - hostname: `panier`
   - a username and password
   - **Services → Enable SSH**. If you have an SSH key, choose public-key authentication and paste it.
3. Write the card, put it in the Pi, plug the Pi into the router with the cable, and power it on.
4. From your computer, a minute later: `ssh <username>@panier.local`

## 2. Your router

Open your router's settings page (often `http://192.168.1.1` or `http://192.168.0.1`). Menu names differ between routers.

1. **Make sure your home has its own public IPv4 address.** Some internet providers share one IPv4 address between several customers (carrier-grade NAT, often shown as "CGN" or "IPv4 sharing"), which stops the Pi from being reached from outside. Look for that setting and turn sharing off, or ask your provider for a dedicated IPv4 address. Your public address may change when you do; that's expected.
2. **Give the Pi a fixed local address.** In the DHCP settings, add a reservation (static lease) for the device named `panier`.
3. **Open the web ports to the Pi.** In the port forwarding settings (sometimes "NAT/PAT" or "virtual servers"), forward two TCP ports to the Pi:
   - external port 80 → internal port 80
   - external port 443 → internal port 443

   If the router refuses port 443, turn off its own remote administration, which can use that port.

## 3. Your address

Dynamic DNS keeps your address pointing at your home, even when your provider changes your public IP. The Pi updates it using the DynDNS2 protocol, which most DNS providers support. Set it up at your DNS provider:

1. Create a dynamic DNS record for your subdomain (for `list.example.com`, the subdomain is `list`). If it asks for an IP, give your current public IP if you know it, otherwise any address; the Pi corrects it within minutes.
2. Create the login the Pi will use to update that record, and note the provider's **update server**.
3. If the zone already has an ordinary **A** or **AAAA** record for that subdomain, delete it, or the dynamic record won't work.

Some providers' update servers:

| Provider | Update server |
| --- | --- |
| OVHcloud (DynHost) | `dns.eu.ovhapis.com` |
| Dynu | `api.dynu.com` |
| No-IP | `dynupdate.no-ip.com` |

## 4. Install Panier

On the Pi:

```sh
curl -fsSLO https://raw.githubusercontent.com/pyrocklast/panier/main/deploy/install.sh
less install.sh                      # optional: read what it does
sudo sh install.sh list.example.com
```

When it asks, enter the update server, login and password from step 3. At the end it prints a link like:

```
https://list.example.com/#setup=ABCD-EFGH-JKMN
```

Keep it for the next step. The first visit can take a minute while the certificate is issued.

## 5. The phones

1. On your phone, open the setup link. Panier creates the list and shows **Add someone to this list**.
2. On the other phone, scan the QR code with the camera, or send the link through a private messenger.
3. Install the app on each phone: in Firefox, **⋮ → Install** (or **Add to home screen**); in Chrome, **⋮ → Install app**; on an iPhone, Safari's **Share → Add to Home Screen**.
4. Save the pairing link in your password manager. It is the key to the list: with it you can recover the list on a new phone; without it, nobody can, not even you.

Check that it works both on mobile data and on your home Wi-Fi.

## Updating

Run the install script again. It downloads the latest release and keeps your lists.

## If something doesn't work

- **The page doesn't load from anywhere.**
  - Is the address pointing home? `getent hosts list.example.com` on the Pi should show the same IP as `curl -4 https://api.ipify.org`. If not, check `journalctl -u panier-ddns`.
  - Is the certificate there? `journalctl -u caddy --since "10 min ago"` shows errors about obtaining it, usually because ports 80 and 443 aren't forwarded or the IPv4 address is still shared.
  - Is Panier running? `systemctl status panier`.
- **It works on mobile data but not on the home Wi-Fi.** Some routers don't let devices inside the home reach the home's own public address. Open an issue; there are workarounds.
- **You need the setup code again:** `sudo runuser -u panier -- panier -data /var/lib/panier -setup-code`

## What's on the Pi

- `/usr/local/bin/panier`, run by the `panier` service as its own user, listening only on the Pi itself
- `/var/lib/panier`: the setup code, and each list's access-token hash and encrypted changes. Nothing in it is readable without a pairing link.
- `/etc/caddy/Caddyfile`: HTTPS for your address. No access logs are kept.
- `/etc/panier`: the dynamic DNS login (readable by root only), used by `panier-ddns`, which checks your public IP every five minutes through api.ipify.org and only contacts your DNS provider when it changes
