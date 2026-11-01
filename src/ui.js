// Discord Components V2 layouts for every bot message. Views are pure functions of data, so
// they can be unit-tested against Discord's limits (40 components, 4,000 characters).

const COMPONENTS_V2 = 1 << 15;
const EPHEMERAL = 1 << 6;

export const COLORS = {
  psn: 0x0070d1,
  platinum: 0x9fc3ef,
  gold: 0xe3b341,
  silver: 0xb6bcc8,
  bronze: 0xc8814a,
  success: 0x3ba55d,
  warning: 0xf0b232,
  danger: 0xed4245,
};

const TIER_GROUPS = [
  { from: 10, name: "Platinum", color: COLORS.platinum },
  { from: 7, name: "Gold", color: COLORS.gold },
  { from: 4, name: "Silver", color: COLORS.silver },
  { from: 1, name: "Bronze", color: COLORS.bronze },
];

export function createTheme(env = {}) {
  return {
    icons: {
      platinum: env.EMOJI_PLATINUM || "🏆",
      gold: env.EMOJI_GOLD || "🟡",
      silver: env.EMOJI_SILVER || "⚪",
      bronze: env.EMOJI_BRONZE || "🟤",
      medals: ["🥇", "🥈", "🥉"],
      sync: "⏳",
    },
  };
}

// ---------------------------------------------------------------------------------------
// Component builders.

export const text = (content) => ({ type: 10, content });

export const thumbnail = (url, description) => ({
  type: 11,
  media: { url },
  ...(description ? { description: String(description).slice(0, 1000) } : {}),
});

export const section = (content, accessory) => ({ type: 9, components: [text(content)], accessory });

export const gallery = (items) => ({
  type: 12,
  items: items.slice(0, 10).map(({ url, description }) => ({
    media: { url },
    ...(description ? { description: String(description).slice(0, 1000) } : {}),
  })),
});

export const separator = ({ divider = true, spacing = 1 } = {}) => ({ type: 14, divider, spacing });

export const container = (components, accentColor) => ({
  type: 17,
  ...(accentColor === undefined || accentColor === null ? {} : { accent_color: accentColor }),
  components,
});

export const actionRow = (components) => ({ type: 1, components });

export function button({ customId, label, emoji, style = 2, disabled = false, url }) {
  return {
    type: 2,
    style: url ? 5 : style,
    ...(label ? { label } : {}),
    ...(emoji ? { emoji: { name: emoji } } : {}),
    ...(url ? { url } : { custom_id: customId }),
    ...(disabled ? { disabled: true } : {}),
  };
}

export function message(components, { ephemeral = false } = {}) {
  return {
    flags: COMPONENTS_V2 | (ephemeral ? EPHEMERAL : 0),
    components,
    allowed_mentions: { parse: [] },
  };
}

// Text plus an image when we have one; Discord requires a section accessory.
function withImage(content, imageUrl, description) {
  return imageUrl ? section(content, thumbnail(imageUrl, description)) : text(content);
}

// ---------------------------------------------------------------------------------------
// Formatting helpers.

