# Running the web UI behind Cloudflare

Cloudflare can sit in front of the web UI to hide your server's IP, give you HTTPS and filter bad traffic. There are two ways to set it up:

| | [A. Proxied DNS + nginx](#a-proxied-dns--nginx) | [B. Cloudflare Tunnel](#b-cloudflare-tunnel) |
|---|---|---|
| Open ports on your server | 80 and 443 | none |
| Needs nginx and a certificate | yes | no |
| Good when | you already run nginx for other sites | you want the simplest, most locked-down setup |

> **Only the web UI goes through Cloudflare, not TeamSpeak.** Cloudflare proxies HTTP(S) only, while TeamSpeak uses UDP port 9987. If your TeamSpeak address is a hostname, that DNS record must be **DNS only** (grey cloud). Otherwise the bot, and everyone else, can't connect. On the same machine, `TS_HOST=127.0.0.1` avoids the problem entirely.

---

## A. Proxied DNS + nginx

Set up nginx first, as in steps 1–4 of the [README](../README.md). Then:

### 1. DNS record

In the Cloudflare dashboard, go to **DNS → Records** and add an `A` record named `music` pointing to your server's IP, with the proxy status set to **Proxied** (orange cloud).

### 2. SSL mode: Full (strict)

Go to **SSL/TLS → Overview** and choose **Full (strict)**. Cloudflare then talks to your server over HTTPS and checks its certificate.

Don't use **Flexible**. With Flexible, Cloudflare talks to your server over plain HTTP. The bot then thinks the connection is insecure and drops the `Secure` flag from its login cookie, and if nginx redirects HTTP to HTTPS, you get an endless "too many redirects" loop.

Your server needs a certificate for Full (strict). Either works:

- **certbot**, as in the README. `sudo certbot --nginx -d music.example.com` works while the record is proxied, and renewals keep working.
- **A Cloudflare Origin Certificate**: go to **SSL/TLS → Origin Server → Create Certificate** and save the certificate and key on your server. Then add this to the `server` block in `deploy/nginx.conf`:
  ```nginx
  listen 443 ssl;
  listen [::]:443 ssl;
  ssl_certificate     /etc/ssl/cloudflare/music.example.com.pem;
  ssl_certificate_key /etc/ssl/cloudflare/music.example.com.key;
  ```
  Only Cloudflare trusts this certificate. That's fine here, because visitors always reach your server through Cloudflare.

### 3. Let nginx see visitors' real IPs

The login page blocks an IP after 10 wrong passwords in 15 minutes. Behind Cloudflare, every request seems to come from one of Cloudflare's servers, so one person guessing passwords can lock out everyone who happens to use the same Cloudflare server. To fix that, tell nginx to trust the visitor IP that Cloudflare sends:

```bash
{ for ip in $(curl -fsS https://www.cloudflare.com/ips-v4) $(curl -fsS https://www.cloudflare.com/ips-v6); do echo "set_real_ip_from $ip;"; done; echo "real_ip_header CF-Connecting-IP;"; } | sudo tee /etc/nginx/conf.d/cloudflare-realip.conf
```
```bash
sudo nginx -t && sudo systemctl reload nginx
```

nginx then passes the real IP on in `X-Forwarded-For`. The bot trusts that header only from local proxies, which nginx is. Cloudflare rarely changes its IP ranges, but rerun the command now and then to stay current.

### 4. Optional: only accept web traffic from Cloudflare

Without this, anyone who knows your server's IP can skip Cloudflare. With `ufw`, you can allow ports 80 and 443 only from Cloudflare's ranges:

```bash
for ip in $(curl -fsS https://www.cloudflare.com/ips-v4) $(curl -fsS https://www.cloudflare.com/ips-v6); do sudo ufw allow proto tcp from "$ip" to any port 80,443; done
```

Remove any general `allow 80`/`allow 443` rules afterwards. This also affects every other website on the server, so only do it if all of them are behind Cloudflare. And keep SSH and TeamSpeak's ports open.

---

## B. Cloudflare Tunnel

The `cloudflared` program on your server opens an outgoing connection to Cloudflare, and Cloudflare sends visitors through it. You don't need nginx, a certificate or any open web ports. The bot keeps listening on `127.0.0.1:8090` only.

1. In the Cloudflare dashboard, open **Zero Trust → Networks → Tunnels** and create a tunnel of type **Cloudflared**. Cloudflare shows an install command with a token. Run it on your server. It installs `cloudflared` as a service that starts on boot.
2. In the tunnel, add a **public hostname**:
   - Subdomain `music`, domain `example.com`
   - Service type **HTTP**, URL **`127.0.0.1:8090`**
3. Set `PUBLIC_URL=https://music.example.com` in `.env` and restart the bot.

That's all you need. `cloudflared` passes the visitor's real IP and `https` on to the bot, so the login lockout and secure cookies work without any extra setup. Skip section A when you use a tunnel.

This works with the Docker setup too, because `docker-compose.yml` uses host networking. Keep `WEB_HOST=127.0.0.1`.

**Optional extra login:** in **Zero Trust → Access → Applications**, you can put the hostname behind Cloudflare Access, for example with a one-time code sent to your email address. People then pass Cloudflare's login before they even see the bot's password page.

---

## Things to know with either setup

- **Uploads are limited to 100 MB per file** on Cloudflare's Free and Pro plans, because Cloudflare limits each request to 100 MB. The web UI uploads files one at a time, so uploading many files at once still works. Set `MAX_UPLOAD_MB=100` in `.env` so the bot's own size check matches Cloudflare's. Bigger files fail with "File too large for the server/proxy".
- **Live updates work.** The page gets updates over a long-lived connection (Server-Sent Events). The bot sends data at least once per second, so Cloudflare's 100-second idle timeout never closes it.
- **Caching is handled.** The bot marks everything behind the login as `Cache-Control: private, no-cache`, which keeps Cloudflare from storing it, so you don't need to purge the cache after an update. Don't add a "Cache Everything" rule for this hostname, because it would override that.
- **Challenges can break the page.** "I'm Under Attack" mode, or strict Bot Fight Mode / WAF rules, can show a challenge to the page's background requests, and then the queue stops updating. If that happens, reload the page or turn those features off for this hostname.
- **Rocket Loader** changes how scripts load. If buttons stop working, turn it off under **Speed → Optimization**.

## Troubleshooting

| What you see | Usual cause |
|---|---|
| "Too many redirects" | SSL mode is Flexible. Switch to Full (strict). |
| Cloudflare error 521 / 522 | Cloudflare can't reach your server: nginx is down, nothing is listening on 443, or a firewall blocks Cloudflare. |
| Cloudflare error 525 / 526 | Full (strict) is on, but the server's certificate is missing, expired, or for a different name. |
| 502 Bad Gateway (nginx page) | The bot isn't running, or isn't listening on 8090. Check `docker compose logs -f`. |
| Tunnel shows "down" or error 1033 | `cloudflared` isn't running on the server: `sudo systemctl status cloudflared`. |
| Everyone gets "Too many attempts" at once | Real IPs aren't set up. Do [step A3](#3-let-nginx-see-visitors-real-ips). |
| Uploads fail with 413 | The file is over 100 MB, or over `client_max_body_size` in nginx. |
| The bot can't connect to TeamSpeak | `TS_HOST` is a proxied (orange) hostname. Use the IP or a DNS-only record. |
