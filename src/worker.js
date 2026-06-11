import nacl from "tweetnacl";

const DISCORD_API_BASE_URL = "https://discord.com/api/v10";
const PSN_AUTH_BASE_URL = "https://ca.account.sony.com/api/authz/v3/oauth";
const PSN_SEARCH_BASE_URL = "https://m.np.playstation.com/api/search";
const PSN_TROPHY_BASE_URL = "https://m.np.playstation.com/api/trophy";
const PSN_USER_LEGACY_BASE_URL = "https://us-prof.np.community.playstation.net/userProfile/v1/users";

const PSN_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const RECENT_TITLES_DEFAULT_LIMIT = 5;
const RECENT_TITLES_MAX_LIMIT = 10;
const PLATINUM_SCAN_ACCOUNT_LIMIT = 100;
const PLATINUM_SCAN_TITLE_LIMIT = 100;
const LEADERBOARD_LIMIT = 10;
const PSN_BLUE = 0x006fcd;
const ADMINISTRATOR_PERMISSION = 1n << 3n;
const MANAGE_GUILD_PERMISSION = 1n << 5n;
const WEEKLY_CRON_LABEL = "Sundays at 16:00 UTC";
const WEEKLY_CRON = "0 16 * * SUN";
const HOURLY_CRON = "0 * * * *";

const InteractionType = {
  PING: 1,
  APPLICATION_COMMAND: 2,
};

const InteractionResponseType = {
  PONG: 1,
  DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: 5,
};

const CommandOptionType = {
  SUB_COMMAND: 1,
  STRING: 3,
  INTEGER: 4,
  USER: 6,
  CHANNEL: 7,
};

const ChannelType = {
  GUILD_TEXT: 0,
  GUILD_ANNOUNCEMENT: 5,
};

export const commands = [
  {
    name: "addpsn",
    description: "Link a PSN username to your Discord profile",
    type: 1,
    options: [
      {
        name: "username",
        description: "The PSN username to link",
        type: CommandOptionType.STRING,
        required: true,
      },
    ],
  },
  {
    name: "removepsn",
    description: "Remove one of your saved PSN usernames",
    type: 1,
    options: [
      {
        name: "username",
        description: "The saved PSN username to remove",
        type: CommandOptionType.STRING,
        required: true,
      },
    ],
  },
  {
    name: "leaderboard",
    description: "Show the server PSN trophy standings",
    type: 1,
  },
  {
    name: "profile",
    description: "Show saved PSN trophy profile stats",
    type: 1,
    options: [
      {
        name: "user",
        description: "Discord user to view",
        type: CommandOptionType.USER,
        required: false,
      },
    ],
  },
  {
    name: "rank",
    description: "Show your place in the server trophy standings",
    type: 1,
  },
  {
    name: "recent",
    description: "Show recent PSN games with trophy progress",
    type: 1,
    options: [
      {
        name: "user",
        description: "Discord user to view",
        type: CommandOptionType.USER,
        required: false,
      },
      {
        name: "limit",
        description: "Number of recent games to show",
        type: CommandOptionType.INTEGER,
        min_value: 1,
        max_value: RECENT_TITLES_MAX_LIMIT,
        required: false,
      },
    ],
  },
  {
    name: "movers",
    description: "Show this week's biggest trophy gains",
    type: 1,
  },
  {
    name: "weeklyleaderboard",
    description: "Manage weekly PSN trophy leaderboard posts",
    type: 1,
    default_member_permissions: "32",
    options: [
      {
        name: "set",
        description: "Choose where weekly trophy standings are posted",
        type: CommandOptionType.SUB_COMMAND,
        options: [
          {
            name: "channel",
            description: "Text channel for weekly standings",
            type: CommandOptionType.CHANNEL,
            channel_types: [ChannelType.GUILD_TEXT, ChannelType.GUILD_ANNOUNCEMENT],
            required: true,
          },
        ],
      },
      {
        name: "disable",
        description: "Turn off weekly trophy standings",
        type: CommandOptionType.SUB_COMMAND,
      },
      {
        name: "post",
        description: "Post the current trophy standings now",
        type: CommandOptionType.SUB_COMMAND,
      },
    ],
  },
];