export function escapeMarkdown(value) {
  return String(value ?? "").replace(/[\\`*_~|>[\]()]/g, "\\$&");
}

export function fmt(value) {
  return Number(value || 0).toLocaleString("en-US");
}

export function bar(percent, size = 10) {
  const clamped = Math.max(0, Math.min(100, Number(percent) || 0));
  const filled = Math.round((clamped / 100) * size);
  return "▰".repeat(filled) + "▱".repeat(size - filled);
}

function splitBar(a, b, size = 10) {
  const total = Number(a) + Number(b);
  if (!total) return "▱".repeat(size);
  const filled = Math.round((Number(a) / total) * size);
  return "▰".repeat(filled) + "▱".repeat(size - filled);
}

export const relative = (ms) => (ms ? `<t:${Math.floor(ms / 1000)}:R>` : "never");
const shortDate = (ms) => (ms ? `<t:${Math.floor(ms / 1000)}:d>` : "");

function tierInfo(tier) {
  const value = Number(tier || 0);
  return TIER_GROUPS.find((group) => value >= group.from) || null;
}

function rankBadge(rank, theme) {
  return theme.icons.medals[rank - 1] || `\`#${rank}\``;
}

function trophyLine(stats, theme, { bold = "platinum" } = {}) {
  const { icons } = theme;
  const value = (key) => (key === bold ? `**${fmt(stats[key])}**` : fmt(stats[key]));
  return `${icons.platinum} ${value("platinum")} · ${icons.gold} ${value("gold")} · ${icons.silver} ${value("silver")} · ${icons.bronze} ${value("bronze")}`;
}

function platformBadge(platform) {
  return platform ? String(platform).split(",").map((p) => `\`${p.trim()}\``).join(" ") : "";
}

const name = (row) => escapeMarkdown(row.name || row.psn_username || row.onlineId || "Unknown");
const mention = (id) => (id && /^\d+$/.test(String(id)) ? `<@${id}>` : "");

// ---------------------------------------------------------------------------------------
// Generic notices.

const TONES = {
  success: { color: COLORS.success, icon: "✅" },
  info: { color: COLORS.psn, icon: "ℹ️" },
  warning: { color: COLORS.warning, icon: "⚠️" },
  danger: { color: COLORS.danger, icon: "⛔" },
};

export function noticeView({ tone = "info", title, body = "", suggestions = [] }, { ephemeral = true } = {}) {
  const style = TONES[tone] || TONES.info;
  const lines = [`### ${style.icon} ${title}`];
  if (body) lines.push(body);
  if (suggestions.length > 0) {
    lines.push(`-# Did you mean: ${suggestions.map((s) => `**${escapeMarkdown(s)}**`).join(", ")}?`);
  }
  return message([container([text(lines.join("\n"))], style.color)], { ephemeral });
}

// Keeps every text display and drops media/buttons; used when Discord rejects a layout.
export function textOnlyFallback(payload) {
  const parts = [];
  const walk = (components = []) => {
    for (const component of components) {
      if (component.type === 10) parts.push(component.content);
      if (component.components) walk(component.components);
    }
  };
  walk(payload?.components);
  const content = (parts.join("\n\n") || "Something went wrong while drawing this message.").slice(0, 3900);
  return { flags: COMPONENTS_V2 | (payload?.flags & EPHEMERAL), components: [container([text(content)])], allowed_mentions: { parse: [] } };
}

// ---------------------------------------------------------------------------------------
// Leaderboard.

export function leaderboardView(data, { page, pageSize, theme, title = "Trophy Leaderboard", interactive = true }) {
  const { icons } = theme;
  const pageCount = Math.max(1, Math.ceil(data.rankedCount / pageSize));
  const children = [];

  const subtitle = [
    `${fmt(data.rankedCount)} ranked`,
    data.pendingCount > 0 ? `${icons.sync} ${fmt(data.pendingCount)} syncing` : "",
    "platinum › gold › silver › bronze",
  ].filter(Boolean).join(" · ");
  children.push(text(`## ${icons.platinum} ${title}\n-# ${subtitle}`));
  children.push(separator());

  if (data.rankedCount === 0) {
    children.push(
      text(
        data.linkedCount === 0
          ? "No one has linked a PSN account here yet.\nUse **/addpsn** to put yourself on the board."
          : `${icons.sync} Syncing **${fmt(data.linkedCount)}** linked accounts — the first standings appear within a few minutes.`
      )
    );
    return container(children, COLORS.psn);
  }

  const podium = page === 1 ? data.rows.slice(0, 3) : [];
  for (const row of podium) {
    const who = mention(row.discord_id);
    children.push(
      withImage(
        [
          `${rankBadge(row.rank, theme)} **${name(row)}**${who ? ` · ${who}` : ""}`,
          trophyLine(row, theme),
          `-# Level ${row.trophy_level ?? "?"} · ${fmt(row.total)} trophies`,
        ].join("\n"),
        row.avatar_url,
        `${row.name} avatar`
      )
    );
  }

  const rest = data.rows.slice(podium.length);
  if (rest.length > 0) {
    if (podium.length > 0) children.push(separator({ divider: false }));
    children.push(text(rest.map((row) => `${rankBadge(row.rank, theme)} **${name(row)}** · ${trophyLine(row, theme)}`).join("\n")));
  }

  children.push(separator());
  children.push(
    text(
      interactive
        ? `-# Page ${page}/${pageCount} · Updated ${relative(data.updatedAt)}`
        : `-# Top ${data.rows.length} of ${fmt(data.rankedCount)} · /leaderboard for everyone · Updated ${relative(data.updatedAt)}`
    )
  );

  if (interactive) {
    children.push(
      actionRow([
        button({ customId: `lb:page:${page - 1}`, emoji: "◀️", disabled: page <= 1 }),
        button({ customId: "lb:noop", label: `${page} / ${pageCount}`, disabled: true }),
        button({ customId: `lb:page:${page + 1}`, emoji: "▶️", disabled: page >= pageCount }),
        button({ customId: "lb:me", label: "Me", emoji: "📍", style: 1 }),
        button({ customId: `lb:refresh:${page}`, emoji: "🔄" }),
      ])
    );
  }

  return container(children, COLORS.psn);
}

export function leaderboardMessage(data, options) {
  return message([leaderboardView(data, options)]);
}

// ---------------------------------------------------------------------------------------
// Rank.

function gapText(higher, lower, theme) {
  for (const key of ["platinum", "gold", "silver", "bronze"]) {
    const diff = Number(higher[key]) - Number(lower[key]);
    if (diff !== 0) return `**${fmt(Math.abs(diff))}** ${theme.icons[key]}`;
  }
  return "a tie on trophies";
}

export function rankView(data, { theme }) {
  const mine = data.rows.filter((row) => row.is_mine);

  if (mine.length === 0) {
    return noticeView({
      tone: "info",
      title: "You're not on this server's leaderboard yet",
      body: "Link your PSN account with **/addpsn**. New accounts are ranked within a few minutes.",
    });
  }

  const containers = mine.slice(0, 3).map((row) => {
    const above = data.rows.find((r) => r.rank === row.rank - 1);
    const below = data.rows.find((r) => r.rank === row.rank + 1);
    const top = Math.max(1, Math.ceil((row.rank / Math.max(1, data.rankedCount)) * 100));
    const lines = [];

    if (row.rank === 1) lines.push("👑 **Top of the server.** Everyone is chasing you.");
    if (above) lines.push(`⬆️ ${gapText(above, row, theme)} behind **${name(above)}** (#${above.rank})`);
    if (below) lines.push(`⬇️ ${gapText(row, below, theme)} ahead of **${name(below)}** (#${below.rank})`);

    return container(
      [
        withImage(
          [
            `## ${row.rank <= 3 ? `${theme.icons.medals[row.rank - 1]} ` : ""}#${row.rank} of ${fmt(data.rankedCount)}`,
            `**${name(row)}** · top ${top}%`,
            trophyLine(row, theme),
          ].join("\n"),
          row.avatar_url,
          `${row.name} avatar`
        ),
        ...(lines.length > 0 ? [separator({ divider: false }), text(lines.join("\n"))] : []),
        text(`-# Updated ${relative(row.fetched_at)}`),
      ],
      COLORS.psn
    );
  });

  return message(containers);
}

// ---------------------------------------------------------------------------------------
// Profile.

export function profileView(data, { theme, targetUserId }) {
  const { icons } = theme;

  const containers = data.rows.slice(0, 3).map((row) => {
    const tier = tierInfo(row.tier);
    const hasStats = Number(row.fetched_at) > 0;
    const header = [
      `## ${name(row)}`,
      [mention(targetUserId), row.is_plus ? "PS Plus" : ""].filter(Boolean).join(" · "),
    ];

    if (hasStats) {
      header.push(`**Level ${row.trophy_level ?? "?"}**${tier ? ` · ${tier.name} tier ${row.tier}` : ""}`);
      if (row.progress !== null && row.progress !== undefined) {
        header.push(`${bar(row.progress)} ${row.progress}% to level ${Number(row.trophy_level || 0) + 1}`);
      }
    }

    const children = [withImage(header.filter(Boolean).join("\n"), row.avatar_url, `${row.name} avatar`)];

    if (hasStats) {
      children.push(
        text(
          [
            `${icons.platinum} **${fmt(row.platinum)}** Platinum　${icons.gold} **${fmt(row.gold)}** Gold`,
            `${icons.silver} **${fmt(row.silver)}** Silver　${icons.bronze} **${fmt(row.bronze)}** Bronze`,
            `**${fmt(row.total)}** trophies · rank **#${row.rank}** of ${fmt(data.rankedCount)} here`,
          ].join("\n")
        )
      );
      children.push(text(`-# Updated ${relative(row.fetched_at)}`));
    } else if (row.last_error === "private") {
      children.push(text("🔒 Trophies are private on PSN. Set **Trophies** to **Anyone** in PSN privacy settings to be ranked."));
    } else {
      children.push(text(`${icons.sync} Syncing — stats appear within a few minutes.`));
    }

    return container(children, tier?.color ?? COLORS.psn);
  });

  return message(containers);
}

export function linkedView({ account, stats }, { theme }) {
  const lines = [`### ✅ Linked **${escapeMarkdown(account.onlineId)}**`];

  if (stats) {
    lines.push(trophyLine(stats, theme));
    lines.push(`-# Level ${stats.trophyLevel ?? "?"} · ${fmt(stats.total)} trophies · you're on the leaderboard`);
  } else if (account.private) {
    lines.push("🔒 Your trophies are private on PSN. Set **Trophies** to **Anyone** in PSN privacy settings to be ranked.");
  } else {
    lines.push(`${theme.icons.sync} Your stats will appear on the leaderboard within a few minutes.`);
  }

  return message([container([withImage(lines.join("\n"), account.avatarUrl, `${account.onlineId} avatar`)], COLORS.success)]);
}

// ---------------------------------------------------------------------------------------
// Games.

function titleLine(title, theme, { showOwner }) {
  return [
    `**${escapeMarkdown(title.titleName)}** ${platformBadge(title.platform)}${showOwner ? ` · ${escapeMarkdown(title.psnUsername)}` : ""}`,
    `${bar(title.progress)} **${title.progress}%** · ${trophyLine(title, theme, { bold: null })}`,
    `-# Last trophy ${relative(Date.parse(title.lastUpdatedAt))}`,
  ].join("\n");
}

export function recentView({ titles, names, stale }, { theme }) {
  const showOwner = new Set(titles.map((t) => t.psnUsername)).size > 1;
  const children = [text(`## 🎮 Recent games\n-# ${names.map(escapeMarkdown).join(", ")}`)];

  for (const title of titles.slice(0, 10)) {
    children.push(withImage(titleLine(title, theme, { showOwner }), title.titleIconUrl, title.titleName));
  }

  children.push(text(`-# ${stale ? "Cached copy — PSN didn't answer just now" : `Latest ${titles.length} game${titles.length === 1 ? "" : "s"}`}`));
  return message([container(children, COLORS.psn)]);
}

export function platinumsView({ titles, owner, totalPlatinum, scanned, stale }, { theme }) {
  const header = [`## ${theme.icons.platinum} Platinum cabinet`, `**${escapeMarkdown(owner)}**${totalPlatinum !== null && totalPlatinum !== undefined ? ` · ${fmt(totalPlatinum)} platinums` : ""}`];
  const children = [text(header.join("\n"))];

  if (titles.length === 0) {
    children.push(text(`No platinums in the ${fmt(scanned)} most recently played games yet. The hunt continues.`));
    return message([container(children, COLORS.gold)]);
  }

  const art = titles.filter((title) => title.titleIconUrl).slice(0, 10);
  if (art.length > 0) {
    children.push(gallery(art.map((title) => ({ url: title.titleIconUrl, description: title.titleName }))));
  }

  children.push(
    text(
      titles
        .map((title, index) => `**${index + 1}.** ${escapeMarkdown(title.titleName)} ${platformBadge(title.platform)} · ${shortDate(Date.parse(title.lastUpdatedAt))}`)
        .join("\n")
    )
  );
  children.push(text(`-# ${stale ? "Cached copy — PSN didn't answer just now" : `Latest ${titles.length} from the ${fmt(scanned)} most recently played games`}`));
  return message([container(children, COLORS.gold)]);
}

// ---------------------------------------------------------------------------------------
// Compare.

export function compareView({ a, b }, { theme }) {
  const { icons } = theme;
  const card = (player) =>
    withImage(
      [
        `### ${escapeMarkdown(player.onlineId)}`,
        `Level **${player.stats.trophyLevel ?? "?"}** · ${fmt(player.stats.total)} trophies`,
        trophyLine(player.stats, theme),
        player.recent ? `-# Playing: ${escapeMarkdown(player.recent)}` : "",
      ].filter(Boolean).join("\n"),
      player.avatarUrl,
      `${player.onlineId} avatar`
    );

  const categories = [
    ["platinum", icons.platinum],
    ["gold", icons.gold],
    ["silver", icons.silver],
    ["bronze", icons.bronze],
    ["total", "🎯"],
  ];
  let aWins = 0;
  let bWins = 0;
  const rows = categories.map(([key, icon]) => {
    const av = Number(a.stats[key] || 0);
    const bv = Number(b.stats[key] || 0);
    if (av > bv) aWins += 1;
    if (bv > av) bWins += 1;
    return `${icon} **${fmt(av)}** ${splitBar(av, bv)} **${fmt(bv)}**`;
  });

  const verdict =
    aWins === bWins
      ? "🤝 Dead even."
      : `👑 **${escapeMarkdown(aWins > bWins ? a.onlineId : b.onlineId)}** leads ${Math.max(aWins, bWins)}–${Math.min(aWins, bWins)}`;

  return message([
    container(
      [
        text(`## ⚔️ ${escapeMarkdown(a.onlineId)} vs ${escapeMarkdown(b.onlineId)}`),
        card(a),
        card(b),
        separator(),
        text(`### Head-to-head\n${rows.join("\n")}\n\n${verdict}`),
      ],
      COLORS.psn
    ),
  ]);
}

// ---------------------------------------------------------------------------------------
// Movers, weekly posts, alerts.

export function moversView(data, { theme, title = "Weekly movers" }) {
  const { icons } = theme;
  const children = [text(`## 📈 ${title}\n-# Since ${relative(data.baselineAt)} · ${fmt(data.trackedCount)} tracked`)];

  if (data.movers.length === 0) {
    children.push(text("No new trophies since the weekly reset yet. First trophy takes the top spot."));
  } else {
    children.push(
      text(
        data.movers
          .slice(0, 10)
          .map((row, index) => {
            const gains = [
              ["platinum_gain", icons.platinum],
              ["gold_gain", icons.gold],
              ["silver_gain", icons.silver],
              ["bronze_gain", icons.bronze],
            ]
              .filter(([key]) => Number(row[key]) > 0)
              .map(([key, icon]) => `+${fmt(row[key])} ${icon}`)
              .join(" ");
            return `${rankBadge(index + 1, theme)} **${name(row)}** · ${gains} · **+${fmt(row.total_gain)}**`;
          })
          .join("\n")
      )
    );
  }

  return container(children, COLORS.success);
}

export function moversMessage(data, options) {
  return message([moversView(data, options)]);
}

export function weeklyMessage(leaderboardData, moversData, { theme, pageSize }) {
  const parts = [leaderboardView(leaderboardData, { page: 1, pageSize, theme, title: "Weekly Trophy Standings", interactive: false })];
  if (moversData.hasBaseline) parts.push(moversView(moversData, { theme, title: "Biggest movers this week" }));
  return message(parts);
}

export function platinumAlertMessage({ owner, avatarUrl, titles, platinumCount }, { theme }) {
  const containers = titles.slice(0, 3).map((title, index) =>
    container(
      [
        withImage(
          [
            `## ${theme.icons.platinum} New platinum!`,
            `**${escapeMarkdown(owner)}** just platinumed **${escapeMarkdown(title.titleName)}** ${platformBadge(title.platform)}`,
            `-# Platinum #${fmt(platinumCount - index)} · ${fmt(title.total)} trophies in this game`,
          ].join("\n"),
          title.titleIconUrl || avatarUrl,
          title.titleName
        ),
      ],
      COLORS.gold
    )
  );
  return message(containers);
}

// ---------------------------------------------------------------------------------------
// Support, admin and ops.

export function supportView({ supportUrl }) {
  const children = [
    text(
      [
        "## 💙 Support PSN Trophy Bot",
        "PSN Trophy Bot stays free for every server.",
        "Support covers hosting, PSN account upkeep and new trophy features.",
      ].join("\n")
    ),
    text(supportUrl ? "-# Any support is optional and appreciated." : "-# The support link is still being set up."),
  ];

  if (supportUrl) {
    children.push(actionRow([button({ url: supportUrl, label: "Support the bot", emoji: "💙" })]));
  }

  return message([container(children, COLORS.psn)]);
}

export function weeklyEnabledView({ channelId, nextPostAt }) {
  return noticeView({
    tone: "success",
    title: "Weekly leaderboard is on",
    body: [
      `Standings and weekly movers post in <#${channelId}> every Sunday at 16:00 UTC.`,
      `Next post: <t:${Math.floor(nextPostAt / 1000)}:F>.`,
      "New platinums are announced there too.",
    ].join("\n"),
  });
}

export function channelReadyView() {
  return message([
    container(
      [text("### 🏆 Trophy updates will appear here\n-# Weekly standings every Sunday at 16:00 UTC, plus new platinum alerts.")],
      COLORS.psn
    ),
  ]);
}

export function opsAuthView({ title, lines }) {
  return message([container([text([`## 🔑 ${title}`, ...lines].join("\n"))], COLORS.warning)]);
}

// ---------------------------------------------------------------------------------------
// Limit checks used by tests.

export function countComponents(payload) {
  let count = 0;
  let characters = 0;
  const walk = (components = []) => {
    for (const component of components) {
      count += 1;
      if (component.type === 10) characters += component.content.length;
      if (component.components) walk(component.components);
      if (component.accessory) {
        count += 1;
        walk(component.accessory.components);
      }
    }
  };
  walk(payload.components);
  return { count, characters };
}
