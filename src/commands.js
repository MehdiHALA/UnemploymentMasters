// Slash command definitions and handlers. Every handler has a fixed worst-case cost in
// subrequests, independent of how many accounts a server has linked:
//   - "sync" handlers read D1 only and answer within Discord's 3 s window;
//   - "defer" handlers talk to PSN and finish within the waitUntil() budget.

import {
  LEADERBOARD_PAGE_SIZE,
  MINUTE_MS,
  ONLINE_ID_PATTERN,
  PLATINUMS_DEFAULT_LIMIT,
  PLATINUMS_MAX_LIMIT,
  PLATINUMS_SCAN_TITLES,
  RECENT_DEFAULT_LIMIT,
  RECENT_MAX_LIMIT,
} from "./config.js";
import * as db from "./db.js";
import * as pdb from "./db-premium.js";
import { linkCap } from "./premium.js";
import {
  getFocusedOption,
  getIntegerOption,
  getOption,
  getStringOption,
  getSubcommand,
  getUserId,
  hasManageGuild,
  OptionType,
  postChannelMessage,
  ResponseType,
} from "./discord.js";
import { acquirePsn, fetchTitles, fetchTrophySummary, psnAllowance, PsnError, refreshAccounts, resolveAccount } from "./psn.js";
import { clampInteger, mapLimit, nextWeeklyPostSlot, toNumber, UserError } from "./runtime.js";
import * as ui from "./ui.js";

const ChannelType = { GUILD_TEXT: 0, GUILD_ANNOUNCEMENT: 5 };
const GUILD_ONLY = { contexts: [0], integration_types: [0] };

const onlineIdOption = (name, description, extra = {}) => ({
  name,
  description,
  type: OptionType.STRING,
  min_length: 3,
  max_length: 16,
  ...extra,
});

export const commands = [
  {
    name: "addpsn",
    description: "Link your PSN account to this server's leaderboard",
    type: 1,
    ...GUILD_ONLY,
    options: [onlineIdOption("username", "Your exact PSN Online ID", { required: true })],
  },
  {
    name: "removepsn",
    description: "Unlink a PSN account from this server",
    type: 1,
    ...GUILD_ONLY,
    options: [
      onlineIdOption("username", "The linked Online ID to remove", { required: true, autocomplete: true }),
      { name: "user", description: "Moderators: remove another member's account", type: OptionType.USER, required: false },
    ],
  },
  { name: "leaderboard", description: "Show the server PSN trophy standings", type: 1, ...GUILD_ONLY },
  { name: "support", description: "Support the free PSN Trophy Bot", type: 1, ...GUILD_ONLY },
  {
    name: "profile",
    description: "Show a member's PSN trophy card",
    type: 1,
    ...GUILD_ONLY,
    options: [{ name: "user", description: "Member to view", type: OptionType.USER, required: false }],
  },
  { name: "rank", description: "Show your place in the server trophy standings", type: 1, ...GUILD_ONLY },
  {
    name: "recent",
    description: "Show recently played PSN games with trophy progress",
    type: 1,
    ...GUILD_ONLY,
    options: [
      { name: "user", description: "Member to view", type: OptionType.USER, required: false },
      { name: "limit", description: "Number of games to show", type: OptionType.INTEGER, min_value: 1, max_value: RECENT_MAX_LIMIT, required: false },
    ],
  },
  { name: "movers", description: "Show this week's biggest trophy gains", type: 1, ...GUILD_ONLY },
  {
    name: "platinums",
    description: "Show the latest platinum trophies",
    type: 1,
    ...GUILD_ONLY,
    options: [
      onlineIdOption("username", "Any PSN Online ID (defaults to your linked accounts)", { required: false }),
      { name: "limit", description: "Number of platinums to show", type: OptionType.INTEGER, min_value: 1, max_value: PLATINUMS_MAX_LIMIT, required: false },
    ],
  },
  {
    name: "compare",
    description: "Compare two PSN players head-to-head",
    type: 1,
    ...GUILD_ONLY,
    options: [
      onlineIdOption("username1", "First PSN Online ID", { required: true }),
      onlineIdOption("username2", "Second PSN Online ID", { required: true }),
    ],
  },
  {
    name: "weeklyleaderboard",
    description: "Manage weekly leaderboard posts and platinum alerts",
    type: 1,
    ...GUILD_ONLY,
    default_member_permissions: "32",
    options: [
      {
        name: "set",
        description: "Choose where weekly standings and platinum alerts are posted",
        type: OptionType.SUB_COMMAND,
        options: [
          {
            name: "channel",
            description: "Text channel for weekly standings",
            type: OptionType.CHANNEL,
            channel_types: [ChannelType.GUILD_TEXT, ChannelType.GUILD_ANNOUNCEMENT],
            required: true,
          },
        ],
      },
      { name: "disable", description: "Turn off weekly standings and platinum alerts", type: OptionType.SUB_COMMAND },
      { name: "post", description: "Post the current standings now", type: OptionType.SUB_COMMAND },
    ],
  },
];

