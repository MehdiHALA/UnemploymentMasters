// Platinum (premium) commands. They are registered only in Platinum servers (plus /admin in
// the owner's server), so other servers never see them. Each handler re-checks Platinum in
// case it expired since registration.

import { DAY_MS, HISTORY_DAYS, MAX_MILESTONES, RACE_MAX_DAYS } from "./config.js";
import { commands } from "./commands.js";
import * as db from "./db.js";
import * as pdb from "./db-premium.js";
import {
  getApplication,
  getFocusedOption,
  getGuild,
  getIntegerOption,
  getOption,
  getStringOption,
  getSubcommand,
  getSubcommandGroup,
  getUserId,
  hasManageGuild,
  OptionType,
  putCommands,
} from "./discord.js";
import { forgetGuild, grantStatements, guildTitles, isOwner, monthKey, premiumGuildIds } from "./premium.js";
import * as pui from "./premium-ui.js";
import { sha256Hex, UserError, weeklySlot } from "./runtime.js";
import { noticeView } from "./ui.js";

const sub = (name, description, options) => ({ type: OptionType.SUB_COMMAND, name, description, ...(options ? { options } : {}) });
const titleOption = (name, description) => ({ type: OptionType.STRING, name, description, required: true, autocomplete: true, max_length: 100 });

export const PREMIUM_COMMANDS = [
  {
    name: "platinum",
    description: "Platinum perks and settings for this server",
    type: 1,
    default_member_permissions: "32",
    options: [
      sub("status", "Show this server's Platinum perks and settings"),
      sub("color", "Set the accent colour of the bot's messages", [
        { type: OptionType.STRING, name: "hex", description: "Colour like #ff8800", required: true, min_length: 6, max_length: 7 },
      ]),
      sub("emojis", "Use your own trophy emojis", [
        { type: OptionType.STRING, name: "platinum", description: "Platinum emoji", required: false, max_length: 64 },
        { type: OptionType.STRING, name: "gold", description: "Gold emoji", required: false, max_length: 64 },
        { type: OptionType.STRING, name: "silver", description: "Silver emoji", required: false, max_length: 64 },
        { type: OptionType.STRING, name: "bronze", description: "Bronze emoji", required: false, max_length: 64 },
      ]),
      sub("weekly", "Choose when weekly standings are posted (UTC)", [
        {
          type: OptionType.INTEGER,
          name: "day",
          description: "Day of the week",
          required: true,
          choices: pui.WEEKDAYS.map((label, value) => ({ name: label, value })),
        },
        { type: OptionType.INTEGER, name: "hour", description: "Hour, 0-23 UTC", required: true, min_value: 0, max_value: 23 },
      ]),
      sub("hunter", "Role for each month's top trophy hunter (leave empty to turn off)", [
        { type: OptionType.ROLE, name: "role", description: "Hunter of the Month role", required: false },
      ]),
      {
        type: OptionType.SUB_COMMAND_GROUP,
        name: "milestone",
        description: "Roles for platinum milestones",
        options: [
          sub("add", "Give a role when a member reaches a platinum count", [
            { type: OptionType.INTEGER, name: "platinums", description: "Platinum count", required: true, min_value: 1, max_value: 100000 },
            { type: OptionType.ROLE, name: "role", description: "Role to give", required: true },
          ]),
          sub("remove", "Remove a milestone", [
            { type: OptionType.INTEGER, name: "platinums", description: "Platinum count of the milestone", required: true, min_value: 1, max_value: 100000 },
          ]),
          sub("list", "Show milestone roles"),
        ],
      },
      sub("export", "Download this server's leaderboard as a spreadsheet (CSV)"),
    ],
  },
  { name: "monthly", description: "This month's trophy standings", type: 1 },
  {
    name: "race",
    description: "Platinum races between members",
    type: 1,
    options: [
      sub("start", "Start a race to platinum a game (Manage Server)", [
        titleOption("game", "A game members have played"),
        { type: OptionType.INTEGER, name: "days", description: "How long the race lasts", required: true, min_value: 1, max_value: RACE_MAX_DAYS },
      ]),
      sub("join", "Join the current race"),
      sub("leave", "Leave the current race"),
      sub("status", "Show the race standings"),
      sub("end", "End the current race now (Manage Server)"),
    ],
  },
  { name: "game", description: "Leaderboard for one game in this server", type: 1, options: [titleOption("title", "A game members have played")] },
  {
    name: "history",
    description: "Trophy progress over the last 8 weeks",
    type: 1,
    options: [{ type: OptionType.USER, name: "user", description: "Member to view", required: false }],
  },
];