export default {
  async fetch(request, env, ctx) {
    if (request.method === "GET") {
      return json({ ok: true, service: "psn-trophy-bot" });
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const body = await request.text();
    const signature = request.headers.get("X-Signature-Ed25519");
    const timestamp = request.headers.get("X-Signature-Timestamp");

    if (!env.DISCORD_PUBLIC_KEY || !verifyDiscordRequest(body, signature, timestamp, env.DISCORD_PUBLIC_KEY)) {
      return new Response("invalid request signature", { status: 401 });
    }

    const interaction = JSON.parse(body);

    if (interaction.type === InteractionType.PING) {
      return json({ type: InteractionResponseType.PONG });
    }

    if (interaction.type !== InteractionType.APPLICATION_COMMAND) {
      return json({
        type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
      });
    }

    ctx.waitUntil(handleCommand(interaction, env));

    return json({
      type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    });
  },

  async scheduled(event, env, ctx) {
    if (event.cron === HOURLY_CRON) {
      ctx.waitUntil(scanPlatinumAlerts(env));
      return;
    }

    ctx.waitUntil(postWeeklyLeaderboards(env));
  },
};

async function handleCommand(interaction, env) {
  try {
    await ensureDatabase(env.DB);

    if (!interaction.guild_id) {
      await editOriginalResponse(interaction, "Use this command inside a server.");
      return;
    }

    const commandName = interaction.data?.name;

    if (commandName === "addpsn") {
      await addPsn(interaction, env);
      return;
    }

    if (commandName === "removepsn") {
      await removePsn(interaction, env);
      return;
    }

    if (commandName === "leaderboard") {
      await leaderboard(interaction, env);
      return;
    }

    if (commandName === "profile") {
      await profile(interaction, env);
      return;
    }

    if (commandName === "rank") {
      await rank(interaction, env);
      return;
    }

    if (commandName === "recent") {
      await recent(interaction, env);
      return;
    }

    if (commandName === "movers") {
      await movers(interaction, env);
      return;
    }

    if (commandName === "weeklyleaderboard") {
      await weeklyLeaderboard(interaction, env);
      return;
    }

    await editOriginalResponse(interaction, "Unknown command.");
  } catch (err) {
    console.error("Command failed:", err);
    await editOriginalResponse(interaction, getPublicErrorMessage(err));
  }
}

async function addPsn(interaction, env) {
  const psnUsername = getStringOption(interaction, "username");

  if (!psnUsername) {
    await editOriginalResponse(interaction, "Please provide a PSN username.");
    return;
  }

  const tokens = await getPsnTokens(env.PSN_NPSSO);
  const psnId = await findPsnAccountId(tokens, psnUsername);

  if (!psnId) {
    await editOriginalResponse(interaction, "Could not find your PSN account.");
    return;
  }

  const guildId = interaction.guild_id;
  const discordId = getInteractionUserId(interaction);

  if (!discordId) {
    await editOriginalResponse(interaction, "Could not identify your Discord user.");
    return;
  }

  const id = buildPsnUserId(guildId, discordId, psnUsername);

  await env.DB.prepare(
    `INSERT INTO psn_users (id, discord_id, guild_id, psn_username, psn_id)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET psn_username = excluded.psn_username, psn_id = excluded.psn_id`
  )
    .bind(id, discordId, guildId, psnUsername, psnId)
    .run();

  const row = { id, discord_id: discordId, guild_id: guildId, psn_username: psnUsername, psn_id: psnId };
  let stats = null;
  let warning = "";

  try {
    const tokenProvider = async () => tokens;
    stats = await getCachedTrophyStats(env, row, { forceRefresh: true, tokenProvider });
  } catch (err) {
    warning = " Saved, but trophy stats could not be refreshed yet.";
    console.warn(`Failed to warm trophy cache for ${id}: ${err.message}`);
  }

  await editOriginalResponse(interaction, {
    content: `PSN user **${escapeMarkdown(psnUsername)}** saved.${warning}`,
    embeds: stats ? [buildProfileEmbed([stats], discordId, { title: "PSN Profile Saved" })] : [],
  });
}

async function removePsn(interaction, env) {
  const psnUsername = getStringOption(interaction, "username");

  if (!psnUsername) {
    await editOriginalResponse(interaction, "Please provide a PSN username.");
    return;
  }

  const guildId = interaction.guild_id;
  const discordId = getInteractionUserId(interaction);

  if (!discordId) {
    await editOriginalResponse(interaction, "Could not identify your Discord user.");
    return;
  }

  const id = buildPsnUserId(guildId, discordId, psnUsername);

  const existing = await env.DB.prepare("SELECT id FROM psn_users WHERE id = ? AND guild_id = ?")
    .bind(id, guildId)
    .first();

  if (!existing) {
    await editOriginalResponse(interaction, "No matching PSN username found in this server.");
    return;
  }

  await env.DB.prepare("DELETE FROM psn_users WHERE id = ? AND guild_id = ?").bind(id, guildId).run();
  await editOriginalResponse(interaction, `PSN username **${escapeMarkdown(psnUsername)}** removed from this server.`);
}

async function leaderboard(interaction, env) {
  const data = await buildLeaderboardData(env, interaction.guild_id);

  if (data.entries.length === 0) {
    await editOriginalResponse(interaction, buildNoLeaderboardPayload(data));
    return;
  }

  await editOriginalResponse(interaction, buildLeaderboardPayload(data, { title: "Server Trophy Standings" }));
}

async function profile(interaction, env) {
  const guildId = interaction.guild_id;
  const currentUserId = getInteractionUserId(interaction);
  const targetUserId = getUserOption(interaction, "user") || currentUserId;

  const { results: rows = [] } = await env.DB.prepare(
    `SELECT * FROM psn_users
     WHERE guild_id = ? AND discord_id = ?
     ORDER BY lower(psn_username)`
  )
    .bind(guildId, targetUserId)
    .all();

  if (rows.length === 0) {
    const target = targetUserId === currentUserId ? "You have" : `<@${targetUserId}> has`;
    await editOriginalResponse(interaction, `${target} no saved PSN usernames in this server. Use /addpsn first.`);
    return;
  }

  const tokenProvider = createPsnTokenProvider(env);
  const stats = [];
  const failures = [];

  for (const row of rows) {
    try {
      stats.push(await getCachedTrophyStats(env, row, { tokenProvider }));
    } catch (err) {
      failures.push(row);
      console.warn(`Failed to load profile cache for ${row.id}: ${err.message}`);
    }
  }

  if (stats.length === 0) {
    await editOriginalResponse(interaction, "Could not load trophy stats for those PSN usernames.");
    return;
  }

  await editOriginalResponse(interaction, {
    embeds: [
      buildProfileEmbed(stats, targetUserId, {
        footerParts: failures.length > 0 ? [`${failures.length} profile refresh failed`] : [],
      }),
    ],
  });
}

async function rank(interaction, env) {
  const discordId = getInteractionUserId(interaction);
  const data = await buildLeaderboardData(env, interaction.guild_id);

  const rankedEntries = data.entries
    .map((entry, index) => ({ ...entry, rank: index + 1 }))
    .filter((entry) => entry.discordId === discordId);

  if (rankedEntries.length === 0) {
    await editOriginalResponse(interaction, "You do not have any ranked PSN usernames in this server yet. Use /addpsn first.");
    return;
  }

  const fields = rankedEntries.slice(0, 25).map((entry) => ({
    name: `#${entry.rank} ${entry.psnUsername}`,
    value: formatStatsBlock(entry),
    inline: false,
  }));

  const footerParts = [
    `${data.total} registered`,
    `${data.failures.length} refresh failures`,
    `${data.staleCount} stale cache`,
  ].filter((part) => !part.startsWith("0 "));

  await editOriginalResponse(interaction, {
    embeds: [
      {
        title: "Your PSN Trophy Rank",
        color: PSN_BLUE,
        fields,
        footer: footerParts.length > 0 ? { text: footerParts.join(" | ") } : undefined,
        timestamp: data.updatedAt ? new Date(data.updatedAt).toISOString() : undefined,
      },
    ],
  });
}

async function recent(interaction, env) {
  const guildId = interaction.guild_id;
  const currentUserId = getInteractionUserId(interaction);
  const targetUserId = getUserOption(interaction, "user") || currentUserId;
  const limit = clampInteger(getIntegerOption(interaction, "limit") || RECENT_TITLES_DEFAULT_LIMIT, 1, RECENT_TITLES_MAX_LIMIT);

  const { results: rows = [] } = await env.DB.prepare(
    `SELECT *
     FROM psn_users
     WHERE guild_id = ? AND discord_id = ?
     ORDER BY lower(psn_username)`
  )
    .bind(guildId, targetUserId)
    .all();

  if (rows.length === 0) {
    const target = targetUserId === currentUserId ? "You have" : `<@${targetUserId}> has`;
    await editOriginalResponse(interaction, `${target} no saved PSN usernames in this server. Use /addpsn first.`);
    return;
  }

  const tokenProvider = createPsnTokenProvider(env);
  const titles = [];
  const failures = [];

  for (const row of rows) {
    try {
      titles.push(...(await getRecentTitleSnapshots(env, row, { limit, tokenProvider })));
    } catch (err) {
      failures.push(row);
      console.warn(`Failed to load recent titles for ${row.id}: ${err.message}`);
    }
  }

  titles.sort(compareTitleSnapshots);

  if (titles.length === 0) {
    await editOriginalResponse(interaction, "Could not load recent PSN games yet. If this keeps happening, refresh PSN_NPSSO.");
    return;
  }

  await editOriginalResponse(interaction, buildRecentPayload(titles.slice(0, limit), targetUserId, failures.length));
}

async function movers(interaction, env) {
  const leaderboardData = await buildLeaderboardData(env, interaction.guild_id);

  if (leaderboardData.entries.length === 0) {
    await editOriginalResponse(interaction, buildNoLeaderboardPayload(leaderboardData));
    return;
  }

  const moversData = await buildMoversData(env, interaction.guild_id, leaderboardData.entries);

  if (!moversData.hasBaseline) {
    await resetWeeklyBaselinesForGuild(env, interaction.guild_id, leaderboardData.entries);
    await editOriginalResponse(interaction, "Weekly movers baseline created. Check /movers again after people earn more trophies.");
    return;
  }

  await editOriginalResponse(interaction, buildMoversPayload(moversData));
}

async function weeklyLeaderboard(interaction, env) {
  if (!hasManageGuild(interaction)) {
    await editOriginalResponse(interaction, "You need Manage Server permission to manage weekly leaderboards.");
    return;
  }

  const subcommand = getSubcommand(interaction);

  if (!subcommand) {
    await editOriginalResponse(interaction, "Choose set, disable, or post.");
    return;
  }

  if (subcommand.name === "set") {
    await setWeeklyLeaderboardChannel(interaction, env, subcommand);
    return;
  }

  if (subcommand.name === "disable") {
    await disableWeeklyLeaderboard(interaction, env);
    return;
  }

  if (subcommand.name === "post") {
    await postConfiguredWeeklyLeaderboard(interaction, env);
    return;
  }

  await editOriginalResponse(interaction, "Unknown weekly leaderboard action.");
}

async function setWeeklyLeaderboardChannel(interaction, env, subcommand) {
  const channelId = getOptionValue(subcommand.options, "channel");

  if (!channelId) {
    await editOriginalResponse(interaction, "Please choose a text channel.");
    return;
  }

  const now = Date.now();

  await env.DB.prepare(
    `INSERT INTO guild_settings (guild_id, leaderboard_channel_id, weekly_leaderboard_enabled, updated_at)
     VALUES (?, ?, 1, ?)
     ON CONFLICT(guild_id) DO UPDATE SET
       leaderboard_channel_id = excluded.leaderboard_channel_id,
       weekly_leaderboard_enabled = 1,
       updated_at = excluded.updated_at`
  )
    .bind(interaction.guild_id, channelId, now)
    .run();

  await editOriginalResponse(interaction, {
    embeds: [
      {
        title: "Weekly Leaderboard Enabled",
        color: PSN_BLUE,
        description: `Weekly PSN leaderboards will post in <#${channelId}> ${WEEKLY_CRON_LABEL}.`,
      },
    ],
  });
}

async function disableWeeklyLeaderboard(interaction, env) {
  const now = Date.now();

  await env.DB.prepare(
    `INSERT INTO guild_settings (guild_id, weekly_leaderboard_enabled, updated_at)
     VALUES (?, 0, ?)
     ON CONFLICT(guild_id) DO UPDATE SET
       weekly_leaderboard_enabled = 0,
       updated_at = excluded.updated_at`
  )
    .bind(interaction.guild_id, now)
    .run();

  await editOriginalResponse(interaction, "Weekly PSN leaderboard posts are disabled for this server.");
}

async function postConfiguredWeeklyLeaderboard(interaction, env) {
  const settings = await env.DB.prepare(
    `SELECT leaderboard_channel_id
     FROM guild_settings
     WHERE guild_id = ? AND leaderboard_channel_id IS NOT NULL AND leaderboard_channel_id != ''`
  )
    .bind(interaction.guild_id)
    .first();

  if (!settings?.leaderboard_channel_id) {
    await editOriginalResponse(interaction, "Set a weekly leaderboard channel first with /weeklyleaderboard set.");
    return;
  }

  const data = await buildLeaderboardData(env, interaction.guild_id);

  if (data.entries.length === 0) {
    await editOriginalResponse(interaction, buildNoLeaderboardPayload(data));
    return;
  }

  const moversData = await buildMoversData(env, interaction.guild_id, data.entries);
  await postChannelMessage(env, settings.leaderboard_channel_id, buildWeeklyPayload(data, moversData));
  await editOriginalResponse(interaction, `Posted the current weekly PSN preview to <#${settings.leaderboard_channel_id}>.`);
}

async function postWeeklyLeaderboards(env) {
  try {
    await ensureDatabase(env.DB);

    if (!env.DISCORD_BOT_TOKEN) {
      console.warn("Skipping weekly leaderboards because DISCORD_BOT_TOKEN is missing.");
      return;
    }

    const { results: settingsRows = [] } = await env.DB.prepare(
      `SELECT guild_id, leaderboard_channel_id, last_weekly_post_at
       FROM guild_settings
       WHERE weekly_leaderboard_enabled = 1
         AND leaderboard_channel_id IS NOT NULL
         AND leaderboard_channel_id != ''`
    ).all();

    const now = Date.now();

    for (const settings of settingsRows) {
      if (wasPostedThisUtcWeek(settings.last_weekly_post_at, now)) {
        continue;
      }

      try {
        const data = await buildLeaderboardData(env, settings.guild_id);

        if (data.entries.length === 0) {
          console.log(`Skipping weekly leaderboard for ${settings.guild_id}: no trophy data.`);
          continue;
        }

        const moversData = await buildMoversData(env, settings.guild_id, data.entries);

        await postChannelMessage(
          env,
          settings.leaderboard_channel_id,
          buildWeeklyPayload(data, moversData)
        );

        await resetWeeklyBaselinesForGuild(env, settings.guild_id, data.entries);

        await env.DB.prepare(
          `UPDATE guild_settings
           SET last_weekly_post_at = ?, updated_at = ?
           WHERE guild_id = ?`
        )
          .bind(now, now, settings.guild_id)
          .run();
      } catch (err) {
        console.error(`Weekly leaderboard failed for guild ${settings.guild_id}:`, err);
      }
    }
  } catch (err) {
    console.error("Weekly leaderboard job failed:", err);
  }
}

async function buildLeaderboardData(env, guildId) {
  const { results: rows = [] } = await env.DB.prepare(
    `SELECT *
     FROM psn_users
     WHERE guild_id = ?
     ORDER BY lower(psn_username)`
  )
    .bind(guildId)
    .all();

  const tokenProvider = createPsnTokenProvider(env);
  const entries = [];
  const failures = [];

  for (const row of rows) {
    try {
      entries.push(await getCachedTrophyStats(env, row, { tokenProvider }));
    } catch (err) {
      failures.push({ row, error: err });
      console.warn(`Failed to fetch trophy summary for ${row.id}: ${err.message}`);
    }
  }

  entries.sort(compareLeaderboardEntries);

  const updatedAt = entries.reduce((latest, entry) => Math.max(latest, entry.fetchedAt || 0), 0);
  const staleCount = entries.filter((entry) => entry.isStale).length;

  return {
    entries,
    failures,
    total: rows.length,
    updatedAt,
    staleCount,
  };
}

async function getRecentTitleSnapshots(env, row, options = {}) {
  try {
    const tokenProvider = options.tokenProvider || createPsnTokenProvider(env);
    const tokens = await tokenProvider();
    const response = await getUserTitles(tokens, row.psn_id, { limit: options.limit || RECENT_TITLES_DEFAULT_LIMIT });
    const snapshots = normalizeTitleSnapshots(row, response.trophyTitles || [], Date.now());
    const existing = await getTitleSnapshotMap(env.DB, row.psn_id);
    const lastAlertedPlatinumById = new Map(
      snapshots.map((snapshot) => [
        snapshot.id,
        existing.has(snapshot.id) ? toNumber(existing.get(snapshot.id).last_alerted_platinum) : snapshot.platinum,
      ])
    );

    await upsertTitleSnapshots(env.DB, snapshots, { lastAlertedPlatinumById });

    return snapshots;
  } catch (err) {
    const cached = await getCachedTitleSnapshots(env.DB, row, options.limit || RECENT_TITLES_DEFAULT_LIMIT);

    if (cached.length > 0) {
      return cached.map((title) => ({ ...title, isStale: true }));
    }

    throw err;
  }
}

async function getCachedTitleSnapshots(db, row, limit) {
  const { results = [] } = await db.prepare(
    `SELECT *
     FROM psn_title_snapshots
     WHERE psn_id = ?
     ORDER BY last_updated_at DESC, last_seen_at DESC
     LIMIT ?`
  )
    .bind(row.psn_id, limit)
    .all();

  return results.map((title) => normalizeCachedTitleSnapshot(title, row));
}

async function upsertTitleSnapshots(db, snapshots, options = {}) {
  for (const snapshot of snapshots) {
    const lastAlertedPlatinum = options.lastAlertedPlatinumById?.get(snapshot.id);
    const fallbackAlertedPlatinum = options.baselineNewTitles ? snapshot.platinum : snapshot.lastAlertedPlatinum;

    await db.prepare(
      `INSERT INTO psn_title_snapshots (
        id,
        psn_id,
        psn_username,
        np_communication_id,
        np_service_name,
        title_name,
        title_icon_url,
        platform,
        progress,
        earned_platinum,
        earned_gold,
        earned_silver,
        earned_bronze,
        total,
        last_updated_at,
        last_seen_at,
        last_alerted_platinum
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        psn_username = excluded.psn_username,
        np_service_name = excluded.np_service_name,
        title_name = excluded.title_name,
        title_icon_url = excluded.title_icon_url,
        platform = excluded.platform,
        progress = excluded.progress,
        earned_platinum = excluded.earned_platinum,
        earned_gold = excluded.earned_gold,
        earned_silver = excluded.earned_silver,
        earned_bronze = excluded.earned_bronze,
        total = excluded.total,
        last_updated_at = excluded.last_updated_at,
        last_seen_at = excluded.last_seen_at,
        last_alerted_platinum = excluded.last_alerted_platinum`
    )
      .bind(
        snapshot.id,
        snapshot.psnId,
        snapshot.psnUsername,
        snapshot.npCommunicationId,
        snapshot.npServiceName,
        snapshot.titleName,
        snapshot.titleIconUrl,
        snapshot.platform,
        snapshot.progress,
        snapshot.platinum,
        snapshot.gold,
        snapshot.silver,
        snapshot.bronze,
        snapshot.total,
        snapshot.lastUpdatedAt,
        snapshot.lastSeenAt,
        lastAlertedPlatinum ?? fallbackAlertedPlatinum
      )
      .run();
  }
}

async function buildMoversData(env, guildId, entries) {
  const { results: baselineRows = [] } = await env.DB.prepare(
    `SELECT *
     FROM weekly_trophy_baselines
     WHERE guild_id = ?`
  )
    .bind(guildId)
    .all();

  if (baselineRows.length === 0) {
    return { hasBaseline: false, movers: [], baselineCount: 0 };
  }

  const baselineById = new Map(baselineRows.map((row) => [row.psn_user_id, row]));
  const movers = entries
    .map((entry) => {
      const baseline = baselineById.get(entry.psnUserId);

      if (!baseline) {
        return null;
      }

      return {
        ...entry,
        platinumGain: Math.max(0, entry.platinum - toNumber(baseline.platinum)),
        goldGain: Math.max(0, entry.gold - toNumber(baseline.gold)),
        silverGain: Math.max(0, entry.silver - toNumber(baseline.silver)),
        bronzeGain: Math.max(0, entry.bronze - toNumber(baseline.bronze)),
        totalGain: Math.max(0, entry.total - toNumber(baseline.total)),
      };
    })
    .filter((entry) => entry && entry.totalGain > 0)
    .sort(compareMoverEntries);

  return {
    hasBaseline: true,
    movers,
    baselineCount: baselineRows.length,
  };
}

async function resetWeeklyBaselinesForGuild(env, guildId, entries) {
  await env.DB.prepare("DELETE FROM weekly_trophy_baselines WHERE guild_id = ?").bind(guildId).run();

  const now = Date.now();

  for (const entry of entries) {
    await env.DB.prepare(
      `INSERT INTO weekly_trophy_baselines (
        id,
        guild_id,
        psn_user_id,
        psn_id,
        discord_id,
        psn_username,
        platinum,
        gold,
        silver,
        bronze,
        total,
        baseline_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        `${guildId}:${entry.psnUserId}`,
        guildId,
        entry.psnUserId,
        entry.psnId,
        entry.discordId,
        entry.psnUsername,
        entry.platinum,
        entry.gold,
        entry.silver,
        entry.bronze,
        entry.total,
        now
      )
      .run();
  }
}

async function scanPlatinumAlerts(env) {
  try {
    await ensureDatabase(env.DB);

    if (!env.DISCORD_BOT_TOKEN) {
      console.warn("Skipping platinum scan because DISCORD_BOT_TOKEN is missing.");
      return;
    }

    const accounts = await getAccountsForPlatinumScan(env.DB);

    if (accounts.length === 0) {
      return;
    }

    const tokenProvider = createPsnTokenProvider(env);
    let lastCursor = accounts[accounts.length - 1]?.psn_id || "";

    for (const account of accounts) {
      try {
        const tokens = await tokenProvider();
        const response = await getUserTitles(tokens, account.psn_id, { limit: PLATINUM_SCAN_TITLE_LIMIT });
        const snapshots = normalizeTitleSnapshots(account, response.trophyTitles || [], Date.now());
        const existing = await getTitleSnapshotMap(env.DB, account.psn_id);
        const lastAlertedPlatinumById = new Map();
        const alerts = [];

        for (const snapshot of snapshots) {
          const previous = existing.get(snapshot.id);
          const previousAlerted = previous ? toNumber(previous.last_alerted_platinum) : snapshot.platinum;
          const previousPlatinum = previous ? toNumber(previous.earned_platinum) : snapshot.platinum;
          const shouldAlert = Boolean(previous) && snapshot.platinum > previousAlerted && snapshot.platinum > previousPlatinum;

          lastAlertedPlatinumById.set(snapshot.id, shouldAlert ? snapshot.platinum : previousAlerted);

          if (shouldAlert) {
            alerts.push({
              ...snapshot,
              platinumGain: snapshot.platinum - Math.max(previousAlerted, previousPlatinum),
            });
          }
        }

        await upsertTitleSnapshots(env.DB, snapshots, { baselineNewTitles: true, lastAlertedPlatinumById });

        if (alerts.length > 0) {
          await postPlatinumAlertsForAccount(env, account.psn_id, alerts);
        }
      } catch (err) {
        if (isPsnAuthError(err)) {
          console.warn("Skipping platinum scan because PSN authentication failed. Refresh PSN_NPSSO.");
          return;
        }

        console.error(`Platinum scan failed for ${account.psn_id}:`, err);
      }
    }

    await setJobState(env.DB, "platinum_scan_cursor", lastCursor);
  } catch (err) {
    console.error("Platinum scan job failed:", err);
  }
}

async function getAccountsForPlatinumScan(db) {
  const cursor = (await getJobState(db, "platinum_scan_cursor")) || "";
  const rows = [];

  const { results: afterCursor = [] } = await db.prepare(
    `SELECT psn_id, MIN(psn_username) AS psn_username
     FROM psn_users
     WHERE psn_id > ?
     GROUP BY psn_id
     ORDER BY psn_id
     LIMIT ?`
  )
    .bind(cursor, PLATINUM_SCAN_ACCOUNT_LIMIT)
    .all();

  rows.push(...afterCursor);

  if (rows.length < PLATINUM_SCAN_ACCOUNT_LIMIT) {
    const { results: wrapped = [] } = await db.prepare(
      `SELECT psn_id, MIN(psn_username) AS psn_username
       FROM psn_users
       GROUP BY psn_id
       ORDER BY psn_id
       LIMIT ?`
    )
      .bind(PLATINUM_SCAN_ACCOUNT_LIMIT - rows.length)
      .all();

    const seen = new Set(rows.map((row) => row.psn_id));
    rows.push(...wrapped.filter((row) => !seen.has(row.psn_id)));
  }

  return rows;
}

async function postPlatinumAlertsForAccount(env, psnId, alerts) {
  const { results: targets = [] } = await env.DB.prepare(
    `SELECT DISTINCT
       u.guild_id,
       u.psn_username,
       g.leaderboard_channel_id
     FROM psn_users u
     INNER JOIN guild_settings g ON g.guild_id = u.guild_id
     WHERE u.psn_id = ?
       AND g.weekly_leaderboard_enabled = 1
       AND g.leaderboard_channel_id IS NOT NULL
       AND g.leaderboard_channel_id != ''`
  )
    .bind(psnId)
    .all();

  for (const target of targets) {
    try {
      await postChannelMessage(env, target.leaderboard_channel_id, buildPlatinumAlertPayload(target.psn_username, alerts));
    } catch (err) {
      console.error(`Failed to post platinum alert for guild ${target.guild_id}:`, err);
    }
  }
}

async function getTitleSnapshotMap(db, psnId) {
  const { results = [] } = await db.prepare("SELECT * FROM psn_title_snapshots WHERE psn_id = ?")
    .bind(psnId)
    .all();

  return new Map(results.map((row) => [row.id, row]));
}

async function getJobState(db, key) {
  const row = await db.prepare("SELECT value FROM job_state WHERE key = ?").bind(key).first();
  return row?.value || "";
}

async function setJobState(db, key, value) {
  await db.prepare(
    `INSERT INTO job_state (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  )
    .bind(key, value, Date.now())
    .run();
}

async function getCachedTrophyStats(env, row, options = {}) {
  const now = Date.now();
  const cached = await env.DB.prepare("SELECT * FROM psn_trophy_cache WHERE psn_id = ?")
    .bind(row.psn_id)
    .first();

  if (!options.forceRefresh && isFreshCache(cached, now)) {
    return normalizeCachedStats(cached, row, { isStale: false });
  }

  try {
    const tokenProvider = options.tokenProvider || createPsnTokenProvider(env);
    const tokens = await tokenProvider();
    const summary = await getUserTrophyProfileSummary(tokens, row.psn_id);
    const stats = statsFromPsnSummary(summary, row, now);

    await env.DB.prepare(
      `INSERT INTO psn_trophy_cache (
        psn_id,
        psn_username,
        trophy_level,
        progress,
        platinum,
        gold,
        silver,
        bronze,
        total,
        fetched_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(psn_id) DO UPDATE SET
        psn_username = excluded.psn_username,
        trophy_level = excluded.trophy_level,
        progress = excluded.progress,
        platinum = excluded.platinum,
        gold = excluded.gold,
        silver = excluded.silver,
        bronze = excluded.bronze,
        total = excluded.total,
        fetched_at = excluded.fetched_at`
    )
      .bind(
        stats.psnId,
        stats.psnUsername,
        stats.trophyLevel,
        stats.progress,
        stats.platinum,
        stats.gold,
        stats.silver,
        stats.bronze,
        stats.total,
        stats.fetchedAt
      )
      .run();

    return stats;
  } catch (err) {
    if (cached) {
      const stale = normalizeCachedStats(cached, row, { isStale: true });
      stale.refreshError = err.message;
      return stale;
    }

    throw err;
  }
}

function statsFromPsnSummary(summary, row, fetchedAt) {
  const earned = summary.earnedTrophies || {};
  const platinum = toNumber(earned.platinum);
  const gold = toNumber(earned.gold);
  const silver = toNumber(earned.silver);
  const bronze = toNumber(earned.bronze);

  return {
    psnUserId: row.id,
    psnId: row.psn_id,
    psnUsername: row.psn_username,
    discordId: row.discord_id,
    guildId: row.guild_id,
    trophyLevel: nullableNumber(summary.trophyLevel),
    progress: nullableNumber(summary.progress),
    platinum,
    gold,
    silver,
    bronze,
    total: platinum + gold + silver + bronze,
    fetchedAt,
    fromCache: false,
    isStale: false,
  };
}

function normalizeCachedStats(cached, row, { isStale }) {
  return {
    psnUserId: row.id,
    psnId: row.psn_id || cached.psn_id,
    psnUsername: row.psn_username || cached.psn_username,
    discordId: row.discord_id,
    guildId: row.guild_id,
    trophyLevel: nullableNumber(cached.trophy_level),
    progress: nullableNumber(cached.progress),
    platinum: toNumber(cached.platinum),
    gold: toNumber(cached.gold),
    silver: toNumber(cached.silver),
    bronze: toNumber(cached.bronze),
    total: toNumber(cached.total),
    fetchedAt: toNumber(cached.fetched_at),
    fromCache: true,
    isStale,
  };
}

function normalizeTitleSnapshots(row, titles, lastSeenAt) {
  return titles.map((title) => titleSnapshotFromPsnTitle(row, title, lastSeenAt));
}

function titleSnapshotFromPsnTitle(row, title, lastSeenAt) {
  const earned = title.earnedTrophies || {};
  const platinum = toNumber(earned.platinum);
  const gold = toNumber(earned.gold);
  const silver = toNumber(earned.silver);
  const bronze = toNumber(earned.bronze);
  const npCommunicationId = title.npCommunicationId || "unknown";

  return {
    id: `${row.psn_id}:${npCommunicationId}`,
    psnId: row.psn_id,
    psnUsername: row.psn_username,
    npCommunicationId,
    npServiceName: title.npServiceName || "",
    titleName: title.trophyTitleName || "Unknown title",
    titleIconUrl: title.trophyTitleIconUrl || "",
    platform: title.trophyTitlePlatform || "",
    progress: toNumber(title.progress),
    platinum,
    gold,
    silver,
    bronze,
    total: platinum + gold + silver + bronze,
    lastUpdatedAt: title.lastUpdatedDateTime || "",
    lastSeenAt,
    lastAlertedPlatinum: platinum,
    isStale: false,
  };
}

function normalizeCachedTitleSnapshot(title, row) {
  return {
    id: title.id,
    psnId: title.psn_id,
    psnUsername: row.psn_username || title.psn_username,
    npCommunicationId: title.np_communication_id,
    npServiceName: title.np_service_name,
    titleName: title.title_name,
    titleIconUrl: title.title_icon_url,
    platform: title.platform,
    progress: toNumber(title.progress),
    platinum: toNumber(title.earned_platinum),
    gold: toNumber(title.earned_gold),
    silver: toNumber(title.earned_silver),
    bronze: toNumber(title.earned_bronze),
    total: toNumber(title.total),
    lastUpdatedAt: title.last_updated_at || "",
    lastSeenAt: toNumber(title.last_seen_at),
    lastAlertedPlatinum: toNumber(title.last_alerted_platinum),
    isStale: false,
  };
}

function buildLeaderboardPayload(data, { title }) {
  const topEntries = data.entries.slice(0, LEADERBOARD_LIMIT);
  const leader = topEntries[0];
  const fields = [
    {
      name: "Current leader",
      value: formatLeaderSummary(leader),
      inline: false,
    },
    {
      name: "Standings",
      value: formatLeaderboardTable(topEntries),
      inline: false,
    },
  ];

  const footerParts = [
    `${data.total} registered`,
    `Showing top ${topEntries.length}`,
    data.failures.length > 0 ? `${data.failures.length} refresh failed` : "",
    data.staleCount > 0 ? `${data.staleCount} using stale cache` : "",
  ].filter(Boolean);

  return {
    embeds: [
      {
        title,
        color: PSN_BLUE,
        description: "Ranked by platinum, then gold, silver, bronze.",
        fields,
        footer: { text: footerParts.join(" | ") },
        timestamp: data.updatedAt ? new Date(data.updatedAt).toISOString() : undefined,
      },
    ],
  };
}

function buildWeeklyPayload(leaderboardData, moversData) {
  const leaderboardPayload = buildLeaderboardPayload(leaderboardData, { title: "Weekly Trophy Standings" });
  const moversPayload = buildMoversPayload(moversData, { compact: true });

  return {
    embeds: [
      ...leaderboardPayload.embeds,
      ...moversPayload.embeds,
    ].slice(0, 10),
  };
}

function buildRecentPayload(titles, discordId, failureCount) {
  const embeds = titles.slice(0, 10).map((title, index) => ({
    title: title.titleName,
    color: PSN_BLUE,
    description: [
      `**${escapeMarkdown(title.psnUsername)}**`,
      title.platform ? `Platform: ${escapeMarkdown(title.platform)}` : "",
      `Progress: **${title.progress}%**`,
      formatTrophyCounts(title),
      title.lastUpdatedAt ? `Last update: ${formatDiscordTimestamp(Date.parse(title.lastUpdatedAt))}` : "",
      title.isStale ? "Showing cached data because PSN refresh failed." : "",
    ].filter(Boolean).join("\n"),
    thumbnail: title.titleIconUrl ? { url: title.titleIconUrl } : undefined,
    footer: {
      text: [
        `Recent game ${index + 1} of ${titles.length}`,
        failureCount > 0 ? `${failureCount} profile refresh failed` : "",
      ].filter(Boolean).join(" | "),
    },
  }));

  if (embeds.length > 0) {
    embeds[0].author = { name: `Recent PSN activity for Discord user ${discordId}` };
  }

  return { embeds };
}

function buildMoversPayload(data, options = {}) {
  if (!data.hasBaseline) {
    return {
      embeds: [
        {
          title: "Weekly Movers",
          color: PSN_BLUE,
          description: "No weekly baseline exists yet. The bot will start tracking gains from the next baseline.",
        },
      ],
    };
  }

  if (data.movers.length === 0) {
    return {
      embeds: [
        {
          title: "Weekly Movers",
          color: PSN_BLUE,
          description: "No trophy gains recorded since the current weekly baseline.",
          footer: { text: `${data.baselineCount} profiles tracked` },
        },
      ],
    };
  }

  return {
    embeds: [
      {
        title: options.compact ? "Biggest Movers This Week" : "Weekly Trophy Movers",
        color: PSN_BLUE,
        description: "Ranked by platinum gains, then total trophy gains.",
        fields: [
          {
            name: "Gains",
            value: formatMoversTable(data.movers.slice(0, LEADERBOARD_LIMIT)),
            inline: false,
          },
        ],
        footer: { text: `${data.baselineCount} profiles tracked` },
      },
    ],
  };
}

function buildPlatinumAlertPayload(psnUsername, alerts) {
  return {
    content: `New platinum trophy detected for **${escapeMarkdown(psnUsername)}**.`,
    embeds: alerts.slice(0, 10).map((alert) => ({
      title: alert.titleName,
      color: 0xd6af36,
      description: [
        `**${escapeMarkdown(psnUsername)}** earned ${alert.platinumGain > 1 ? `${alert.platinumGain} new platinums` : "a new platinum"}.`,
        alert.platform ? `Platform: ${escapeMarkdown(alert.platform)}` : "",
        `Progress: **${alert.progress}%**`,
        formatTrophyCounts(alert),
        alert.lastUpdatedAt ? `Last update: ${formatDiscordTimestamp(Date.parse(alert.lastUpdatedAt))}` : "",
      ].filter(Boolean).join("\n"),
      thumbnail: alert.titleIconUrl ? { url: alert.titleIconUrl } : undefined,
    })),
  };
}

function buildNoLeaderboardPayload(data) {
  if (data.total === 0) {
    return "No PSN usernames are saved for this server yet. Use /addpsn first.";
  }

  return "No trophy data could be loaded for this server yet. Try again later.";
}

function buildProfileEmbed(stats, discordId, options = {}) {
  const fields = stats.slice(0, 25).map((entry) => ({
    name: entry.psnUsername,
    value: formatStatsBlock(entry),
    inline: false,
  }));

  const newestFetchedAt = stats.reduce((latest, entry) => Math.max(latest, entry.fetchedAt || 0), 0);
  const staleCount = stats.filter((entry) => entry.isStale).length;
  const footerParts = [
    `${stats.length} PSN profile${stats.length === 1 ? "" : "s"}`,
    staleCount > 0 ? `${staleCount} using stale cache` : "",
    ...(options.footerParts || []),
  ].filter(Boolean);

  return {
    title: options.title || "PSN Trophy Profile",
    color: PSN_BLUE,
    description: `<@${discordId}>`,
    fields,
    footer: footerParts.length > 0 ? { text: footerParts.join(" | ") } : undefined,
    timestamp: newestFetchedAt ? new Date(newestFetchedAt).toISOString() : undefined,
  };
}

function formatLeaderSummary(entry) {
  return `**${escapeMarkdown(entry.psnUsername)}** leads with **${formatNumber(entry.platinum)}** platinum trophies and **${formatNumber(entry.total)}** total trophies.`;
}

function formatLeaderboardTable(entries) {
  const rows = [
    `${padCell("Rank", 5)} ${padCell("PSN", 16)} ${padLeft("Plat", 4)} ${padLeft("Gold", 4)} ${padLeft("Silv", 4)} ${padLeft("Brnz", 6)} ${padLeft("Total", 8)}`,
    `${padCell("----", 5)} ${padCell("---------------", 16)} ${padLeft("----", 4)} ${padLeft("----", 4)} ${padLeft("----", 4)} ${padLeft("------", 6)} ${padLeft("------", 8)}`,
    ...entries.map((entry, index) =>
      [
        padCell(`#${index + 1}`, 5),
        padCell(truncateTableText(entry.psnUsername, 16), 16),
        padLeft(formatNumber(entry.platinum), 4),
        padLeft(formatNumber(entry.gold), 4),
        padLeft(formatNumber(entry.silver), 4),
        padLeft(formatNumber(entry.bronze), 6),
        padLeft(formatNumber(entry.total), 8),
      ].join(" ")
    ),
  ];

  return `\`\`\`text\n${rows.join("\n")}\n\`\`\``;
}

function formatMoversTable(entries) {
  const rows = [
    `${padCell("Rank", 5)} ${padCell("PSN", 16)} ${padLeft("+P", 3)} ${padLeft("+G", 3)} ${padLeft("+S", 3)} ${padLeft("+B", 4)} ${padLeft("+Total", 6)}`,
    `${padCell("----", 5)} ${padCell("---------------", 16)} ${padLeft("--", 3)} ${padLeft("--", 3)} ${padLeft("--", 3)} ${padLeft("---", 4)} ${padLeft("------", 6)}`,
    ...entries.map((entry, index) =>
      [
        padCell(`#${index + 1}`, 5),
        padCell(truncateTableText(entry.psnUsername, 16), 16),
        padLeft(formatSignedNumber(entry.platinumGain), 3),
        padLeft(formatSignedNumber(entry.goldGain), 3),
        padLeft(formatSignedNumber(entry.silverGain), 3),
        padLeft(formatSignedNumber(entry.bronzeGain), 4),
        padLeft(formatSignedNumber(entry.totalGain), 6),
      ].join(" ")
    ),
  ];

  return `\`\`\`text\n${rows.join("\n")}\n\`\`\``;
}

function formatStatsBlock(entry) {
  const lines = [
    formatLevel(entry),
    `${formatTrophyCounts(entry)} | Total ${entry.total}`,
    `Updated ${formatDiscordTimestamp(entry.fetchedAt)}${entry.isStale ? " (stale)" : ""}`,
  ];

  return lines.join("\n");
}

function formatLevel(entry) {
  if (entry.trophyLevel === null) {
    return "Level unknown";
  }

  if (entry.progress === null) {
    return `Level ${entry.trophyLevel}`;
  }

  return `Level ${entry.trophyLevel} (${entry.progress}%)`;
}

function formatTrophyCounts(entry) {
  return `Platinum ${formatNumber(entry.platinum)} | Gold ${formatNumber(entry.gold)} | Silver ${formatNumber(entry.silver)} | Bronze ${formatNumber(entry.bronze)}`;
}

function formatDiscordTimestamp(timestampMs) {
  if (!timestampMs) {
    return "unknown";
  }

  return `<t:${Math.floor(timestampMs / 1000)}:R>`;
}

function compareLeaderboardEntries(a, b) {
  return (
    b.platinum - a.platinum ||
    b.gold - a.gold ||
    b.silver - a.silver ||
    b.bronze - a.bronze ||
    a.psnUsername.localeCompare(b.psnUsername)
  );
}

function compareMoverEntries(a, b) {
  return (
    b.platinumGain - a.platinumGain ||
    b.totalGain - a.totalGain ||
    b.goldGain - a.goldGain ||
    b.silverGain - a.silverGain ||
    b.bronzeGain - a.bronzeGain ||
    a.psnUsername.localeCompare(b.psnUsername)
  );
}

function compareTitleSnapshots(a, b) {
  const aUpdated = Date.parse(a.lastUpdatedAt || "") || 0;
  const bUpdated = Date.parse(b.lastUpdatedAt || "") || 0;

  return bUpdated - aUpdated || b.lastSeenAt - a.lastSeenAt || a.titleName.localeCompare(b.titleName);
}

async function ensureDatabase(db) {
  await db.batch([
    db.prepare(
      `CREATE TABLE IF NOT EXISTS psn_users (
        id TEXT PRIMARY KEY,
        discord_id TEXT NOT NULL,
        guild_id TEXT NOT NULL,
        psn_username TEXT NOT NULL,
        psn_id TEXT NOT NULL
      )`
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS psn_trophy_cache (
        psn_id TEXT PRIMARY KEY,
        psn_username TEXT NOT NULL,
        trophy_level INTEGER,
        progress INTEGER,
        platinum INTEGER NOT NULL DEFAULT 0,
        gold INTEGER NOT NULL DEFAULT 0,
        silver INTEGER NOT NULL DEFAULT 0,
        bronze INTEGER NOT NULL DEFAULT 0,
        total INTEGER NOT NULL DEFAULT 0,
        fetched_at INTEGER NOT NULL
      )`
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS guild_settings (
        guild_id TEXT PRIMARY KEY,
        leaderboard_channel_id TEXT,
        weekly_leaderboard_enabled INTEGER NOT NULL DEFAULT 0,
        last_weekly_post_at INTEGER,
        updated_at INTEGER NOT NULL
      )`
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS psn_title_snapshots (
        id TEXT PRIMARY KEY,
        psn_id TEXT NOT NULL,
        psn_username TEXT NOT NULL,
        np_communication_id TEXT NOT NULL,
        np_service_name TEXT,
        title_name TEXT NOT NULL,
        title_icon_url TEXT,
        platform TEXT,
        progress INTEGER NOT NULL DEFAULT 0,
        earned_platinum INTEGER NOT NULL DEFAULT 0,
        earned_gold INTEGER NOT NULL DEFAULT 0,
        earned_silver INTEGER NOT NULL DEFAULT 0,
        earned_bronze INTEGER NOT NULL DEFAULT 0,
        total INTEGER NOT NULL DEFAULT 0,
        last_updated_at TEXT,
        last_seen_at INTEGER NOT NULL,
        last_alerted_platinum INTEGER NOT NULL DEFAULT 0
      )`
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS weekly_trophy_baselines (
        id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        psn_user_id TEXT NOT NULL,
        psn_id TEXT NOT NULL,
        discord_id TEXT NOT NULL,
        psn_username TEXT NOT NULL,
        platinum INTEGER NOT NULL DEFAULT 0,
        gold INTEGER NOT NULL DEFAULT 0,
        silver INTEGER NOT NULL DEFAULT 0,
        bronze INTEGER NOT NULL DEFAULT 0,
        total INTEGER NOT NULL DEFAULT 0,
        baseline_at INTEGER NOT NULL
      )`
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS job_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )`
    ),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_psn_users_guild_id ON psn_users (guild_id)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_psn_users_discord_guild ON psn_users (guild_id, discord_id)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_psn_title_snapshots_psn_id ON psn_title_snapshots (psn_id)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_weekly_trophy_baselines_guild_id ON weekly_trophy_baselines (guild_id)"),
  ]);
}

function createPsnTokenProvider(env) {
  let tokenPromise = null;

  return async () => {
    if (!tokenPromise) {
      tokenPromise = getPsnTokens(env.PSN_NPSSO);
    }

    return tokenPromise;
  };
}

async function getPsnTokens(npsso) {
  if (!npsso) {
    throw new Error("Missing PSN_NPSSO");
  }

  const code = await exchangeNpssoForAccessCode(npsso);
  return exchangeAccessCodeForAuthTokens(code);
}

async function exchangeNpssoForAccessCode(npsso) {
  const queryString = new URLSearchParams({
    access_type: "offline",
    client_id: "09515159-7237-4370-9b40-3806e67c0891",
    redirect_uri: "com.scee.psxandroid.scecompcall://redirect",
    response_type: "code",
    scope: "psn:mobile.v2.core psn:clientapp",
  }).toString();

  const res = await fetch(`${PSN_AUTH_BASE_URL}/authorize?${queryString}`, {
    headers: { Cookie: `npsso=${npsso}` },
    redirect: "manual",
  });

  const location = res.headers.get("location");

  if (!location || !location.includes("code=")) {
    throw new Error("Could not retrieve PSN access code. Refresh PSN_NPSSO.");
  }

  const redirectPart = location.split("redirect/")[1] || location;
  const redirectQueryString = redirectPart.includes("?") ? redirectPart.split("?")[1] : redirectPart;
  const code = new URLSearchParams(redirectQueryString).get("code");

  if (!code) {
    throw new Error("Could not parse PSN access code. Refresh PSN_NPSSO.");
  }

  return code;
}

async function exchangeAccessCodeForAuthTokens(accessCode) {
  const res = await fetch(`${PSN_AUTH_BASE_URL}/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization:
        "Basic MDk1MTUxNTktNzIzNy00MzcwLTliNDAtMzgwNmU2N2MwODkxOnVjUGprYTV0bnRCMktxc1A=",
    },
    body: new URLSearchParams({
      code: accessCode,
      redirect_uri: "com.scee.psxandroid.scecompcall://redirect",
      grant_type: "authorization_code",
      token_format: "jwt",
    }).toString(),
  });

  if (!res.ok) {
    throw new Error(`PSN token exchange failed: ${res.status}`);
  }

  const raw = await res.json();

  return {
    accessToken: raw.access_token,
    expiresIn: raw.expires_in,
    idToken: raw.id_token,
    refreshToken: raw.refresh_token,
    refreshTokenExpiresIn: raw.refresh_token_expires_in,
    scope: raw.scope,
    tokenType: raw.token_type,
  };
}

async function findPsnAccountId(tokens, username) {
  const response = await psnFetch(
    `${PSN_SEARCH_BASE_URL}/v1/universalSearch`,
    tokens,
    {
      method: "POST",
      body: JSON.stringify({
        searchTerm: username,
        domainRequests: [{ domain: "SocialAllAccounts" }],
      }),
    }
  );

  const results = response?.domainResponses
    ?.find((item) => item.domain === "SocialAllAccounts")
    ?.results || [];

  const normalizedUsername = username.toLowerCase();
  const exactMatch = results.find(
    (result) => result.socialMetadata?.onlineId?.toLowerCase() === normalizedUsername
  );

  if (exactMatch?.socialMetadata?.accountId) {
    return exactMatch.socialMetadata.accountId;
  }

  try {
    const legacyAccountId = await findPsnAccountIdWithLegacyProfile(tokens, username);

    if (legacyAccountId) {
      return legacyAccountId;
    }
  } catch (err) {
    console.warn(`Legacy PSN profile lookup failed for ${username}: ${err.message}`);
  }

  return results[0]?.socialMetadata?.accountId;
}

async function findPsnAccountIdWithLegacyProfile(tokens, username) {
  const fields = "npId,onlineId,accountId";
  const profile = await psnFetch(
    `${PSN_USER_LEGACY_BASE_URL}/${encodeURIComponent(username)}/profile2?${new URLSearchParams({ fields })}`,
    tokens
  );

  return profile?.profile?.accountId;
}

async function getUserTrophyProfileSummary(tokens, accountId) {
  return psnFetch(`${PSN_TROPHY_BASE_URL}/v1/users/${accountId}/trophySummary`, tokens);
}

async function getUserTitles(tokens, accountId, options = {}) {
  const query = new URLSearchParams();

  if (options.limit) {
    query.set("limit", String(options.limit));
  }

  if (options.offset) {
    query.set("offset", String(options.offset));
  }

  const queryString = query.toString();
  const url = `${PSN_TROPHY_BASE_URL}/v1/users/${accountId}/trophyTitles${queryString ? `?${queryString}` : ""}`;
  return psnFetch(url, tokens);
}

async function psnFetch(url, tokens, options = {}) {
  const res = await fetch(url, {
    method: options.method || "GET",
    headers: {
      Authorization: `Bearer ${tokens.accessToken}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    body: options.body,
  });

  if (!res.ok) {
    throw new Error(`PSN request failed: ${res.status}`);
  }

  return res.json();
}

async function postChannelMessage(env, channelId, payload) {
  if (!env.DISCORD_BOT_TOKEN) {
    throw new Error("Missing DISCORD_BOT_TOKEN");
  }

  const res = await fetch(`${DISCORD_API_BASE_URL}/channels/${channelId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(normalizeDiscordPayload(payload)),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Discord channel message failed: ${res.status} ${text.slice(0, 300)}`);
  }

  return res.json();
}

async function editOriginalResponse(interaction, payload) {
  const res = await fetch(
    `${DISCORD_API_BASE_URL}/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(normalizeDiscordPayload(payload)),
    }
  );

  if (!res.ok) {
    console.error(`Failed to edit Discord response: ${res.status}`);
  }
}

function normalizeDiscordPayload(payload) {
  if (typeof payload === "string") {
    return {
      content: truncateDiscordMessage(payload),
      allowed_mentions: { parse: [] },
    };
  }

  return {
    content: payload.content ? truncateDiscordMessage(payload.content) : undefined,
    embeds: payload.embeds || undefined,
    components: payload.components || undefined,
    allowed_mentions: payload.allowed_mentions || { parse: [] },
  };
}

function getStringOption(interaction, name) {
  return getOptionValue(getActiveOptions(interaction), name)?.trim();
}

function getIntegerOption(interaction, name) {
  const value = getOptionValue(getActiveOptions(interaction), name);
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

function getUserOption(interaction, name) {
  return getOptionValue(getActiveOptions(interaction), name);
}

function getSubcommand(interaction) {
  return interaction.data?.options?.find((option) => option.type === CommandOptionType.SUB_COMMAND);
}

function getActiveOptions(interaction) {
  const subcommand = getSubcommand(interaction);
  return subcommand?.options || interaction.data?.options || [];
}

function getOptionValue(options = [], name) {
  return options.find((option) => option.name === name)?.value;
}

function getInteractionUserId(interaction) {
  return interaction.member?.user?.id || interaction.user?.id;
}

function buildPsnUserId(guildId, discordId, psnUsername) {
  return `${guildId}:${discordId}:${psnUsername.toLowerCase()}`;
}

function hasManageGuild(interaction) {
  try {
    const permissions = BigInt(interaction.member?.permissions || 0);
    return (
      (permissions & MANAGE_GUILD_PERMISSION) === MANAGE_GUILD_PERMISSION ||
      (permissions & ADMINISTRATOR_PERMISSION) === ADMINISTRATOR_PERMISSION
    );
  } catch {
    return false;
  }
}

function wasPostedThisUtcWeek(lastPostAt, now) {
  if (!lastPostAt) {
    return false;
  }

  return getUtcWeekStartMs(Number(lastPostAt)) === getUtcWeekStartMs(now);
}

function getUtcWeekStartMs(timestamp) {
  const date = new Date(timestamp);
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  start.setUTCDate(start.getUTCDate() - start.getUTCDay());
  return start.getTime();
}

function isFreshCache(cached, now) {
  if (!cached?.fetched_at) {
    return false;
  }

  return now - Number(cached.fetched_at) < PSN_CACHE_TTL_MS;
}

function nullableNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toNumber(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatNumber(value) {
  return toNumber(value).toLocaleString("en-US");
}

function formatSignedNumber(value) {
  return `+${formatNumber(value)}`;
}

function clampInteger(value, min, max) {
  return Math.min(max, Math.max(min, Number.isInteger(value) ? value : min));
}

function truncateTableText(value, maxLength) {
  const text = String(value);

  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength - 1)}.`;
}

function padCell(value, width) {
  return String(value).padEnd(width, " ");
}

function padLeft(value, width) {
  return String(value).padStart(width, " ");
}

function escapeMarkdown(value) {
  return String(value).replace(/[\\`*_{}[\]()#+\-.!|>]/g, "\\$&");
}

function getPublicErrorMessage(err) {
  if (isPsnAuthError(err)) {
    return "PSN authentication failed. Refresh the Cloudflare secret PSN_NPSSO, then try again.";
  }

  return "Something went wrong while handling that command.";
}

function isPsnAuthError(err) {
  const message = String(err?.message || err || "").toLowerCase();

  return (
    message.includes("psn_npsso") ||
    message.includes("psn token exchange failed") ||
    message.includes("psn authentication") ||
    message.includes("psn access code") ||
    message.includes("refresh psn_npsso")
  );
}

function verifyDiscordRequest(body, signature, timestamp, publicKey) {
  if (!signature || !timestamp || !publicKey) return false;

  try {
    return nacl.sign.detached.verify(
      new TextEncoder().encode(timestamp + body),
      hexToUint8Array(signature),
      hexToUint8Array(publicKey)
    );
  } catch {
    return false;
  }
}

function hexToUint8Array(hex) {
  const matches = hex.match(/.{1,2}/g) || [];
  return new Uint8Array(matches.map((byte) => Number.parseInt(byte, 16)));
}

function truncateDiscordMessage(message) {
  return message.length <= 1900 ? message : `${message.slice(0, 1897)}...`;
}

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
}