// ---------------------------------------------------------------------------------------
// Small shared helpers.

const throttles = new Map();

// Best-effort, per-isolate throttle; the shared PSN limiter in D1 is the real safety net.
function throttle(key, intervalMs) {
  const now = Date.now();
  if (throttles.size > 5000) throttles.clear();
  const last = throttles.get(key) || 0;
  if (now - last < intervalMs) return false;
  throttles.set(key, now);
  return true;
}

export function resetThrottlesForTests() {
  throttles.clear();
}

function requireOnlineId(value) {
  if (!ONLINE_ID_PATTERN.test(value)) {
    throw new UserError(
      `"${value}" isn't a valid PSN Online ID`,
      "Online IDs are 3–16 characters (letters, numbers, `-` and `_`) and start with a letter."
    );
  }
  return value;
}

function cooldown(interaction, command, seconds = 10) {
  if (!throttle(`${command}:${getUserId(interaction)}`, seconds * 1000)) {
    throw new UserError("Slow down a little", `You can use **/${command}** again in a few seconds.`, { tone: "info" });
  }
}

function notLinked(targetUserId, selfId) {
  return new UserError(
    targetUserId === selfId ? "You haven't linked a PSN account here yet" : "That member hasn't linked a PSN account here",
    "Use **/addpsn** to join this server's leaderboard.",
    { tone: "info" }
  );
}

const byLastUpdatedDesc = (a, b) => (Date.parse(b.lastUpdatedAt || "") || 0) - (Date.parse(a.lastUpdatedAt || "") || 0);

function titleFromSnapshot(row) {
  return {
    id: row.id,
    psnId: row.psn_id,
    psnUsername: row.psn_username,
    npCommunicationId: row.np_communication_id,
    titleName: row.title_name,
    titleIconUrl: row.title_icon_url,
    platform: row.platform,
    progress: toNumber(row.progress),
    platinum: toNumber(row.earned_platinum),
    gold: toNumber(row.earned_gold),
    silver: toNumber(row.earned_silver),
    bronze: toNumber(row.earned_bronze),
    total: toNumber(row.total),
    lastUpdatedAt: row.last_updated_at || "",
  };
}

function statsFromCacheRow(row) {
  return {
    trophyLevel: row.trophy_level,
    progress: row.progress,
    tier: row.tier,
    platinum: toNumber(row.platinum),
    gold: toNumber(row.gold),
    silver: toNumber(row.silver),
    bronze: toNumber(row.bronze),
    total: toNumber(row.total),
  };
}

// Refreshes stale accounts of one server after a leaderboard reply (bounded, throttled).
async function topUpGuild(ctx, guildId) {
  if (!throttle(`topup:${guildId}`, 2 * MINUTE_MS)) return;
  const limit = Math.min(6, ctx.budget.remaining() - 5);
  if (limit <= 0) return;

  const due = await db.getDueAccounts(ctx, Date.now(), limit, guildId);
  if (due.length === 0) return;

  try {
    if ((await acquirePsn(ctx, due.length)) > 0) await refreshAccounts(ctx, due);
  } catch (err) {
    if (!(err instanceof PsnError)) throw err;
  }
}

export function normalizeSupportUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : "";
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------------------
// Command handlers.

