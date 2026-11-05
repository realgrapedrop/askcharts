# AskCharts on a server

Run AskCharts on your own server (a VPS) and open it from anywhere: your laptop, your phone, a friend's
computer. It sits behind a sign in with a passkey, because the internet can reach it.

If you only use AskCharts on one computer, you don't need any of this: use the one line install in the
README.

## What you need

- A Linux server with Docker and Docker Compose, or without Docker (see [Without Docker](#without-docker)).
  1 GB of memory is enough; 2 GB if you turn on XRPL On chain. A few GB of disk, plus about 20 GB if you
  download Kraken's history (34 GB free while it comes in), about 400 MB a coin for Binance's and about 85 MB
  a stock for stock history.
- No server yet? [Free and low cost places to run it](#appendix-free-and-low-cost-places-to-run-it), at the
  end of this guide, compares a few as of October 2026.
- A domain you control (a subdomain like `charts.yourdomain.com` is fine). Passkeys and HTTPS need one.
- About 15 minutes.

## 1. Get AskCharts and set it up

```sh
git clone https://github.com/realgrapedrop/askcharts.git
cd askcharts
cp .env.example .env
```

Open `.env` and set two things:

- `ASKCHARTS_ORIGIN`: the address you'll open, with https, like `https://charts.yourdomain.com`
- `ASKCHARTS_EMAIL`: your email. It's the only account that can sign in.

## 2. Start it

```sh
docker compose up -d
docker compose logs -f askcharts
```

The first start builds AskCharts (a few minutes). When the log says "AskCharts is running", it's up.
Press Ctrl+C to stop watching the log; AskCharts keeps running, and starts again after a reboot.

It listens only on the server itself (port 3778). The next step puts it online.

## 3. Put it online with HTTPS

**A. A Cloudflare tunnel** (no ports to open on your server, free):

1. Your domain on Cloudflare, then Zero Trust, Networks, Tunnels: create a tunnel (Cloudflared) and copy
   its token.
2. In the tunnel, add a public hostname: your address (`charts.yourdomain.com`), service
   `http://askcharts:3778`.
3. Put the token in `.env` as `TUNNEL_TOKEN`, and set `ASKCHARTS_TRUST_PROXY=cloudflare` there too, then:

   ```sh
   docker compose --profile tunnel up -d
   ```

**B. Your own web server with HTTPS** (Caddy, nginx and the like): send your address to
`http://127.0.0.1:3778`. With Caddy that's two lines:

```
charts.yourdomain.com {
  reverse_proxy 127.0.0.1:3778
}
```

With nginx, also pass the visitor's address on with
`proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;` (Caddy does it by itself). Then set
`ASKCHARTS_TRUST_PROXY=forwarded` in `.env` and run `docker compose up -d`.

The setting tells AskCharts which header holds each visitor's address, so the sign-in limits count
visitors one by one. Use only the one that matches what you set up: anyone can send those headers, and
AskCharts believes them only because you said a tunnel or proxy writes them.

Either way, opening your address now shows the AskCharts sign in.

## 4. Your first passkey

On the server:

```sh
docker compose exec askcharts node gateway/link.mjs
```

It prints a link that works once, for 15 minutes. Open it on the device you want to use (your phone or
laptop), press Create passkey, and confirm with Face ID, Touch ID, Windows Hello or your phone. You're in.

Another device later: run the same command again. Anyone who opens the link in those 15 minutes can add a
passkey, so open it only on your own device. The sign-in page has no way to ask for a link and AskCharts
sends no email, so a stranger can't trigger one. Passkeys that sync (iCloud Keychain, Google Password
Manager) reach your other devices without a link.

## 5. Add your keys

In AskCharts: Settings (the gear), AskCharts AI. Pick the provider, paste your key, Test, pick a model, Ok.
Optional: Settings, Stock data, for an Alpaca or Polygon (Massive) key (live US stock
prices). Keys are kept on your server, in the data volume, and each is only sent to its own provider. Change
or remove them in the same places whenever you need to.

Your AI and data keys never go in the folder you cloned, so `git pull` can't touch them. The server's own
secret, the tunnel token if you use one, is in `.env`: git ignores it, and it stays readable only by you
if you run `chmod 600 .env`. Don't share or commit it.

## Everyday

- **Update:** Settings, Updates says when a new version is out and shows these steps with the server's own folder.
  An app can't rebuild its own container, so it doesn't update a server by itself.
  1. Sign in to the server (`ssh you@your-server`).
  2. Go to the folder `git clone` made: `cd ~/askcharts` if you cloned it in your home folder. Not sure where it
     is? `docker compose ls` lists it under CONFIG FILES.
  3. `git pull && docker compose up -d --build`. It takes a minute or two; your data stays in the `askcharts-data`
     volume.
  4. Reload AskCharts. Settings, Updates shows the new version.
- **Watch it:** `docker compose logs -f askcharts`
- **Stop it:** `docker compose down` (your data stays). Start again with `docker compose up -d`.
- **Back it up:** everything you make is in the `askcharts-data` volume:

  ```sh
  docker run --rm -v askcharts_askcharts-data:/data -v "$PWD":/backup busybox tar czf /backup/askcharts-data.tgz -C /data .
  ```

  (The volume's name starts with your folder's name: `askcharts_` if you cloned into `askcharts`.)
- **Sign out:** from the AskCharts logo, on each device. A session ends by itself after 7 days.

## Without Docker

AskCharts can also run on a server the way it runs on a computer: installed with the install line and kept
running by systemd, with the same passkey sign in in front of it. The difference from Docker: Settings, Updates
can update it with one click (Update now), no commands. You need a Linux server with systemd and a normal user
account (not root).

1. **Settings first.** Make the settings file before installing, so AskCharts starts with them the first time:

   ```sh
   mkdir -p ~/.config/systemd/user/askcharts.service.d
   nano ~/.config/systemd/user/askcharts.service.d/server.conf
   ```

   Paste this, with your own address and email, then save (Ctrl+O, Enter, Ctrl+X):

   ```ini
   [Service]
   Environment=ASKCHARTS_GATEWAY=1
   Environment=ASKCHARTS_GATEWAY_HOST=127.0.0.1
   Environment=ASKCHARTS_GATEWAY_PORT=3778
   Environment=ASKCHARTS_ORIGIN=https://charts.yourdomain.com
   Environment=ASKCHARTS_EMAIL=you@yourdomain.com
   Environment=ASKCHARTS_TRUST_PROXY=cloudflare
   ```

   `ASKCHARTS_GATEWAY_HOST=127.0.0.1` keeps the sign in on the server itself, so only your tunnel or web server
   reaches it. Set `ASKCHARTS_TRUST_PROXY` the way step 3 above explains: `cloudflare` for a Cloudflare tunnel,
   `forwarded` for Caddy or nginx. The app itself listens on `127.0.0.1:3777`. If either port is taken,
   AskCharts doesn't start and its log says which one.

2. **Keep it running when you log out.** Without this, systemd stops your services when your SSH session ends:

   ```sh
   sudo loginctl enable-linger $USER
   ```

3. **Install it:**

   ```sh
   curl -fsSL https://github.com/realgrapedrop/askcharts/releases/latest/download/install.sh | ASKCHARTS_NO_OPEN=1 sh
   ```

   It puts AskCharts in `~/AskCharts` with its own Node.js and starts it. Check it with
   `systemctl --user status askcharts`; the log is `journalctl --user -u askcharts -f`.

4. **Put it online with HTTPS,** as in step 3 above, sending your address to `http://127.0.0.1:3778`. For a
   Cloudflare tunnel without Docker, Cloudflare's dashboard shows the command that installs the tunnel on your
   server when you create it; give the public hostname the service `http://127.0.0.1:3778`.

5. **Your first passkey:**

   ```sh
   cd ~/AskCharts/program && ASKCHARTS_DATA=~/AskCharts/data ASKCHARTS_ORIGIN=https://charts.yourdomain.com ASKCHARTS_EMAIL=you@yourdomain.com ~/AskCharts/node/bin/node gateway/link.mjs
   ```

   Open the link it prints on your device within 15 minutes, as in step 4 above.

Everyday, without Docker:

- **Update:** Settings, Updates, then Update to the new version. Your settings file stays; so do your charts and
  keys, in `~/AskCharts/data`.
- **Stop and start:** `systemctl --user stop askcharts` and `systemctl --user start askcharts`.
- **Back it up:** everything you make is in `~/AskCharts/data`. Copy that folder somewhere else, with AskCharts
  stopped for a moment if you can.
- **Remove it:** `~/AskCharts/uninstall`, then delete `~/.config/systemd/user/askcharts.service.d`. Your charts
  and keys stay in `~/AskCharts/data` until you delete that folder too.

## Keep it safe

- Leave the port on `127.0.0.1` in `compose.yaml`. Docker's published ports skip your firewall, so
  publishing it on every address would put AskCharts online without HTTPS.
- AskCharts runs indicator code on the server. That's why everything is behind the sign in, and why saving
  a JavaScript indicator asks for your passkey again.
- AskCharts AI's strategy research runs Pine backtests on the server, two at a time and each with a time and
  memory limit, and the sign in lets an account make 120 research requests in 10 minutes.
- One account, no sign up. Passkeys can't be phished or guessed.

## Let your AI set it up

If you use an AI assistant that can run commands on your server (Claude Code, for example), these prompts
walk it through. Read what it runs before you let it: an AI with a shell can change anything on the server.

1. > Install Docker Engine and the Docker Compose plugin on this server, following Docker's official
   > instructions for this Linux version. Then check that `docker compose version` works for my user.

2. > Clone https://github.com/realgrapedrop/askcharts into ~/askcharts. Copy .env.example to .env and set
   > ASKCHARTS_ORIGIN to https://charts.yourdomain.com and ASKCHARTS_EMAIL to you@yourdomain.com. Run
   > `docker compose up -d`, wait for "AskCharts is running" in `docker compose logs askcharts`, and show me
   > the last 20 lines of the log.

3. > Help me put AskCharts online through a Cloudflare tunnel. Tell me exactly what to click in
   > Cloudflare to create the tunnel with a public hostname charts.yourdomain.com pointing at
   > http://askcharts:3778. When I give you the token, put it in ~/askcharts/.env as TUNNEL_TOKEN (don't
   > print it back) and run `docker compose --profile tunnel up -d` in ~/askcharts.

4. > In ~/askcharts, run `docker compose exec askcharts node gateway/link.mjs` and give me the link.

5. > Show me how to back up the AskCharts data volume to a file, and how I'd restore it on a new server.

## Appendix: free and low cost places to run it

These were the options in October 2026. Free tiers and prices change often, so check each provider's own page
before you sign up.

AskCharts needs a machine that stays on, because alerts and the XRPL collector keep running when no browser is
open. That rules out free hosts that put an app to sleep after a few minutes. The installer works on regular
(x86) and Arm Linux, so either kind of server is fine.

| Option | What you get | How it fits |
|---|---|---|
| [Oracle Cloud Always Free](https://docs.oracle.com/en-us/iaas/Content/FreeTier/resourceref.htm) | An Arm server with 2 CPUs and 12 GB of memory (4 and 24 until a 2026 cut), and block storage | Room for everything, Kraken's history included |
| [Google Cloud free tier](https://cloud.google.com/free/docs/free-cloud-features) | One e2-micro (a shared CPU and 1 GB of memory), 30 GB of disk and 1 GB a month of outbound traffic in North America | A light setup: no Kraken history, and 1 GB of traffic goes quickly if you use it every day |
| [AWS](https://aws.amazon.com/free/) | New accounts since July 2025 get $100 to $200 of credit instead of a free year | Free until the credit runs out |
| A small paid VPS | A few dollars a month at many providers. Look for 2 GB of memory and 40 GB of disk | Everything, with no limits to watch |
| A computer at home, like a Raspberry Pi 4 or 5 or an old laptop | Free, apart from the electricity | Everything, with as much disk as you add |

A few things to know:

- **Oracle** may take back a free server it sees as idle: CPU, network and memory all under 20% for a week. A
  personal AskCharts that's quiet most of the day can look idle. The 2026 cut also disabled some servers until
  their owners resized them.
- **Google's** free tier doesn't include a public IP address. A Cloudflare tunnel doesn't need one, but its
  traffic still counts toward the 1 GB.
- **Any of them** can sit behind a free Cloudflare tunnel, as in step 3. That gives you HTTPS and an address
  without opening any ports on the server.

On a budget, I'd go with a computer at home behind a Cloudflare tunnel. It costs nothing to run, has no idle
rules or traffic limits, and you decide how much disk it has. If it has to be in the cloud, Oracle's Always Free
server is the only free one with room for everything. Just keep its idle rule in mind.
