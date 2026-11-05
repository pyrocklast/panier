#!/bin/sh
# Installs or updates Panier on a Raspberry Pi running Raspberry Pi OS (or any Debian).
#
#   sudo sh install.sh list.example.com
#
# It sets up:
#   - the latest Panier release, checked against its published checksum
#   - a service that runs it as its own unprivileged user, reachable only from the Pi itself
#   - Caddy in front of it, which gets and renews the HTTPS certificate automatically
#   - an optional dynamic DNS updater that keeps your address pointing at your home
#   - automatic security updates
#
# Running it again updates Panier and keeps your lists.

set -eu

REPO="pyrocklast/panier"
DOMAIN="${1:-}"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\n%s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Run it with sudo: sudo sh install.sh your.domain"
[ -n "$DOMAIN" ] || die "Give the address the app will use: sudo sh install.sh list.example.com"

case "$(uname -m)" in
	aarch64 | arm64) ARCH=arm64 ;;
	armv7l) ARCH=armv7 ;;
	armv6l) ARCH=armv6 ;;
	x86_64) ARCH=amd64 ;;
	*) die "This processor ($(uname -m)) isn't supported." ;;
esac

say "Installing Caddy and automatic security updates"
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq caddy curl unattended-upgrades >/dev/null

say "Downloading Panier for $ARCH"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
base="https://github.com/$REPO/releases/latest/download"
curl -fsSL -o "$tmp/panier-linux-$ARCH" "$base/panier-linux-$ARCH"
curl -fsSL -o "$tmp/SHA256SUMS" "$base/SHA256SUMS"
(cd "$tmp" && grep " panier-linux-$ARCH\$" SHA256SUMS | sha256sum -c --quiet -) || die "The download didn't match its checksum. Nothing was changed."
install -m 755 "$tmp/panier-linux-$ARCH" /usr/local/bin/panier
echo "Version $(/usr/local/bin/panier -version)"

say "Running Panier as a service"
id panier >/dev/null 2>&1 || useradd --system --home-dir /var/lib/panier --shell /usr/sbin/nologin panier
install -d -o panier -g panier -m 700 /var/lib/panier
cat >/etc/systemd/system/panier.service <<'EOF'
[Unit]
Description=Panier shopping list
After=network-online.target
Wants=network-online.target

[Service]
User=panier
Group=panier
ExecStart=/usr/local/bin/panier -addr 127.0.0.1:8080 -data /var/lib/panier
Restart=on-failure
ReadWritePaths=/var/lib/panier
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
RestrictNamespaces=yes
LockPersonality=yes
MemoryDenyWriteExecute=yes
SystemCallArchitectures=native
CapabilityBoundingSet=

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable panier >/dev/null 2>&1
systemctl restart panier

say "Serving https://$DOMAIN"
if [ -f /etc/caddy/Caddyfile ] && ! grep -q "Panier" /etc/caddy/Caddyfile; then
	cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.before-panier
	echo "Your previous Caddy settings are saved in /etc/caddy/Caddyfile.before-panier"
fi
cat >/etc/caddy/Caddyfile <<EOF
# Panier: HTTPS for $DOMAIN. Caddy gets and renews the certificate itself.
# No access logs are kept.
$DOMAIN {
	reverse_proxy 127.0.0.1:8080
	header Strict-Transport-Security "max-age=31536000"
}
EOF
systemctl enable caddy >/dev/null 2>&1
systemctl reload caddy 2>/dev/null || systemctl restart caddy

say "Dynamic DNS"
if [ -f /etc/panier/ddns.conf ]; then
	echo "Already set up; keeping the existing settings."
elif [ -r /dev/tty ]; then
	echo "Keeps $DOMAIN pointing at your home when your public IP changes."
	echo "It works with any provider that supports DynDNS2 updates; see the setup guide for examples."
	printf 'Update server (leave empty to skip): '
	read -r server </dev/tty || server=""
	if [ -n "$server" ]; then
		printf 'Login: '
		read -r login </dev/tty || login=""
		printf 'Password: '
		stty -echo </dev/tty 2>/dev/null || true
		read -r password </dev/tty || password=""
		stty echo </dev/tty 2>/dev/null || true
		echo
		install -d -m 700 /etc/panier
		printf 'DDNS_HOST=%s\nDDNS_SERVER=%s\n' "$DOMAIN" "$server" >/etc/panier/ddns.conf
		quote() { printf '"%s"' "$(printf '%s' "$1" | sed 's/[\\"]/\\&/g')"; }
		umask 077
		printf 'machine %s\nlogin %s\npassword %s\n' "$server" "$(quote "$login")" "$(quote "$password")" >/etc/panier/ddns.netrc
		umask 022
		chmod 600 /etc/panier/ddns.conf /etc/panier/ddns.netrc
	else
		echo "Skipped. Run the script again to set it up later."
	fi
fi
if [ -f /etc/panier/ddns.conf ]; then
	cat >/usr/local/bin/panier-ddns <<'EOF'
#!/bin/sh
# Keeps the dynamic DNS record pointing at this home's public IPv4 address,
# using the DynDNS2 protocol. It only contacts the provider when the address changes.
set -eu
. /etc/panier/ddns.conf
state=/var/lib/panier-ddns/ip
ip=$(curl -4 -fsS --max-time 15 https://api.ipify.org) || exit 0
[ "$ip" = "$(cat "$state" 2>/dev/null || true)" ] && exit 0
answer=$(curl -fsS --max-time 30 --netrc-file /etc/panier/ddns.netrc \
	"https://$DDNS_SERVER/nic/update?system=dyndns&hostname=$DDNS_HOST&myip=$ip") || exit 1
case "$answer" in
good* | nochg*) echo "$ip" >"$state"; echo "$DDNS_HOST now points to $ip" ;;
*) echo "The provider refused the update: $answer" >&2; exit 1 ;;
esac
EOF
	chmod 755 /usr/local/bin/panier-ddns
	cat >/etc/systemd/system/panier-ddns.service <<'EOF'
[Unit]
Description=Update the dynamic DNS record for Panier
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/panier-ddns
StateDirectory=panier-ddns
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
NoNewPrivileges=yes
EOF
	cat >/etc/systemd/system/panier-ddns.timer <<'EOF'
[Unit]
Description=Check the home address for Panier every five minutes

[Timer]
OnBootSec=1min
OnUnitActiveSec=5min

[Install]
WantedBy=timers.target
EOF
	systemctl daemon-reload
	systemctl enable --now panier-ddns.timer >/dev/null 2>&1
	systemctl start panier-ddns.service || echo "The first dynamic DNS update failed; see: journalctl -u panier-ddns"
fi

sleep 1
systemctl is-active --quiet panier || die "Panier didn't start. See: journalctl -u panier"
code=$(runuser -u panier -- /usr/local/bin/panier -data /var/lib/panier -setup-code)

say "Done"
cat <<EOF
Panier is running. On the first phone, open:

    https://$DOMAIN/#setup=$code

The first visit can take a minute while Caddy gets the certificate.
If the page doesn't load, see "If something doesn't work" in the setup guide.
EOF