export const handlers = {
  leaderboard: {
    mode: "sync",
    async run(ctx, interaction) {
      const data = await db.getLeaderboardPage(ctx, interaction.guild_id, 1, LEADERBOARD_PAGE_SIZE);
      return {
        payload: ui.leaderboardMessage(data, { page: 1, pageSize: LEADERBOARD_PAGE_SIZE, theme: ctx.theme }),
        after: () => topUpGuild(ctx, interaction.guild_id),
      };
    },
  },

  rank: {
    mode: "sync",
    async run(ctx, interaction) {
      const data = await db.getRankNeighborhood(ctx, interaction.guild_id, getUserId(interaction));
      return { payload: ui.rankView(data, { theme: ctx.theme }) };
    },
  },

  profile: {
    mode: "sync",
    async run(ctx, interaction) {
      const selfId = getUserId(interaction);
      const targetId = getOption(interaction, "user") || selfId;
      let data = await db.getMemberAccounts(ctx, interaction.guild_id, targetId);

      if (data.rows.length === 0) throw notLinked(targetId, selfId);

      const staleBefore = Date.now() - ctx.settings.cacheTtlMs;
      const stale = data.rows
        .filter((row) => row.last_error !== "private" && Number(row.fetched_at) < staleBefore)
        .map((row) => ({ psn_id: row.psn_id, psn_username: row.name, fail_count: 0 }));

      if (stale.length > 0 && throttle(`profile:${targetId}`, MINUTE_MS)) {
        try {
          if ((await acquirePsn(ctx, stale.length)) > 0) {
            const { refreshed } = await refreshAccounts(ctx, stale);
            if (refreshed.length > 0) data = await db.getMemberAccounts(ctx, interaction.guild_id, targetId);
          }
        } catch (err) {
          if (!(err instanceof PsnError)) throw err;
        }
      }

      return { payload: ui.profileView(data, { theme: ctx.theme, targetUserId: targetId }) };
    },
  },

  movers: {
    mode: "sync",
    async run(ctx, interaction) {
      const data = await db.getMovers(ctx, interaction.guild_id, LEADERBOARD_PAGE_SIZE);

      if (!data.hasBaseline) {
        await ctx.db.batch(db.resetBaselineStatements(ctx, interaction.guild_id, Date.now()));
        return {
          payload: ui.noticeView(
            {
              tone: "success",
              title: "Weekly tracking started",
              body: "Every trophy earned from now on counts. Check **/movers** again once people have played a bit.",
            },
            { ephemeral: false }
          ),
        };
      }

      return { payload: ui.moversMessage(data, { theme: ctx.theme }) };
    },
  },

  support: {
    mode: "sync",
    async run(ctx) {
      // The Platinum buy button only appears once the SKU is confirmed on sale, and not where
      // Platinum is already active.
      const skuId = ctx.premium ? "" : ctx.buySkuId || "";
      return { payload: ui.supportView({ supportUrl: normalizeSupportUrl(ctx.settings.supportUrl), skuId }) };
    },
  },

  removepsn: {
    mode: "sync",
    ephemeral: true,
    async run(ctx, interaction) {
      const name = getStringOption(interaction, "username");
      const selfId = getUserId(interaction);
      const targetId = getOption(interaction, "user") || selfId;

      if (targetId !== selfId && !hasManageGuild(interaction)) {
        throw new UserError("Only moderators can remove someone else's account", "That needs the **Manage Server** permission.");
      }

      const links = await db.getMemberLinks(ctx, interaction.guild_id, targetId);
      const match = links.find((link) =>
        [link.psn_username, link.cache_name].some((value) => value && value.toLowerCase() === name.toLowerCase())
      );

      if (!match) {
        const linked = [...new Set(links.map((link) => link.cache_name || link.psn_username))];
        throw new UserError(
          `No linked account called "${name}"`,
          linked.length > 0 ? `Linked here: ${linked.map((n) => `**${ui.escapeMarkdown(n)}**`).join(", ")}` : "There are no linked accounts to remove.",
          { tone: "info" }
        );
      }

      await ctx.db.batch(db.unlinkStatements(ctx, { guildId: interaction.guild_id, discordId: targetId, psnId: match.psn_id }));
      const display = ui.escapeMarkdown(match.cache_name || match.psn_username);

      return {
        payload: ui.noticeView({
          tone: "success",
          title: `Unlinked ${display}`,
          body: targetId === selfId ? "That account is off this server's leaderboard." : `Removed from <@${targetId}>.`,
        }),
      };
    },
  },

  weeklyleaderboard: {
    mode: "sync",
    ephemeral: true,
    async run(ctx, interaction) {
      if (!hasManageGuild(interaction)) {
        throw new UserError("You need the Manage Server permission", "Ask a server admin to manage weekly posts.");
      }

      const guildId = interaction.guild_id;
      const subcommand = getSubcommand(interaction)?.name;
      const now = Date.now();

      if (subcommand === "set") {
        const channelId = String(getOption(interaction, "channel") || "");
        const probe = await postChannelMessage(ctx, channelId, ui.channelReadyView());

        if (!probe.ok) throw channelProblem(probe.error, channelId);

        await db.enableWeeklyStatement(ctx, guildId, channelId, now).run();
        return { payload: ui.weeklyEnabledView({ channelId, nextPostAt: nextWeeklyPostSlot(now) }) };
      }

      if (subcommand === "disable") {
        await db.disableWeeklyStatement(ctx, guildId, now).run();
        return {
          payload: ui.noticeView({ tone: "success", title: "Weekly posts are off", body: "Weekly standings and platinum alerts won't be posted anymore." }),
        };
      }

      if (subcommand === "post") {
        const settings = await db.getGuildSettings(ctx, guildId);
        const channelId = settings?.leaderboard_channel_id;

        if (!channelId) {
          throw new UserError("No channel set yet", "Pick one with **/weeklyleaderboard set** first.", { tone: "info" });
        }

        const { board, movers } = await db.getWeeklyData(ctx, guildId, LEADERBOARD_PAGE_SIZE);
        const result = await postChannelMessage(ctx, channelId, ui.weeklyMessage(board, movers, { theme: ctx.theme, pageSize: LEADERBOARD_PAGE_SIZE }));

        if (!result.ok) throw channelProblem(result.error, channelId);

        return { payload: ui.noticeView({ tone: "success", title: "Posted", body: `Current standings are up in <#${channelId}>.` }) };
      }

      throw new UserError("Choose set, disable or post");
    },
  },

  addpsn: {
    mode: "defer",
    async run(ctx, interaction) {
      const raw = requireOnlineId(getStringOption(interaction, "username"));
      const guildId = interaction.guild_id;
      const userId = getUserId(interaction);
      const links = await db.getMemberLinks(ctx, guildId, userId);
      const sameName = (link) => [link.psn_username, link.cache_name].some((n) => n && n.toLowerCase() === raw.toLowerCase());

      if (links.some(sameName)) {
        throw new UserError(`${raw} is already linked`, "You're already on this server's leaderboard with that account.", { tone: "info" });
      }

      const cap = linkCap(ctx, interaction);
      if (links.length >= cap) {
        throw new UserError(`You can link up to ${cap} accounts per server`, "Remove one with **/removepsn** to link another.");
      }

      cooldown(interaction, "addpsn");
      await acquirePsn(ctx, 3);
      const account = await resolveAccount(ctx, raw);

      if (!account.found) {
        throw new UserError(`Couldn't find "${raw}" on PSN`, "It must be the exact Online ID shown on the PSN profile.", {
          suggestions: account.suggestions,
        });
      }

      if (links.some((link) => link.psn_id === account.psnId)) {
        throw new UserError(`${account.onlineId} is already linked`, "You're already on this server's leaderboard with that account.", { tone: "info" });
      }

      const taken = await db.findGuildLink(ctx, guildId, account.psnId);
      if (taken && taken.discord_id !== userId) {
        throw new UserError("Someone here already linked that account", `<@${taken.discord_id}> linked **${ui.escapeMarkdown(account.onlineId)}** in this server.`);
      }

      let stats = null;
      let privateTrophies = false;

      if (psnAllowance(ctx) > 0) {
        try {
          stats = await fetchTrophySummary(ctx, account.psnId);
        } catch (err) {
          if (!(err instanceof PsnError)) throw err;
          privateTrophies = err.code === "private";
        }
      }

      const now = Date.now();
      const linkId = `${guildId}:${userId}:${account.onlineId.toLowerCase()}`;
      const statements = [
        db.linkStatement(ctx, { id: linkId, discordId: userId, guildId, name: account.onlineId, psnId: account.psnId, now }),
        db.identityStatement(ctx, { psnId: account.psnId, name: account.onlineId, avatarUrl: account.avatarUrl, isPlus: account.isPlus, tracked: true, now }),
        db.usernameCacheStatement(ctx, { name: account.onlineId, psnId: account.psnId, now }),
      ];

      if (stats) {
        statements.push(
          db.statsStatement(ctx, { psnId: account.psnId, name: account.onlineId, stats, now, nextRefreshAt: now + ctx.settings.cacheTtlMs, tracked: true }),
          db.joinBaselineStatement(ctx, { guildId, linkId, psnId: account.psnId, discordId: userId, name: account.onlineId, stats, now }),
          ...(ctx.premium ? [pdb.joinMonthlyBaselineStatement(ctx, { guildId, psnId: account.psnId, stats, now })] : [])
        );
      } else if (privateTrophies) {
        statements.push(db.refreshFailureStatement(ctx, { psnId: account.psnId, error: "private", nextRefreshAt: now + 12 * 60 * MINUTE_MS }));
      }

      await ctx.db.batch(statements);
      return { payload: ui.linkedView({ account: { ...account, private: privateTrophies }, stats }, { theme: ctx.theme }) };
    },
  },

  recent: {
    mode: "defer",
    async run(ctx, interaction) {
      const selfId = getUserId(interaction);
      const targetId = getOption(interaction, "user") || selfId;
      const limit = clampInteger(getIntegerOption(interaction, "limit") ?? RECENT_DEFAULT_LIMIT, 1, RECENT_MAX_LIMIT, RECENT_DEFAULT_LIMIT);
      const { rows } = await db.getMemberAccounts(ctx, interaction.guild_id, targetId);

      if (rows.length === 0) throw notLinked(targetId, selfId);

      const accounts = rows.slice(0, 3);
      let titles = [];
      let stale = false;

      cooldown(interaction, "recent", 5);

      try {
        await acquirePsn(ctx, accounts.length);
        const usable = accounts.slice(0, psnAllowance(ctx));
        const results = await mapLimit(usable, 3, (row) => fetchTitles(ctx, row.psn_id, { limit }));

        results.forEach((result, index) => {
          if (result.ok) titles.push(...result.value.titles.map((title) => ({ ...title, psnUsername: usable[index].name })));
        });

        if (titles.length > 0) {
          const now = Date.now();
          await ctx.db.batch(titles.map((title) => db.snapshotStatement(ctx, title, now)));
        }
      } catch (err) {
        if (!(err instanceof PsnError)) throw err;
      }

      if (titles.length === 0) {
        titles = (await db.getCachedSnapshots(ctx, accounts.map((row) => row.psn_id), { limit })).map(titleFromSnapshot);
        stale = true;
      }

      if (titles.length === 0) {
        throw new UserError("Couldn't load recent games", "PSN didn't answer and there's no saved copy yet. Try again in a few minutes.");
      }

      titles.sort(byLastUpdatedDesc);
      return {
        payload: ui.recentView({ titles: titles.slice(0, limit), names: accounts.map((row) => row.name), stale }, { theme: ctx.theme }),
      };
    },
  },

  platinums: {
    mode: "defer",
    async run(ctx, interaction) {
      const username = getStringOption(interaction, "username");
      const limit = clampInteger(getIntegerOption(interaction, "limit") ?? PLATINUMS_DEFAULT_LIMIT, 1, PLATINUMS_MAX_LIMIT, PLATINUMS_DEFAULT_LIMIT);
      const now = Date.now();
      const statements = [];
      let accounts;
      let tracked;

      cooldown(interaction, "platinums", 10);

      if (username) {
        requireOnlineId(username);
        await acquirePsn(ctx, 3);
        const account = await resolveAccount(ctx, username);

        if (!account.found) {
          throw new UserError(`Couldn't find "${username}" on PSN`, "It must be the exact Online ID.", { suggestions: account.suggestions });
        }

        if (!account.fromCache) statements.push(db.usernameCacheStatement(ctx, { name: account.onlineId, psnId: account.psnId, now }));
        const [cacheRow] = await db.getCacheRows(ctx, [account.psnId]);
        tracked = Number(cacheRow?.tracked || 0) === 1;
        accounts = [{ psn_id: account.psnId, name: account.onlineId, platinum: Number(cacheRow?.fetched_at) > 0 ? cacheRow.platinum : null }];
      } else {
        const { rows } = await db.getMemberAccounts(ctx, interaction.guild_id, getUserId(interaction));
        if (rows.length === 0) {
          throw new UserError("You haven't linked a PSN account here yet", "Use **/addpsn**, or run **/platinums username:** with any Online ID.", { tone: "info" });
        }
        tracked = true;
        accounts = rows.slice(0, 3).map((row) => ({ psn_id: row.psn_id, name: row.name, platinum: Number(row.fetched_at) > 0 ? row.platinum : null }));
        await acquirePsn(ctx, accounts.length);
      }

      const scan = accounts.length === 1 ? PLATINUMS_SCAN_TITLES : Math.floor(PLATINUMS_SCAN_TITLES / 2);
      const usable = accounts.slice(0, psnAllowance(ctx));
      const results = await mapLimit(usable, 3, (account) => fetchTitles(ctx, account.psn_id, { limit: scan }));
      let titles = [];

      results.forEach((result, index) => {
        if (result.ok) {
          titles.push(...result.value.titles.filter((title) => title.platinum > 0).map((title) => ({ ...title, psnUsername: usable[index].name })));
        } else if (!(result.error instanceof PsnError)) {
          throw result.error;
        }
      });

      let stale = false;
      if (titles.length === 0 && results.every((result) => !result.ok)) {
        const cached = await db.getCachedSnapshots(ctx, accounts.map((account) => account.psn_id), { limit, platinumOnly: true });
        titles = cached.map(titleFromSnapshot);
        stale = true;
        if (titles.length === 0) {
          const firstError = results.find((result) => !result.ok)?.error;
          throw firstError || new UserError("PlayStation is busy", "Try again in a few minutes.");
        }
      }

      titles.sort(byLastUpdatedDesc);

      if (tracked && !stale) {
        statements.push(...titles.slice(0, 50).map((title) => db.snapshotStatement(ctx, title, now)));
      }

      if (statements.length > 0) await ctx.db.batch(statements);

      const knownTotals = accounts.map((account) => account.platinum).filter((value) => value !== null && value !== undefined);
      return {
        payload: ui.platinumsView(
          {
            titles: titles.slice(0, limit),
            owner: accounts.map((account) => account.name).join(", "),
            totalPlatinum: knownTotals.length === accounts.length ? knownTotals.reduce((sum, value) => sum + Number(value), 0) : null,
            scanned: scan * usable.length,
            stale,
          },
          { theme: ctx.theme }
        ),
      };
    },
  },

  compare: {
    mode: "defer",
    async run(ctx, interaction) {
      const names = [requireOnlineId(getStringOption(interaction, "username1")), requireOnlineId(getStringOption(interaction, "username2"))];

      if (names[0].toLowerCase() === names[1].toLowerCase()) {
        throw new UserError("Pick two different players", "Comparing someone with themselves is always a tie.", { tone: "info" });
      }

      cooldown(interaction, "compare", 10);
      await acquirePsn(ctx, 6);
      const resolved = [];

      for (const name of names) {
        const account = await resolveAccount(ctx, name);
        if (!account.found) {
          throw new UserError(`Couldn't find "${name}" on PSN`, "It must be the exact Online ID.", { suggestions: account.suggestions });
        }
        resolved.push(account);
      }

      const now = Date.now();
      const cacheRows = new Map((await db.getCacheRows(ctx, resolved.map((a) => a.psnId))).map((row) => [String(row.psn_id), row]));
      const statements = [];

      const players = await Promise.all(
        resolved.map(async (account) => {
          const cached = cacheRows.get(account.psnId);
          let stats = Number(cached?.fetched_at) > now - ctx.settings.cacheTtlMs ? statsFromCacheRow(cached) : null;

          if (!stats && psnAllowance(ctx) > 0) {
            try {
              stats = await fetchTrophySummary(ctx, account.psnId);
              statements.push(db.statsStatement(ctx, { psnId: account.psnId, name: account.onlineId, stats, now, nextRefreshAt: now + ctx.settings.cacheTtlMs }));
            } catch (err) {
              if (!(err instanceof PsnError)) throw err;
              if (err.code === "private") {
                throw new UserError(`${account.onlineId}'s trophies are private`, "They need to set **Trophies** to **Anyone** in PSN privacy settings.");
              }
            }
          }

          if (!stats && Number(cached?.fetched_at) > 0) stats = statsFromCacheRow(cached);
          if (!stats) throw new UserError("PlayStation is busy", "Couldn't load both profiles right now. Try again in a few minutes.");

          let recent = "";
          if (psnAllowance(ctx) > 0) {
            try {
              recent = (await fetchTitles(ctx, account.psnId, { limit: 1 })).titles[0]?.titleName || "";
            } catch (err) {
              if (!(err instanceof PsnError)) throw err;
            }
          }

          if (!account.fromCache) statements.push(db.usernameCacheStatement(ctx, { name: account.onlineId, psnId: account.psnId, now }));

          return { onlineId: account.onlineId, avatarUrl: account.avatarUrl || cached?.avatar_url || null, stats, recent };
        })
      );

      if (statements.length > 0) await ctx.db.batch(statements);
      return { payload: ui.compareView({ a: players[0], b: players[1] }, { theme: ctx.theme }) };
    },
  },
};

