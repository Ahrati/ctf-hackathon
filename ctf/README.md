# CTF Event App (Bun)

A small LAN-hosted CTF web app with shared team accounts, role-based admin access, six CSV-driven challenges, one solve per team per challenge, configurable placement points, admin session revocation, and a TV leaderboard. MySQL/MariaDB stores users, sessions, solves, and points. CTFd is queried read-only for its scoreboard when configured.

## 1. Prepare the server laptop

Install Docker Desktop (or Docker Engine + Compose) and copy the example environment file:

```sh
cp .env.example .env
```

Edit `.env` and replace all passwords and secrets. Use URL-safe (hex) database passwords so the `DATABASE_URL` values do not require URL escaping. Keep `.env` private; it contains an administrator API token for CTFd.

Start the stack:

```sh
docker compose up -d --build
```

The app is on port `3000`. CTFd's admin UI is bound to the host laptop only at `http://127.0.0.1:8000`; the app container reaches CTFd at `http://ctfd:8000` over Docker's private network.

## 2. Create admin and team accounts

Create the first admin account (the account password is typed into the terminal; use a terminal that other people cannot see):

```sh
docker compose exec app bun run user:add -- admin admin "Event Admin"
```

Then create one account per team. Every teammate in a team can share that team's username/password, and every browser login creates a separate session record:

```sh
docker compose exec app bun run user:add -- team-red team "Team Red"
docker compose exec app bun run user:add -- team-blue team "Team Blue"
```

Passwords must be at least 10 characters. Usernames must be unique. There is no public registration route. To create more accounts, repeat the command.

## 3. Set up the six challenges

Each challenge is loaded from `app/challenges/challenge-N.csv`, where `N` is `1` through `6`. The expected shape is a header and one data row:

```csv
title,data,file,flag
"Log analysis","Read the attached log and identify the suspicious record.","/files/challenge-1.zip","aB12cD34"
```

Required fields:

- `data`: task instructions. Quote it when it contains commas, quotes, or line breaks.
- `flag`: exactly 8 characters. It is checked server-side and never returned by the API.
- `file`: optional. Leave it empty if no download is needed; if used, it must be a `/files/...` path. Put the corresponding real file under `app/public/files/`. The app only serves a file when a challenge CSV references it, the user is logged in, and that challenge is enabled.
- `title`: optional, defaults to `Challenge N`.

The checked-in CSVs contain obvious sample text and placeholder flags (`FLAG0001` through `FLAG0006`). Replace all six before the event. CSV edits are read when a challenge is requested; restart the app if you add/remove files or change file permissions.

## 4. Run the event

Open the server laptop's own browser at:

- App login: `http://127.0.0.1:3000`
- Public TV board: `http://127.0.0.1:3000/tv`
- CTFd admin UI: `http://127.0.0.1:8000`

The admin panel is `/admin` after signing in with an admin account. It shows challenge first-place status, local standings, point schedules, and per-browser login sessions. The configured schedule assigns points by place; places beyond the last configured row repeat the final value (set it to `0` if later places should receive no points). Changing a schedule recalculates already-awarded points for that challenge. An admin can disconnect one session or revoke every active session belonging to a team. A revoked session is rejected on the next request.

## 5. Connect participant laptops to the server

**`localhost` will not work from participants' laptops.** `localhost` always means “this same device”. Everyone must use the server laptop's LAN IP address, for example `http://192.168.1.42:3000`.

1. Connect the server laptop, participant laptops, and TV to the same Wi-Fi/LAN.
2. Find the server laptop's Wi-Fi IPv4 address. On Windows run `ipconfig`; on macOS run `ipconfig getifaddr en0` (the interface name may differ); on Linux run `hostname -I` or check Network settings.
3. From a participant laptop, open `http://<server-LAN-IP>:3000`. Open the same URL followed by `/tv` in the TV browser.
4. Allow inbound TCP port `3000` through the server laptop's firewall. Keep CTFd port `8000` host-local unless you specifically need to expose it.
5. Disable Wi-Fi “client isolation” / “AP isolation” and avoid a guest Wi-Fi network that blocks devices from communicating. A DHCP reservation for the server laptop makes its IP stable.

The app binds to `0.0.0.0` inside the container and Compose publishes port 3000 on the LAN interfaces. Test the recorded IP from a second laptop before the event: depending on the OS and Docker Desktop networking, NAT may obscure the original client IP. If all sessions show one shared address, use a host/network deployment path that preserves source IPs before relying on IP correlation. If participants cannot reach the app, first test that both devices are on the same subnet, then check firewall and router client-isolation settings.