export const OWNER_COMMANDS = [
  {
    name: "admin",
    description: "Bot owner tools",
    type: 1,
    default_member_permissions: "8",
    options: [
      sub("stats", "Servers, links, Platinum and health"),
      sub("grant", "Give a server Platinum", [
        { type: OptionType.STRING, name: "server_id", description: "Server ID", required: true, min_length: 15, max_length: 25 },
        { type: OptionType.INTEGER, name: "days", description: "Days (empty = no end date)", required: false, min_value: 1, max_value: 3650 },
        { type: OptionType.STRING, name: "note", description: "Why (e.g. founder, test)", required: false, max_length: 100 },
      ]),
      sub("revoke", "Remove Platinum from a server", [
        { type: OptionType.STRING, name: "server_id", description: "Server ID", required: true, min_length: 15, max_length: 25 },
      ]),
      sub("list", "Servers with Platinum"),
    ],
  },
];

// ---------------------------------------------------------------------------------------
// Command registration: global commands for everyone, Platinum commands only in Platinum
// servers, /admin only in the owner's server. Uses the bot's own token; runs when the
// definitions or the set of Platinum servers change.

const EMPTY = "empty";
const GUILD_KEY = "commands_hash:guild:";
// A rejected registration (bad definitions, bot not in the server) is retried every 6 hours;
// rate limits and Discord outages on the next run.
const RETRY_FAILED_MS = 6 * 60 * 60 * 1000;

async function hashOf(list) {
  return list.length === 0 ? EMPTY : (await sha256Hex(JSON.stringify(list))).slice(0, 16);
}

function upToDate(current, hash, now) {
  if (current === hash) return true;
  const failed = /^failed:([^:]+):(\d+)$/.exec(current || "");
  return Boolean(failed && failed[1] === hash && now - Number(failed[2]) < RETRY_FAILED_MS);
}

const transient = (status) => status === 0 || status === 429 || status >= 500;

export function guildCommandsFor(ctx, guildId, premiumIds) {
  return [
    ...(premiumIds.has(guildId) ? PREMIUM_COMMANDS : []),
    ...(guildId === ctx.settings.ownerGuildId ? OWNER_COMMANDS : []),
  ];
}

export async function loadCommandState(ctx) {
  const { results = [] } = await ctx.db
    .prepare("SELECT key, value FROM job_state WHERE key = 'application_id' OR key LIKE 'commands_hash:%'")
    .all();
  return new Map(results.map((row) => [row.key, row.value]));
}