function channelProblem(error, channelId) {
  const messages = {
    missing_access: `I can't post in <#${channelId}>. Give me **View Channel** and **Send Messages** there, then try again. If that doesn't help, re-invite the bot with the **bot** scope (not only commands).`,
    unknown_channel: "That channel doesn't exist anymore.",
    missing_bot_token: "The bot's `DISCORD_BOT_TOKEN` secret isn't configured, so it can't post to channels yet.",
    rate_limited: "Discord is rate limiting the bot. Try again in a minute.",
    discord_unavailable: "Discord didn't answer. Try again in a minute.",
  };
  return new UserError("Couldn't post to that channel", messages[error] || "Discord rejected the message. Try again in a minute.", { tone: "danger" });
}

// ---------------------------------------------------------------------------------------
// Buttons on the leaderboard: ◀ / ▶ pages, 🔄 refresh, 📍 "where am I".

export const componentHandlers = {
  lb: {
    responseFor(action) {
      return action === "me" ? "reply" : "update";
    },
    async run(ctx, interaction, { action, arg }) {
      const guildId = interaction.guild_id;

      if (action === "me") {
        const data = await db.getRankNeighborhood(ctx, guildId, getUserId(interaction));
        const payload = ui.rankView(data, { theme: ctx.theme });
        return { payload: { ...payload, flags: payload.flags | 64 } };
      }

      if (action === "page" || action === "refresh") {
        let page = clampInteger(arg, 1, 100000, 1);
        let data = await db.getLeaderboardPage(ctx, guildId, page, LEADERBOARD_PAGE_SIZE);
        const pageCount = Math.max(1, Math.ceil(data.rankedCount / LEADERBOARD_PAGE_SIZE));

        if (page > pageCount) {
          page = pageCount;
          data = await db.getLeaderboardPage(ctx, guildId, page, LEADERBOARD_PAGE_SIZE);
        }

        return {
          payload: ui.leaderboardMessage(data, { page, pageSize: LEADERBOARD_PAGE_SIZE, theme: ctx.theme }),
          after: action === "refresh" ? () => topUpGuild(ctx, guildId) : undefined,
        };
      }

      return { replyType: ResponseType.DEFERRED_UPDATE };
    },
  },
};

// ---------------------------------------------------------------------------------------
// Autocomplete.

export const autocompleteHandlers = {
  async removepsn(ctx, interaction) {
    const selfId = getUserId(interaction);
    const requested = getOption(interaction, "user");
    const targetId = requested && hasManageGuild(interaction) ? requested : selfId;
    const query = String(getFocusedOption(interaction)?.value || "").toLowerCase();
    const links = await db.getMemberLinks(ctx, interaction.guild_id, targetId);

    return [...new Set(links.map((link) => link.cache_name || link.psn_username))]
      .filter((value) => value.toLowerCase().includes(query))
      .slice(0, 25)
      .map((value) => ({ name: value, value }));
  },
};