## 6. CTFd leaderboard integration

Set `CTFD_URL` and `CTFD_TOKEN` in `.env` to enable the native CTFd scoreboard section on the TV and in the admin page. `CTFD_TOKEN` is an administrator API token used only to read `/api/v1/scoreboard`; it is never sent to the browser.

To also record successful local flag captures on CTFd's native scoreboard, configure **per-team** API tokens and challenge IDs. Create the matching CTFd challenges with the same flags as the CSVs. Each token must belong to the CTFd user who is a member of the intended CTFd team. Then set mappings in `.env` (example values are illustrative):

```dotenv
CTFD_TEAM_TOKENS_JSON='{"team-red":"CTFD_PERSONAL_TOKEN_FOR_RED","team-blue":"CTFD_PERSONAL_TOKEN_FOR_BLUE"}'
CTFD_CHALLENGE_IDS_JSON='{"1":11,"2":14,"3":18,"4":21,"5":25,"6":28}'
```

The keys in `CTFD_TEAM_TOKENS_JSON` are the **local app usernames**. The values in `CTFD_CHALLENGE_IDS_JSON` map local challenge numbers (`1`–`6`) to the IDs of the corresponding challenges in CTFd. A correct local submission is first recorded by the app (for placement/points), then forwarded to CTFd using the matching team's token. A CTFd network/configuration failure does not discard the local solve, and the submission response displays a warning. Do not commit these tokens or expose them in browser JavaScript.

The app's local leaderboard is still authoritative for the custom per-placement schedule configured in the admin panel. CTFd's native scoreboard uses the scoring rules configured within CTFd, so its points may differ unless you configure both systems consistently. If you only set `CTFD_URL` + `CTFD_TOKEN`, CTFd remains a read-only scoreboard display and local solves are not pushed to it.

## 7. Session and MAC address monitoring

The browser app records an individual database row for each login, including the shared team account, login time, last-seen time, IP address and user-agent. Online means a valid, unrevoked session whose last request was seen in the last 90 seconds. The admin can revoke a session, which disconnects that browser on its next app request. This is suitable for event administration but is not proof of identity or misconduct.

**A normal website cannot read a participant's MAC address.** Browsers do not expose it to JavaScript or ordinary HTTP requests. If you need MAC/IP correlation, inspect the Wi-Fi AP/router's DHCP leases/connected clients and match its LAN IP to the app's session IP. MAC randomization and spoofing can make MAC-based identity unreliable, and IPs can change. Use a managed AP/network dashboard if enforcement is needed.

## Notes

- Use the app only on a network you control and test all six flags/files before event day.
- The web UI is served over HTTP for simple local-network operation. Anyone able to observe the Wi-Fi traffic could potentially see credentials/cookies; use a trusted WPA2/WPA3 network, or terminate HTTPS on the LAN if you need transport encryption.
- Protect the laptop physically and keep `.env` and the database volume private.


## 8. Reset local competition state between testing and event day

The guarded reset command backs up the current local competition state to `./backups/` on the host, deletes all local solves/placements, and revokes every browser session. It preserves user accounts, challenge enable/disable state, and point schedules. It does not reset CTFd.

Run it from the project `ctf/` directory:

```sh
docker compose up -d
docker compose exec app bun run event:reset
```

Read the warning and type exactly `RESET EVENT` when prompted. If the backup cannot be written, the reset stops before deleting solves. Backups are sensitive event data; keep them private and do not commit them.

Afterward, remove test team accounts and create the official accounts as needed. This reset intentionally does not delete accounts, because that could lock you out of the admin panel.

**CTFd is separate:** if you used CTFd's native scoreboard during testing, its submissions/scoreboard are not cleared by this command. Back up CTFd first and use a fresh CTFd event/instance or its supported administrative reset process; do not manually truncate CTFd tables. Confirm the CTFd board is clean before connecting participants.

## Editing CSS and frontend files without rebuilding

The app service mounts `./app/public` from your computer into the running container as read-only. You can edit files such as `app/public/css/style.css`, HTML pages, and frontend JavaScript, then refresh the browser; you do not need to run `docker compose down` or rebuild the image after each edit. The mount is read-only inside the container so the app cannot modify your source files.

If you have just added this mount to an existing setup, apply the Compose change once from this directory:

```bash
docker compose up -d app
```

After that, save CSS changes and refresh the page. If the browser still shows old styles, perform a hard refresh (`Ctrl+F5` on Windows/Linux or `Cmd+Shift+R` on macOS). Only changes to backend TypeScript, installed dependencies, or the Dockerfile typically require rebuilding the image with `docker compose up -d --build app`.