export async function syncCommands(ctx, { state, updates, premiumIds, onlyGuild = null, force = false, maxGuilds = 4 }) {
  if (!ctx.env.DISCORD_BOT_TOKEN) return { synced: 0, failed: 0 };

  let appId = state.get("application_id");
  if (!appId) {
    const app = await getApplication(ctx);
    if (!app.ok || !app.data?.id) return { synced: 0, failed: 1 };
    appId = String(app.data.id);
    state.set("application_id", appId);
    updates.set("application_id", appId);
  }

  const now = ctx.now ?? Date.now();
  let synced = 0;
  let failed = 0;

  if (!onlyGuild) {
    const hash = await hashOf(commands);
    if (!upToDate(state.get("commands_hash:global"), hash, now)) {
      const result = await putCommands(ctx, appId, commands);
      if (result.ok) {
        updates.set("commands_hash:global", hash);
        synced += 1;
      } else {
        failed += 1;
        console.warn(`Global command sync failed: ${result.status} ${result.detail || ""}`);
        if (!transient(result.status)) updates.set("commands_hash:global", `failed:${hash}:${now}`);
      }
    }
  }

  const guilds = new Set(onlyGuild ? [onlyGuild] : [...premiumIds, ctx.settings.ownerGuildId]);
  if (!onlyGuild) {
    for (const key of state.keys()) if (key.startsWith(GUILD_KEY)) guilds.add(key.slice(GUILD_KEY.length));
  }

  let attempts = 0;
  for (const guildId of guilds) {
    if (attempts >= maxGuilds) break;
    const list = guildCommandsFor(ctx, guildId, premiumIds);
    const hash = await hashOf(list);
    const key = `${GUILD_KEY}${guildId}`;
    const current = state.get(key);
    if (!force && (upToDate(current, hash, now) || (!current && hash === EMPTY))) continue;

    attempts += 1;
    const result = await putCommands(ctx, appId, list, guildId);
    if (result.ok) {
      synced += 1;
      updates.set(key, hash);
      state.set(key, hash);
    } else {
      failed += 1;
      console.warn(`Command sync for ${guildId} failed: ${result.status} ${result.detail || ""}`);
      // e.g. the bot isn't in that server (403/404): don't retry every run.
      if (!transient(result.status)) updates.set(key, `failed:${hash}:${now}`);
    }
  }

  return { synced, failed };
}

async function syncOneGuild(ctx, guildId, now) {
  const state = await loadCommandState(ctx);
  const updates = new Map();
  const premiumIds = new Set(await premiumGuildIds(ctx, now));
  const result = await syncCommands(ctx, { state, updates, premiumIds, onlyGuild: guildId, force: true });
  if (updates.size > 0) {
    await ctx.db.batch([...updates].map(([key, value]) => db.jobStateStatement(ctx, key, value, now)));
  }
  return result;
}

// ---------------------------------------------------------------------------------------
// Helpers.

function requirePremium(ctx) {
  if (!ctx.premium) {
    throw new UserError("This is a Platinum feature", "Platinum isn't active in this server.", { tone: "info" });
  }
}

function requireManager(interaction) {
  if (!hasManageGuild(interaction)) throw new UserError("You need the Manage Server permission");
}

const NP_ID = /^NPWR\d{5}_\d{2}$/;

async function resolveTitle(ctx, guildId, value) {
  if (NP_ID.test(value)) {
    const row = await pdb.getGuildTitle(ctx, guildId, value);
    if (row) return row;
  }
  const matches = await pdb.searchGuildTitles(ctx, guildId, value, 5);
  const pick = matches.find((m) => m.title_name.toLowerCase() === value.toLowerCase()) || (matches.length === 1 ? matches[0] : null);
  return pick ? pdb.getGuildTitle(ctx, guildId, pick.np_communication_id) : null;
}

const CUSTOM_EMOJI = /^<a?:[A-Za-z0-9_~]{2,32}:\d{15,25}>$/;

