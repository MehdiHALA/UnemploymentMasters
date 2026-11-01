// Layouts for Platinum features. Same Components V2 building blocks and limits as ui.js.

import {
  actionRow,
  bar,
  button,
  COLORS,
  container,
  escapeMarkdown,
  fmt,
  mention,
  message,
  moversView,
  name,
  noticeView,
  platformBadge,
  premiumButton,
  rankBadge,
  relative,
  separator,
  text,
  withImage,
} from "./ui.js";

export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const SPARK = "▁▂▃▄▅▆▇█";

const hex = (color) => `#${Number(color).toString(16).padStart(6, "0")}`;
const roleMention = (id) => (id ? `<@&${id}>` : "not set");

export function monthLabel(month) {
  const [year, monthNumber] = String(month || "").split("-").map(Number);
  if (!year || !monthNumber) return "this month";
  return new Date(Date.UTC(year, monthNumber - 1, 1)).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

// Shown when a Platinum command is used without Platinum; with a buy button once payments
// are connected (PREMIUM_SKU_ID).
export function premiumOnlyView({ skuId = "" } = {}) {
  const view = noticeView({
    tone: "info",
    title: "This is a Platinum feature",
    body: skuId ? "Platinum is a subscription for the whole server. A server admin can start it here:" : "Platinum isn't active in this server.",
  });
  if (skuId) view.components[0].components.push(actionRow([premiumButton(skuId)]));
  return view;
}

// One-time post when the owner gives a server Platinum with `announce`.
export function welcomeMessage({ expiresAt, theme }) {
  const until = expiresAt ? `free until <t:${Math.floor(expiresAt / 1000)}:D>` : "free, with no end date";
  return message([
    container(
      [
        text([`## ${theme.icons.platinum} This server now has Platinum`, `-# The bot's premium tier, ${until}. Nothing to pay.`].join("\n")),
        separator(),
        text(
          [
            "⚡ Trophies refresh every **2 hours** instead of 6",
            "📅 `/monthly` standings: the top hunter is crowned on the 1st of each month",
            "🏁 `/race` platinum races on one game, with live progress",
            "🎮 `/game` boards for a single game · 📈 `/history` 8-week trends",
            "💎 Platinum alerts now show how rare each platinum is",
          ].join("\n")
        ),
        separator({ divider: false }),
        text(
          "-# Admins: `/platinum` sets milestone roles, a Hunter of the Month role, colours, trophy emojis, the weekly post time and CSV export. New commands can take a minute to appear."
        ),
      ],
      theme.accent
    ),
  ]);
}

// ---------------------------------------------------------------------------------------
// /platinum status and settings.

export function platinumStatusView({ branding, milestones, expiresAt, theme }) {
  const weekly =
    branding.weekly_day === null || branding.weekly_day === undefined
      ? "Sundays 16:00 UTC (default)"
      : `${WEEKDAYS[branding.weekly_day]}s ${String(branding.weekly_hour ?? 16).padStart(2, "0")}:00 UTC`;
  const lines = [
    `## ${theme.icons.platinum} Platinum is active`,
    branding.premium_source === "entitlement"
      ? "-# Through this server's Discord subscription"
      : expiresAt
        ? `-# Until <t:${Math.floor(expiresAt / 1000)}:D>`
        : "-# No end date",
  ];

  const perks = [
    "⚡ Trophies refresh every **2 hours** (instead of 6)",
    "💎 Rarity in platinum alerts",
    "📅 `/monthly` standings and a Hunter of the Month",
    "🏁 `/race` platinum races · 🎮 `/game` per-game boards · 📈 `/history`",
    "🎖️ Milestone roles · 🎨 your colour and trophy emojis · 📄 CSV export",
  ];

  const settings = [
    `**Accent colour:** ${branding.accent_color === null || branding.accent_color === undefined ? "default" : hex(branding.accent_color)}`,
    `**Trophy emojis:** ${theme.icons.platinum} ${theme.icons.gold} ${theme.icons.silver} ${theme.icons.bronze}`,
    `**Weekly post:** ${weekly}`,
    `**Hunter of the Month role:** ${roleMention(branding.hunter_role_id)}`,
    `**Milestone roles:** ${milestones.length === 0 ? "none" : milestones.map((m) => `${fmt(m.platinums)} → ${roleMention(m.role_id)}`).join(", ")}`,
    branding.roles_error ? `⚠️ Roles paused: ${rolesErrorText(branding.roles_error)}` : "",
  ].filter(Boolean);

  return message(
    [container([text(lines.join("\n")), separator(), text(perks.join("\n")), separator(), text(settings.join("\n"))], theme.accent)],
    { ephemeral: true }
  );
}

export function rolesErrorText(error) {
  return error === "missing_access"
    ? "I need **Manage Roles**, and my role must be above the milestone roles. Change any milestone setting to retry."
    : "Discord rejected a role change. Change any milestone setting to retry.";
}

export function milestoneListView({ milestones, rolesError, theme }) {
  const body =
    milestones.length === 0
      ? "No milestone roles yet. Add one with **/platinum milestone add**."
      : milestones.map((m) => `${theme.icons.platinum} **${fmt(m.platinums)}** platinums → ${roleMention(m.role_id)}`).join("\n");
  return message(
    [
      container(
        [
          text(`### 🎖️ Milestone roles\n${body}`),
          text(
            rolesError
              ? `⚠️ ${rolesErrorText(rolesError)}`
              : "-# Members get the highest milestone they've reached, based on their best linked account. Updates within the hour."
          ),
        ],
        theme.accent
      ),
    ],
    { ephemeral: true }
  );
}

// ---------------------------------------------------------------------------------------
// Monthly standings and Hunter of the Month.

export function monthlyMessage(data, { theme }) {
  const view = moversView(
    { ...data, movers: data.movers },
    { theme, title: `${monthLabel(data.month)} standings` }
  );
  view.components.push(text("-# The top hunter of the month is announced on the 1st."));
  return message([{ ...view, accent_color: theme.accent }]);
}

export function hunterOfMonthMessage({ month, winners, roleId, theme }) {
  const [first, ...rest] = winners;
  const gains = (row) =>
    [`+${fmt(row.platinum_gain)} ${theme.icons.platinum}`, `+${fmt(row.total_gain)} trophies`].join(" · ");
  const children = [
    withImage(
      [
        `## 👑 Hunter of ${monthLabel(month)}`,
        `**${name(first)}** ${mention(first.discord_id)}`,
        gains(first),
        roleId ? `-# Wears ${roleMention(roleId)} until next month` : "",
      ]
        .filter(Boolean)
        .join("\n"),
      first.avatar_url,
      `${first.name} avatar`
    ),
  ];
  if (rest.length > 0) {
    children.push(separator({ divider: false }));
    children.push(text(rest.map((row, index) => `${rankBadge(index + 2, theme)} **${name(row)}** · ${gains(row)}`).join("\n")));
  }
  children.push(text("-# A new month starts now. Every trophy counts again."));
  return message([container(children, theme.custom ? theme.accent : COLORS.gold)]);
}

// ---------------------------------------------------------------------------------------
// Races.

function raceHeader(race, theme) {
  return withImage(
    [
      `## 🏁 Platinum race: ${escapeMarkdown(race.title_name)}`,
      `${platformBadge(race.platform)} First to the platinum wins.`,
      `-# Ends <t:${Math.floor(race.ends_at / 1000)}:R> · progress updates every 30 minutes`,
    ].join("\n"),
    race.title_icon_url,
    race.title_name
  );
}

export function raceStartMessage(race, { theme }) {
  return message([
    container(
      [
        raceHeader(race, theme),
        separator(),
        text(`Started by ${mention(race.created_by)}. Join with **/race join** or the button below.`),
        actionRow([button({ customId: `race:join:${race.id}`, label: "Join race", emoji: "🏁", style: 1 })]),
      ],
      theme.accent
    ),
  ]);
}

function participantLine(row, index, theme) {
  if (row.finished_at) {
    return `${rankBadge(index + 1, theme)} **${escapeMarkdown(row.name)}** · ${theme.icons.platinum} platinum ${relative(row.finished_at)}`;
  }
  return `\`${bar(row.progress)}\` **${row.progress}%** · ${escapeMarkdown(row.name)}`;
}

export function raceStatusMessage(race, participants, { theme, ended = false }) {
  const finishers = participants.filter((row) => row.finished_at).slice(0, 20);
  const racing = participants.filter((row) => !row.finished_at).slice(0, 20 - finishers.length);
  const lines = [
    ...finishers.map((row, index) => participantLine(row, index, theme)),
    ...racing.map((row, index) => participantLine(row, finishers.length + index, theme)),
  ];
  return message([
    container(
      [
        raceHeader(race, theme),
        separator(),
        text(
          lines.length > 0
            ? `${ended ? "### Final standings\n" : ""}${lines.join("\n")}`
            : "Nobody has joined yet. Use **/race join**."
        ),
        text(`-# ${fmt(participants.length)} racing${ended ? " · race over" : ""}`),
      ],
      theme.accent
    ),
  ]);
}

export function raceFinishMessage(race, participant, position, { theme }) {
  return message([
    container(
      [
        withImage(
          [
            `## 🏁 ${rankBadge(position, theme)} ${escapeMarkdown(participant.name)} finished!`,
            `${mention(participant.discord_id)} earned the platinum in **${escapeMarkdown(race.title_name)}**.`,
            `-# Finisher #${position} in the platinum race`,
          ].join("\n"),
          race.title_icon_url,
          race.title_name
        ),
      ],
      theme.custom ? theme.accent : COLORS.gold
    ),
  ]);
}

// ---------------------------------------------------------------------------------------
// Per-game leaderboard.

export function gameBoardMessage(rows, { theme }) {
  const first = rows[0];
  const players = Number(first?.players || rows.length);
  const lines = rows.map(
    (row, index) =>
      `${rankBadge(index + 1, theme)} **${name(row)}** · ${row.platinum > 0 ? `${theme.icons.platinum} ` : ""}\`${bar(row.progress)}\` **${row.progress}%** · ${fmt(row.total)} trophies`
  );
  return message([
    container(
      [
        withImage(
          [`## 🎮 ${escapeMarkdown(first.title_name)}`, `${platformBadge(first.platform)} ${fmt(players)} player${players === 1 ? "" : "s"} in this server`].join("\n"),
          first.title_icon_url,
          first.title_name
        ),
        separator(),
        text(lines.join("\n")),
        text("-# From each member's recently played games. Updates every 12 hours."),
      ],
      theme.accent
    ),
  ]);
}

// ---------------------------------------------------------------------------------------
// History.

export function sparkline(values) {
  const max = Math.max(...values, 0);
  if (max <= 0) return SPARK[0].repeat(values.length);
  return values.map((value) => SPARK[Math.min(SPARK.length - 1, Math.round((value / max) * (SPARK.length - 1)))]).join("");
}

// rows: daily snapshots for one account, oldest first.
export function weeklyGains(rows, key, weeks, now) {
  const day = 24 * 60 * 60 * 1000;
  const gains = [];
  for (let week = weeks - 1; week >= 0; week -= 1) {
    const end = now - week * 7 * day;
    const start = end - 7 * day;
    const inWeek = rows.filter((row) => Date.parse(`${row.day}T23:59:59Z`) <= end);
    const before = rows.filter((row) => Date.parse(`${row.day}T23:59:59Z`) <= start);
    const last = inWeek.at(-1);
    const previous = before.at(-1) || rows[0];
    gains.push(last && previous ? Math.max(0, Number(last[key]) - Number(previous[key])) : 0);
  }
  return gains;
}

export function historyMessage({ accounts, now, theme }) {
  const containers = accounts.slice(0, 3).map((account) => {
    const rows = account.rows;
    if (rows.length < 2) {
      return container(
        [text(`### 📈 ${escapeMarkdown(account.name)}\nHistory builds up from today. Check back in a few days.`)],
        theme.accent
      );
    }
    const platinum = weeklyGains(rows, "platinum", 8, now);
    const total = weeklyGains(rows, "total", 8, now);
    const first = rows[0];
    const last = rows.at(-1);
    return container(
      [
        text(
          [
            `### 📈 ${escapeMarkdown(account.name)}`,
            `${theme.icons.platinum} \`${sparkline(platinum)}\` **+${fmt(platinum.reduce((a, b) => a + b, 0))}** platinums in 8 weeks`,
            `🎯 \`${sparkline(total)}\` **+${fmt(total.reduce((a, b) => a + b, 0))}** trophies`,
            `-# Since ${first.day}: ${fmt(first.platinum)} → ${fmt(last.platinum)} platinums · level ${last.trophy_level ?? "?"}`,
          ].join("\n")
        ),
      ],
      theme.accent
    );
  });
  return message(containers);
}

// ---------------------------------------------------------------------------------------
// Owner tools.

export function adminStatsView({ stats, names, guildCount, premiumIds }) {
  const t = stats.totals;
  const h = stats.health;
  const loginDays = h.login_expires ? ((Number(h.login_expires) - Date.now()) / 86400000).toFixed(1) : "?";
  const top = stats.top
    .map((row, index) => `${index + 1}. **${escapeMarkdown(names.get(row.guild_id) || row.guild_id)}** · ${fmt(row.links)} links · ${fmt(row.people)} people${premiumIds.has(row.guild_id) ? " · 💠" : ""}`)
    .join("\n");
  return message(
    [
      container(
        [
          text(
            [
              "## 📊 Bot stats",
              `**${guildCount === null ? "?" : fmt(guildCount)}** servers installed · **${fmt(t.servers)}** with links · **${fmt(stats.premium)}** Platinum`,
              `**${fmt(t.links)}** links · ${fmt(t.accounts)} PSN accounts · ${fmt(t.people)} people`,
              `${fmt(h.weekly_servers)} servers with weekly posts`,
            ].join("\n")
          ),
          separator(),
          text(`### Biggest servers\n${top || "none"}`),
          separator(),
          text(
            [
              "### Health",
              `Fresh (<6 h): **${fmt(h.fresh_6h)}** · private: ${fmt(h.private)}`,
              `PSN login: ${h.auth_error ? `⚠️ ${escapeMarkdown(String(h.auth_error).slice(0, 120))}` : "✅ OK"} · renews within ${loginDays} days`,
            ].join("\n")
          ),
        ],
        COLORS.psn
      ),
    ],
    { ephemeral: true }
  );
}

function welcomeLabel(status) {
  if (status === "pending") return " · welcome post waiting for a working bot channel";
  if (status?.startsWith("posted:")) return ` · welcomed in <#${status.slice(7)}>`;
  return "";
}

export function adminListView({ rows, names }) {
  const lines = rows.map(
    (row) =>
      `💠 **${escapeMarkdown(names.get(row.guild_id) || row.guild_id)}** · \`${row.guild_id}\` · ${row.source}${row.expires_at ? ` · until <t:${Math.floor(row.expires_at / 1000)}:D>` : ""}${row.note ? ` · ${escapeMarkdown(row.note)}` : ""}${welcomeLabel(row.welcome_status)}`
  );
  return message([container([text(`### Platinum servers\n${lines.join("\n") || "None yet."}`)], COLORS.psn)], { ephemeral: true });
}

export function adminFindView({ rows, query }) {
  const lines = rows.map(
    (row) =>
      `${Number(row.premium) === 1 ? "💠" : "▫️"} **${escapeMarkdown(row.name)}** · \`${row.guild_id}\` · ${fmt(row.member_count ?? 0)} members · ${fmt(row.links)} links`
  );
  return message(
    [
      container(
        [
          text(`### Servers matching "${escapeMarkdown(query)}"\n${lines.join("\n") || "None found."}`),
          text("-# The server list refreshes once a day. Copy an ID into /admin grant."),
        ],
        COLORS.psn
      ),
    ],
    { ephemeral: true }
  );
}
