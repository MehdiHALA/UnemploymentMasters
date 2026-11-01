# 🏆 PSN Trophy Leaderboard Discord Bot

Per-server PlayStation trophy leaderboards for Discord: link your PSN account, climb the board, get platinum alerts and a weekly recap. Runs entirely on the **Cloudflare Workers Free plan** with a D1 database.

## ✨ Commands

| Command | What it does |
| --- | --- |
| `/addpsn username` | Link your PSN account (exact Online ID; up to 3 per member) |
| `/removepsn username [user]` | Unlink an account (autocompletes; moderators can remove others) |
| `/leaderboard` | Server standings with avatars, ◀ ▶ pages, 📍 *Me* and 🔄 refresh |
| `/rank` | Your position and the gap to the players around you |
| `/profile [user]` | Trophy card: level, tier, progress bar, trophy counts, server rank |
| `/recent [user] [limit]` | Recently played games with art and completion bars |
| `/platinums [username] [limit]` | Platinum cabinet for a linked or any PSN account |
| `/compare username1 username2` | Head-to-head card |
| `/movers` | This week's biggest trophy gains |
| `/weeklyleaderboard set/disable/post` | Weekly standings (Sundays 16:00 UTC) and platinum alerts in a channel |
| `/support` | Support link |

## 💠 Platinum (per-server premium)

Platinum is switched on per server, never per member. Its commands only appear in servers that have it, so free servers see nothing new.

| Perk | What it does |
| --- | --- |
| Faster updates | Trophies refresh every **2 hours** instead of 6, with a daily history |
| `/monthly` | This month's standings; on the 1st the top hunter is announced and can get a **Hunter of the Month** role |
| `/race start/join/leave/status/end` | Platinum races on one game: join button, progress every 30 minutes, finisher posts, final standings |
| `/game title` | Leaderboard for one game among the server's members |
| `/history [user]` | 8-week trend of platinums and trophies |
| Rarity in alerts | Platinum alerts show how rare the platinum is (e.g. *only 1.7% of players*) |
| `/platinum milestone add/remove/list` | Roles at platinum counts (e.g. 50 → *Plat Hunter*), kept in sync automatically |
| `/platinum color` · `emojis` · `weekly` · `hunter` | Brand colour, custom trophy emojis, weekly post day and hour, Hunter role |
| `/platinum export` | The leaderboard as a CSV file |
| More links | 6 accounts per member (100 for moderators) instead of 3 (50) |

**Turning it on.** The owner uses `/admin grant server_id [days] [note] [announce]` in the owner's server (`OWNER_GUILD_ID`), where `/admin` is the only extra command. With `announce`, the bot posts one welcome message in that server's bot channel once the Platinum commands are live there. `/admin find name` looks up a server's ID by name (from a server list the bot refreshes daily), and `/admin revoke`, `/admin list` and `/admin stats` (servers, links, Platinum, PSN health) sit alongside it. For testing, `PREMIUM_GUILD_IDS` lists servers that always have Platinum.