function validEmoji(value) {
  return CUSTOM_EMOJI.test(value) || (value.length <= 16 && !/[A-Za-z0-9<>@#:`*_~|\\]/.test(value));
}

function csvCell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

async function guildNames(ctx, ids) {
  const names = new Map();
  for (const id of ids.slice(0, 8)) {
    if (ctx.budget.remaining() < 4) break;
    const result = await getGuild(ctx, id);
    if (result.ok && result.data?.name) names.set(id, result.data.name);
  }
  return names;
}

async function joinRace(ctx, interaction, raceId = null) {
  requirePremium(ctx);
  const race = await pdb.getActiveRace(ctx, interaction.guild_id);
  if (!race || (raceId && race.id !== raceId)) {
    throw new UserError("That race is over", "Start a new one with **/race start**.", { tone: "info" });
  }
  const userId = getUserId(interaction);
  const links = await db.getMemberLinks(ctx, interaction.guild_id, userId);
  if (links.length === 0) {
    throw new UserError("Link your PSN account first", "Use **/addpsn**, then join the race.", { tone: "info" });
  }
  const now = Date.now();
  const accounts = links.slice(0, 3);
  await ctx.db.batch(
    accounts.map((link) =>
      pdb.joinRaceStatement(ctx, { raceId: race.id, psnId: link.psn_id, discordId: userId, name: link.cache_name || link.psn_username, now })
    )
  );
  return {
    payload: noticeView({
      tone: "success",
      title: `You're in the ${race.title_name} race`,
      body: `Racing with ${accounts.map((a) => `**${a.cache_name || a.psn_username}**`).join(", ")}. Progress updates every 30 minutes; **/race status** shows the standings.`,
    }),
  };
}

// ---------------------------------------------------------------------------------------
// Handlers.

export const premiumHandlers = {
  platinum: {
    mode: "sync",
    ephemeral: true,
    async run(ctx, interaction) {
      requirePremium(ctx);
      const guildId = interaction.guild_id;
      const group = getSubcommandGroup(interaction)?.name;
      const action = getSubcommand(interaction)?.name;
      const now = Date.now();

      if (action !== "status") requireManager(interaction);

      if (group === "milestone") {
        const milestones = await pdb.getMilestones(ctx, guildId);
        if (action === "list") return { payload: pui.milestoneListView({ milestones, rolesError: ctx.branding?.roles_error, theme: ctx.theme }) };

        const platinums = getIntegerOption(interaction, "platinums");
        if (action === "add") {
          const roleId = String(getOption(interaction, "role") || "");
          if (!roleId || roleId === guildId) throw new UserError("Pick a real role", "@everyone can't be a milestone role.");
          if (milestones.length >= MAX_MILESTONES && !milestones.some((m) => m.platinums === platinums)) {
            throw new UserError(`Up to ${MAX_MILESTONES} milestones`, "Remove one first.");
          }
          await ctx.db.batch([pdb.addMilestoneStatement(ctx, guildId, platinums, roleId), pdb.rolesErrorStatement(ctx, guildId, null, now)]);
          forgetGuild(guildId);
          return {
            payload: noticeView({
              tone: "success",
              title: "Milestone saved",
              body: `Members with **${platinums}+** platinums get <@&${roleId}>. Roles update within the hour; I need **Manage Roles** and a role above it.`,
            }),
          };
        }
        if (action === "remove") {
          await ctx.db.batch([pdb.removeMilestoneStatement(ctx, guildId, platinums), pdb.rolesErrorStatement(ctx, guildId, null, now)]);
          forgetGuild(guildId);
          return { payload: noticeView({ tone: "success", title: "Milestone removed", body: `The ${platinums}-platinum role will be taken back within the hour.` }) };
        }
      }

      if (action === "status") {
        const milestones = await pdb.getMilestones(ctx, guildId);
        return {
          payload: pui.platinumStatusView({
            branding: ctx.branding || {},
            milestones,
            expiresAt: Number(ctx.branding?.expires_at || 0) || null,
            theme: ctx.theme,
          }),
        };
      }

      if (action === "color") {
        const match = /^#?([0-9a-f]{6})$/i.exec(getStringOption(interaction, "hex"));
        if (!match) throw new UserError("That isn't a colour", "Use a hex colour like **#ff8800**.");
        const color = Number.parseInt(match[1], 16);
        await pdb.accentStatement(ctx, guildId, color, now).run();
        forgetGuild(guildId);
        const payload = noticeView({ tone: "success", title: "Accent colour saved", body: `Leaderboards and posts now use **#${match[1].toLowerCase()}**.` });
        payload.components[0].accent_color = color;
        return { payload };
      }

      if (action === "emojis") {
        const current = (() => {
          try {
            return JSON.parse(ctx.branding?.emoji_json || "{}") || {};
          } catch {
            return {};
          }
        })();
        for (const key of ["platinum", "gold", "silver", "bronze"]) {
          const value = getStringOption(interaction, key);
          if (!value) continue;
          if (!validEmoji(value)) throw new UserError(`"${value}" isn't an emoji`, "Use a server emoji (pick it from the emoji menu) or a normal emoji.");
          current[key] = value;
        }
        await pdb.emojiStatement(ctx, guildId, JSON.stringify(current), now).run();
        forgetGuild(guildId);
        const icons = { ...ctx.theme.icons, ...current };
        return {
          payload: noticeView({
            tone: "success",
            title: "Trophy emojis saved",
            body: `${icons.platinum} Platinum · ${icons.gold} Gold · ${icons.silver} Silver · ${icons.bronze} Bronze`,
          }),
        };
      }

      if (action === "weekly") {
        const day = getIntegerOption(interaction, "day");
        const hour = getIntegerOption(interaction, "hour");
        await pdb.weeklyScheduleStatement(ctx, guildId, day, hour, now).run();
        forgetGuild(guildId);
        const next = weeklySlot(now, day, hour) + 7 * DAY_MS;
        const channelNote = ctx.branding?.leaderboard_channel_id ? "" : "\nSet a channel first with **/weeklyleaderboard set**.";
        return {
          payload: noticeView({
            tone: "success",
            title: "Weekly schedule saved",
            body: `Weekly standings post every **${pui.WEEKDAYS[day]} at ${String(hour).padStart(2, "0")}:00 UTC**. Next: <t:${Math.floor(next / 1000)}:F>.${channelNote}`,
          }),
        };
      }

      if (action === "hunter") {
        const roleId = getOption(interaction, "role") ? String(getOption(interaction, "role")) : null;
        if (roleId === guildId) throw new UserError("Pick a real role", "@everyone can't be the Hunter of the Month role.");
        await pdb.hunterRoleStatement(ctx, guildId, roleId, now).run();
        forgetGuild(guildId);
        return {
          payload: noticeView({
            tone: "success",
            title: roleId ? "Hunter of the Month role saved" : "Hunter of the Month role turned off",
            body: roleId
              ? `On the 1st of each month, the member with the most new platinums gets <@&${roleId}>.`
              : "The monthly winner is still announced, without a role.",
          }),
        };
      }

      if (action === "export") {
        const rows = await pdb.getExportRows(ctx, guildId);
        const header = ["rank", "psn_online_id", "discord_user_id", "level", "platinum", "gold", "silver", "bronze", "total", "updated_utc", "status"];
        let rank = 0;
        const lines = rows.map((row) => {
          const ranked = Number(row.fetched_at) > 0;
          if (ranked) rank += 1;
          return [
            ranked ? rank : "",
            row.name,
            row.discord_id,
            row.trophy_level ?? "",
            row.platinum ?? "",
            row.gold ?? "",
            row.silver ?? "",
            row.bronze ?? "",
            row.total ?? "",
            ranked ? new Date(Number(row.fetched_at)).toISOString() : "",
            ranked ? "ok" : row.last_error === "private" ? "private" : "syncing",
          ]
            .map(csvCell)
            .join(",");
        });
        return {
          file: {
            filename: `trophy-leaderboard-${guildId}.csv`,
            content: `📄 Leaderboard export: ${rows.length} linked accounts`,
            data: [header.join(","), ...lines].join("\n"),
          },
        };
      }

      throw new UserError("Unknown option");
    },
  },

  monthly: {
    mode: "sync",
    async run(ctx, interaction) {
      requirePremium(ctx);
      const guildId = interaction.guild_id;
      const data = await pdb.getMonthlyStandings(ctx, guildId, 10);
      if (!data.hasBaseline) {
        const now = Date.now();
        await ctx.db.batch(pdb.monthlyBaselineStatements(ctx, guildId, monthKey(now), now));
        return {
          payload: noticeView(
            { tone: "success", title: "Monthly standings started", body: "Every trophy from now until the end of the month counts. The top hunter is announced on the 1st." },
            { ephemeral: false }
          ),
        };
      }
      return { payload: pui.monthlyMessage(data, { theme: ctx.theme }) };
    },
  },

  race: {
    mode: "sync",
    async run(ctx, interaction) {
      requirePremium(ctx);
      const guildId = interaction.guild_id;
      const action = getSubcommand(interaction)?.name;
      const now = Date.now();

      if (action === "join") return joinRace(ctx, interaction);

      const race = await pdb.getActiveRace(ctx, guildId);

      if (action === "start") {
        requireManager(interaction);
        if (race) throw new UserError(`A race for ${race.title_name} is running`, "End it with **/race end** before starting another.");
        const title = await resolveTitle(ctx, guildId, getStringOption(interaction, "game"));
        if (!title) {
          throw new UserError("Pick a game from the list", "The list shows games your members have played recently.");
        }
        const days = getIntegerOption(interaction, "days") || 7;
        const created = {
          id: crypto.randomUUID(),
          guildId,
          channelId: interaction.channel_id || interaction.channel?.id || null,
          npCommunicationId: title.np_communication_id,
          npServiceName: title.np_service_name,
          titleName: title.title_name,
          titleIconUrl: title.title_icon_url,
          platform: title.platform,
          createdBy: getUserId(interaction),
          startedAt: now,
          endsAt: now + days * DAY_MS,
        };
        await pdb.createRaceStatement(ctx, created).run();
        return {
          payload: pui.raceStartMessage(
            {
              id: created.id,
              title_name: created.titleName,
              title_icon_url: created.titleIconUrl,
              platform: created.platform,
              created_by: created.createdBy,
              ends_at: created.endsAt,
            },
            { theme: ctx.theme }
          ),
        };
      }

      if (!race) throw new UserError("No race is running", "A moderator can start one with **/race start**.", { tone: "info" });

      if (action === "leave") {
        await pdb.leaveRaceStatement(ctx, race.id, getUserId(interaction)).run();
        return { payload: noticeView({ tone: "success", title: "You left the race" }) };
      }

      if (action === "status") {
        const participants = await pdb.getRaceParticipants(ctx, race.id);
        return { payload: pui.raceStatusMessage(race, participants, { theme: ctx.theme }) };
      }

      if (action === "end") {
        requireManager(interaction);
        const [, participants] = await Promise.all([pdb.endRaceStatement(ctx, race.id).run(), pdb.getRaceParticipants(ctx, race.id)]);
        return { payload: pui.raceStatusMessage(race, participants, { theme: ctx.theme, ended: true }) };
      }

      throw new UserError("Unknown option");
    },
  },

  game: {
    mode: "sync",
    async run(ctx, interaction) {
      requirePremium(ctx);
      const title = await resolveTitle(ctx, interaction.guild_id, getStringOption(interaction, "title"));
      if (!title) throw new UserError("Pick a game from the list", "The list shows games your members have played recently.");
      const rows = await pdb.getGameBoard(ctx, interaction.guild_id, title.np_communication_id, 15);
      if (rows.length === 0) throw new UserError("Nobody here has played that yet", "", { tone: "info" });
      return { payload: pui.gameBoardMessage(rows, { theme: ctx.theme }) };
    },
  },

  history: {
    mode: "sync",
    async run(ctx, interaction) {
      requirePremium(ctx);
      const selfId = getUserId(interaction);
      const targetId = getOption(interaction, "user") || selfId;
      const { rows } = await db.getMemberAccounts(ctx, interaction.guild_id, targetId);
      if (rows.length === 0) {
        throw new UserError(targetId === selfId ? "You haven't linked a PSN account here yet" : "That member hasn't linked a PSN account here", "Use **/addpsn**.", { tone: "info" });
      }
      const now = Date.now();
      const accounts = rows.slice(0, 3);
      const sinceDay = new Date(now - HISTORY_DAYS * DAY_MS).toISOString().slice(0, 10);
      const history = await pdb.getHistory(ctx, accounts.map((row) => row.psn_id), sinceDay);
      return {
        payload: pui.historyMessage({
          accounts: accounts.map((row) => ({ name: row.name, rows: history.filter((h) => h.psn_id === row.psn_id) })),
          now,
          theme: ctx.theme,
        }),
      };
    },
  },

  admin: {
    mode: "sync",
    ephemeral: true,
    async run(ctx, interaction) {
      if (!isOwner(ctx, interaction)) throw new UserError("Owner only");
      const action = getSubcommand(interaction)?.name;
      const now = Date.now();

      if (action === "stats") {
        const stats = await pdb.getOwnerStats(ctx, now);
        const premiumRows = await pdb.getActivePremiumGuilds(ctx, now);
        const app = await getApplication(ctx);
        const names = await guildNames(ctx, stats.top.map((row) => row.guild_id));
        return {
          payload: pui.adminStatsView({
            stats,
            names,
            guildCount: app.ok ? (app.data?.approximate_guild_count ?? null) : null,
            premiumIds: new Set(premiumRows.map((row) => row.guild_id)),
          }),
        };
      }

      if (action === "list") {
        const rows = await pdb.getActivePremiumGuilds(ctx, now);
        const names = await guildNames(ctx, rows.map((row) => row.guild_id));
        return { payload: pui.adminListView({ rows, names }) };
      }

      const guildId = getStringOption(interaction, "server_id");
      if (!/^\d{15,25}$/.test(guildId)) throw new UserError("That isn't a server ID", "Right-click the server icon → Copy Server ID (Developer Mode on).");

      if (action === "grant") {
        const days = getIntegerOption(interaction, "days");
        const note = getStringOption(interaction, "note") || null;
        const already = (await pdb.getActivePremiumGuilds(ctx, now)).some((row) => row.guild_id === guildId);
        await ctx.db.batch(grantStatements(ctx, { guildId, days, note, now, startMonthly: !already }));
        forgetGuild(guildId);
        const sync = await syncOneGuild(ctx, guildId, now);
        return {
          payload: noticeView({
            tone: sync.failed ? "warning" : "success",
            title: `Platinum ${already ? "extended" : "granted"}`,
            body: [
              `Server \`${guildId}\`${days ? ` for ${days} days` : " with no end date"}.`,
              sync.failed
                ? "Couldn't add the Platinum commands there. Is the bot in that server with the **applications.commands** scope?"
                : "Platinum commands are live there now.",
            ].join("\n"),
          }),
        };
      }

      if (action === "revoke") {
        await pdb.revokePremiumStatement(ctx, guildId).run();
        forgetGuild(guildId);
        await syncOneGuild(ctx, guildId, now);
        return { payload: noticeView({ tone: "success", title: "Platinum removed", body: `Server \`${guildId}\` is back on the free plan.` }) };
      }

      throw new UserError("Unknown option");
    },
  },
};

export const premiumComponentHandlers = {
  race: {
    responseFor() {
      return "reply";
    },
    async run(ctx, interaction, { action, arg }) {
      if (action === "join") return joinRace(ctx, interaction, arg);
      throw new UserError("This button has expired");
    },
  },
};

async function titleChoices(ctx, interaction) {
  const query = String(getFocusedOption(interaction)?.value || "").trim().toLowerCase();
  const rows = await guildTitles(ctx, interaction.guild_id);
  const matches = query ? rows.filter((row) => String(row.title_name).toLowerCase().includes(query)) : rows;
  return matches.slice(0, 25).map((row) => {
    const label = `${row.title_name} · ${row.players} player${row.players === 1 ? "" : "s"}`;
    return { name: label.length > 100 ? `${label.slice(0, 97)}...` : label, value: row.np_communication_id };
  });
}

export const premiumAutocompleteHandlers = {
  race: titleChoices,
  game: titleChoices,
};