**Payments are not connected.** Nothing is sold until `PREMIUM_SKU_ID` is set. Once a server subscription SKU exists in the Discord developer portal and its id is in `PREMIUM_SKU_ID`, a server that buys it gets Platinum on its next command (or within the hour, from a background check of Discord's active subscriptions) for as long as the subscription runs. Personal (user) purchases are ignored, and a manual grant is never shortened by a subscription. `/support` and replies to Platinum-only commands then show Discord's own buy button (with the price) in servers without Platinum. Discord bills subscriptions monthly.

**Commands register themselves.** The background job keeps the global commands in sync and adds or removes the Platinum commands in each server as Platinum is granted or ends. It only calls Discord when something changed. All Platinum background work is skipped while no server has Platinum, and it shares the same 45-subrequest budget as everything else.

## ⚙️ How it stays inside the Free plan

Workers Free allows **50 subrequests** (fetch + D1) and **10 ms CPU** per invocation, and background work after a reply is cut off after **30 s**. The bot is built around those limits:

- **Commands never wait on PlayStation.** Leaderboards, ranks and movers are one ranked SQL query in D1 (1–3 subrequests), whether a server has 10 linked accounts or 10,000.
- **A background job every 5 minutes** refreshes the stalest accounts (25 per run by default), announces new platinums and posts weekly standings, each run staying under its own 45-subrequest budget.
- **A shared PSN rate limiter** (240 calls per 15 minutes per PSN account) protects the bot's PSN account; a 429 from Sony pauses all calls until Sony's retry time.
- **Every request ends in a reply.** If something is slow the bot shows "thinking…" and edits the answer in; if Discord rejects a layout it falls back to plain text.

Rough capacity with the defaults: ~7,200 refreshes a day, so about 1,800 linked accounts stay fresher than 6 hours (3,600 within 12 hours). An account in a Platinum server uses 12 refreshes a day instead of 4. Beyond that, data just refreshes less often. More headroom comes from a second PSN account (`PSN_NPSSO_BACKUP`) before any paid plan is needed.

## 🎮 Use a dedicated PSN account

Sony has no public API, so trophy data needs a logged-in PSN account. **Create a separate PSN account for the bot** instead of using your own, and put its NPSSO in `PSN_NPSSO`. Players only need their trophy visibility set to **Anyone**.

To get an NPSSO: log in at playstation.com with the bot account, open `https://ca.account.sony.com/api/v1/ssocookie`, copy the `npsso` value. It lasts about two months; the bot refreshes its login automatically in between and posts a reminder (to `OPS_CHANNEL_ID`) before it expires.

## 🚀 Setup

Requires Node.js 22.13+.

```bash
git clone https://github.com/MehdiHALA/UnemploymentMasters
cd UnemploymentMasters
npm install
```

1. **Database.** For a new deployment create one with `npx wrangler d1 create psn-trophy-bot-db` and put its id in `wrangler.toml`. Tables are created and upgraded automatically on first use (an existing database from the old version is migrated in place).
2. **Secrets.**
   ```bash
   npx wrangler secret put DISCORD_BOT_TOKEN
   npx wrangler secret put PSN_NPSSO
   ```
   Optional: `PSN_NPSSO_BACKUP` (second bot account), `SUPPORT_URL`, `OPS_CHANNEL_ID`.
3. **Deploy.** `npm run cf:deploy`
4. **Commands.** The first background run (within 5 minutes) registers them with the bot token. To do it by hand instead: `DISCORD_BOT_TOKEN=... DISCORD_APPLICATION_ID=... npm run cf:register` (add `DISCORD_GUILD_ID=...` to test in one server instantly).
5. **Discord developer portal.** Set *Interactions Endpoint URL* to your Worker URL, and *Terms of Service URL* / *Privacy Policy URL* to the Worker URL plus `/terms` and `/privacy` (the Worker serves both pages; `terms.html` and `privacy.html` are copies). Invite the bot with the `bot` and `applications.commands` scopes so it can post weekly standings. Platinum milestone and Hunter roles also need **Manage Roles**, with the bot's role above those roles.

## 🔧 Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `DISCORD_PUBLIC_KEY` | (in `wrangler.toml`) | Verifies requests from Discord |
| `DISCORD_BOT_TOKEN` | — | Posting weekly standings, alerts and reminders |
| `PSN_NPSSO` | — | NPSSO of the bot's PSN account |
| `PSN_NPSSO_BACKUP` | — | Optional second PSN account for failover and extra capacity |
| `OPS_CHANNEL_ID` | Outplayed Trash channel | Where PSN login warnings are posted |
| `SUPPORT_URL` | — | Button target for `/support` |
| `CACHE_TTL_HOURS` | `6` | How old trophy data may get before a refresh |
| `REFRESH_PER_RUN` | `25` | Accounts refreshed per 5-minute run |
| `PSN_CALLS_PER_15_MIN` | `240` | PSN calls allowed per account per 15 minutes |
| `MAX_LINKS_PER_USER` | `3` | Linked accounts per member per server |
| `MAX_LINKS_PER_MODERATOR` | `50` | Same, for members with Manage Server (who link for their community) |
| `SUBREQUEST_BUDGET` | `45` | Raise (e.g. `500`) only on the Workers Paid plan |
| `EMOJI_PLATINUM` / `_GOLD` / `_SILVER` / `_BRONZE` | 🏆 🟡 ⚪ 🟤 | Custom trophy emojis, e.g. `<:plat:123…>` |
| `OWNER_GUILD_ID` | Outplayed Trash | The owner's server, the only place `/admin` is registered (administrators there can use it) |
| `OWNER_USER_IDS` | — | Optional user ids allowed to use `/admin` without being an administrator there |
| `PREMIUM_GUILD_IDS` | — | Servers that always have Platinum (testing), comma-separated |
| `PREMIUM_SKU_ID` | — | Discord server-subscription SKU that unlocks Platinum. Leave empty: payments stay disconnected |
| `PREMIUM_CACHE_TTL_HOURS` | `2` | Refresh interval for accounts in Platinum servers |
| `PREMIUM_LINKS_PER_USER` / `PREMIUM_LINKS_PER_MODERATOR` | `6` / `100` | Link caps in Platinum servers |

## 🧪 Development

```bash
npm test
```

The tests run the real Worker against an in-memory SQLite database and fake PSN and Discord APIs, with the Free plan's 50-subrequest cap enforced and every message checked against Discord's component limits. They cover all commands in a 1,000-account server, the background job (refresh rotation, platinum alerts, weekly posts, rate limiting, PSN login failures), every Platinum feature (grants, command registration, races, monthly standings, milestone roles, the payment hook), the database upgrades from previous versions, the command definitions, and the layouts.

`npx wrangler tail` shows a log line per command and per background run with the number of subrequests used.

## 📄 License

This project is licensed under the [MIT License](./LICENSE). Not affiliated with Sony Interactive Entertainment.
