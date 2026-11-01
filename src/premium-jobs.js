// Background work for Platinum servers. Each stage is bounded by the run's subrequest budget
// and costs nothing when no server has Platinum.

import {
  DIRECTORY_KEEP_MS,
  DIRECTORY_SYNC_INTERVAL_MS,
  ENTITLEMENT_SYNC_INTERVAL_MS,
  LEADERBOARD_PAGE_SIZE,
  MAX_ROLE_CHANGES_PER_GUILD,
  RACE_CHECK_INTERVAL_MS,
  ROLE_RECHECK_MS,
  TITLE_SYNC_INTERVAL_MS,
  TITLE_SYNC_LIMIT,
  WEEKLY_CATCH_UP_MS,
} from "./config.js";
import * as db from "./db.js";
import * as pdb from "./db-premium.js";
import { listBotGuilds, listEntitlements, postChannelMessage, setMemberRole } from "./discord.js";
import { brandingTheme, entitlementUntil, isActiveServerEntitlement, monthKey } from "./premium.js";
import { syncCommands } from "./premium-commands.js";
import * as pui from "./premium-ui.js";
import { acquirePsn, fetchTitleEarnings, fetchTitles, psnAllowance, PsnError } from "./psn.js";
import { mapLimit, weeklySlot } from "./runtime.js";
import * as ui from "./ui.js";

// Everything the premium stages need, loaded in one round trip.
export async function loadPremiumState(ctx, now) {
  const [premium, commandState] = await ctx.db.batch([
    ctx.db
      .prepare("SELECT guild_id FROM premium_guilds WHERE expires_at IS NULL OR expires_at > ?1")
      .bind(now),
    ctx.db.prepare(
      `SELECT key, value FROM job_state
       WHERE key IN ('application_id', 'entitlements_synced_at', 'directory_synced_at') OR key LIKE 'commands_hash:%'`
    ),
  ]);

  const tableIds = (premium.results || []).map((row) => row.guild_id);
  const envIds = ctx.settings.premiumGuildIds;
  const missing = envIds.filter((id) => !tableIds.includes(id));

  // Test servers from PREMIUM_GUILD_IDS live in the table too, so SQL-side checks see them.
  if (missing.length > 0) {
    await ctx.db.batch(missing.map((guildId) => pdb.grantPremiumStatement(ctx, { guildId, source: "env", note: "PREMIUM_GUILD_IDS", now, expiresAt: null })));
  }

  return {
    ids: new Set([...tableIds, ...envIds]),
    commandState: new Map((commandState.results || []).map((row) => [row.key, row.value])),
  };
}

// Payment hook, inert until PREMIUM_SKU_ID is set: once an hour, mirror Discord's active
// server subscriptions into premium_guilds, so paying servers keep Platinum even when quiet.
// Runs before the commands stage, so a new subscriber gets the commands in the same run.
export async function entitlementStage(ctx, now, premium, updates) {
  const sku = ctx.settings.premiumSkuId;
  const appId = premium.commandState.get("application_id");
  if (!sku || !appId || !ctx.env.DISCORD_BOT_TOKEN || ctx.budget.remaining() < 10) return;
  if (now - Number(premium.commandState.get("entitlements_synced_at") || 0) < ENTITLEMENT_SYNC_INTERVAL_MS) return;

  const active = [];
  let after = null;
  for (let page = 0; page < 3; page += 1) {
    const result = await listEntitlements(ctx, appId, sku, after);
    if (!result.ok) {
      console.warn(`Entitlement check failed: ${result.status} ${result.detail || ""}`);
      return;
    }
    const list = Array.isArray(result.data) ? result.data : [];
    active.push(...list.filter((e) => isActiveServerEntitlement(e, sku, now)));
    if (list.length < 100) break;
    after = list.at(-1).id;
  }

  const statements = active.map((e) =>
    pdb.extendEntitlementStatement(ctx, { guildId: String(e.guild_id), note: `sku ${sku}`, now, expiresAt: entitlementUntil(e, now) })
  );
  if (statements.length > 0) await ctx.db.batch(statements);
  for (const e of active) premium.ids.add(String(e.guild_id));
  updates.set("entitlements_synced_at", String(now));
}

export async function syncCommandsStage(ctx, premium, updates) {
  if (ctx.budget.remaining() < 6) return;
  await syncCommands(ctx, { state: premium.commandState, updates, premiumIds: premium.ids, maxGuilds: 3 });
}

function themeFor(ctx, row) {
  return brandingTheme(ctx.env, row, true);
}

// Channel errors that won't fix themselves by retrying (rate limits and outages will).
const LASTING_POST_ERRORS = ["missing_access", "unknown_channel", "bad_request", "missing_bot_token"];

// ---------------------------------------------------------------------------------------
// Owner tools: once a day, store the names of the servers the bot is in (for /admin).

export async function directoryStage(ctx, now, premium, updates) {
  if (!ctx.env.DISCORD_BOT_TOKEN || ctx.budget.remaining() < 8) return;
  if (now - Number(premium.commandState.get("directory_synced_at") || 0) < DIRECTORY_SYNC_INTERVAL_MS) return;

  const guilds = [];
  let after = null;
  for (let page = 0; page < 5 && ctx.budget.remaining() > 4; page += 1) {
    const result = await listBotGuilds(ctx, after);
    if (!result.ok) {
      console.warn(`Server list failed: ${result.status} ${result.detail || ""}`);
      return;
    }
    const list = Array.isArray(result.data) ? result.data : [];
    guilds.push(...list);
    if (list.length < 200) break;
    after = list.at(-1).id;
  }

  const statements = guilds.map((guild) =>
    pdb.directoryStatement(ctx, { guildId: String(guild.id), name: String(guild.name || ""), members: guild.approximate_member_count, now })
  );
  statements.push(pdb.pruneDirectoryStatement(ctx, now - DIRECTORY_KEEP_MS));
  await ctx.db.batch(statements, { reserved: true });
  updates.set("directory_synced_at", String(now));
}

// ---------------------------------------------------------------------------------------
// One-time welcome post for servers granted Platinum with `announce`, sent once their
// Platinum commands are registered (so everything the post mentions is there).

export async function welcomeStage(ctx, now, premium) {
  if (!ctx.env.DISCORD_BOT_TOKEN || ctx.budget.remaining() < 4) return;
  const pending = await pdb.getPendingWelcomes(ctx, now, 2);

  for (const row of pending) {
    if (ctx.budget.remaining() < 2) break;
    const registered = /^[0-9a-f]{16}$/.test(premium.commandState.get(`commands_hash:guild:${row.guild_id}`) || "");
    if (!registered) continue;

    if (!row.leaderboard_channel_id || row.channel_error) {
      await pdb.welcomeStatusStatement(ctx, row.guild_id, "no_channel").run();
      continue;
    }
    const result = await postChannelMessage(
      ctx,
      row.leaderboard_channel_id,
      pui.welcomeMessage({ expiresAt: Number(row.expires_at || 0) || null, theme: themeFor(ctx, row) })
    );
    if (result.ok) {
      await pdb.welcomeStatusStatement(ctx, row.guild_id, `posted:${row.leaderboard_channel_id}`).run();
    } else if (LASTING_POST_ERRORS.includes(result.error)) {
      await pdb.welcomeStatusStatement(ctx, row.guild_id, `failed:${result.error}`).run();
    }
  }
}

// ---------------------------------------------------------------------------------------
// Weekly posts on a custom day and hour.

export async function customWeeklyStage(ctx, now, report) {
  if (!ctx.env.DISCORD_BOT_TOKEN || ctx.budget.remaining() < 6) return;
  const guilds = await pdb.getCustomWeeklyGuilds(ctx, now);

  for (const guild of guilds) {
    const slot = weeklySlot(now, Number(guild.weekly_day), Number(guild.weekly_hour ?? 16));
    const lastPost = Number(guild.last_weekly_post_at || 0);
    if (lastPost >= slot || now - slot > WEEKLY_CATCH_UP_MS) continue;
    if (ctx.budget.remaining() < 4) break;

    const { board, movers } = await db.getWeeklyData(ctx, guild.guild_id, LEADERBOARD_PAGE_SIZE);
    if (board.rankedCount === 0) {
      await db.markWeeklyPostedStatement(ctx, guild.guild_id, now).run();
      continue;
    }

    const result = await postChannelMessage(ctx, guild.leaderboard_channel_id, ui.weeklyMessage(board, movers, { theme: themeFor(ctx, guild), pageSize: LEADERBOARD_PAGE_SIZE }));
    if (result.ok) {
      await ctx.db.batch([...db.resetBaselineStatements(ctx, guild.guild_id, now), db.markWeeklyPostedStatement(ctx, guild.guild_id, now)]);
      report.weekly += 1;
    } else if (["missing_access", "unknown_channel", "bad_request"].includes(result.error)) {
      await db.channelErrorStatement(ctx, guild.guild_id, result.error, now).run();
    }
  }
}

// ---------------------------------------------------------------------------------------
// Races: finish expired ones, then check participants' progress.

export async function racesStage(ctx, now, report) {
  if (ctx.budget.remaining() < 6) return;

  const ending = await pdb.getRacesEnding(ctx, now, 2);
  for (const race of ending) {
    if (ctx.budget.remaining() < 4) return;
    const participants = await pdb.getRaceParticipants(ctx, race.id);
    if (race.channel_id && ctx.env.DISCORD_BOT_TOKEN) {
      await postChannelMessage(ctx, race.channel_id, pui.raceStatusMessage(race, participants, { theme: themeFor(ctx, race), ended: true }));
    }
    await pdb.endRaceStatement(ctx, race.id).run();
    report.races += 1;
  }

  const room = Math.min(8, ctx.budget.remaining() - 6);
  if (room <= 0) return;
  const due = await pdb.getRaceChecksDue(ctx, now, now - RACE_CHECK_INTERVAL_MS, room);
  if (due.length === 0) return;

  try {
    await acquirePsn(ctx, due.length);
  } catch (err) {
    if (err instanceof PsnError) return;
    throw err;
  }

  const usable = due.slice(0, psnAllowance(ctx));
  const results = await mapLimit(usable, 4, (row) => fetchTitleEarnings(ctx, row.psn_id, row.np_communication_id, row.np_service_name));
  const statements = [];
  const finished = [];

  results.forEach((result, index) => {
    const row = usable[index];
    if (!result.ok) {
      if (result.error instanceof PsnError && ["private", "not_found"].includes(result.error.code)) {
        statements.push(pdb.raceProgressStatement(ctx, { raceId: row.race_id, psnId: row.psn_id, progress: row.progress, earnedTotal: 0, finishedAt: null, now }));
      }
      return;
    }
    const earnings = result.value;
    const progress = earnings?.progress ?? 0;
    const done = Boolean(earnings && earnings.platinum > 0);
    statements.push(
      pdb.raceProgressStatement(ctx, { raceId: row.race_id, psnId: row.psn_id, progress, earnedTotal: earnings?.earnedTotal ?? 0, finishedAt: done ? now : null, now })
    );
    if (done) finished.push({ ...row, progress });
  });

  if (statements.length > 0) await ctx.db.batch(statements, { reserved: true });
  report.raceChecks += usable.length;

  for (const row of finished) {
    if (!ctx.env.DISCORD_BOT_TOKEN || ctx.budget.remaining() < 2) break;
    if (!row.channel_id) continue;
    const position = await pdb.getFinishCount(ctx, row.race_id);
    await postChannelMessage(ctx, row.channel_id, pui.raceFinishMessage(row, row, position, { theme: themeFor(ctx, row) }));
  }
}

// ---------------------------------------------------------------------------------------
// Monthly standings: announce last month's top hunter, hand over the role, start the month.

export async function monthlyStage(ctx, now, report) {
  if (ctx.budget.remaining() < 8) return;
  const month = monthKey(now);
  const previous = monthKey(Date.parse(`${month}-01T00:00:00Z`) - 1);
  const guilds = await pdb.getMonthlyDueGuilds(ctx, month, now, 2);

  for (const guild of guilds) {
    if (ctx.budget.remaining() < 7) break;

    // Only last month crowns a winner; a server back from a break simply starts afresh.
    if (guild.monthly_month === previous) {
      const standings = await pdb.getMonthlyStandings(ctx, guild.guild_id, 3);
      const winners = standings.movers;
      const theme = themeFor(ctx, guild);

      if (winners.length > 0 && guild.leaderboard_channel_id && !guild.channel_error && ctx.env.DISCORD_BOT_TOKEN) {
        const posted = await postChannelMessage(
          ctx,
          guild.leaderboard_channel_id,
          pui.hunterOfMonthMessage({ month: guild.monthly_month, winners, roleId: guild.hunter_role_id, theme })
        );
        // A Discord hiccup: try again next run instead of losing the announcement.
        if (!posted.ok && !LASTING_POST_ERRORS.includes(posted.error)) continue;
      }

      if (guild.hunter_role_id && winners.length > 0 && ctx.env.DISCORD_BOT_TOKEN) {
        const winner = String(winners[0].discord_id);
        if (guild.hunter_discord_id && guild.hunter_discord_id !== winner) {
          await setMemberRole(ctx, { guildId: guild.guild_id, userId: guild.hunter_discord_id, roleId: guild.hunter_role_id, add: false });
        }
        const added = await setMemberRole(ctx, { guildId: guild.guild_id, userId: winner, roleId: guild.hunter_role_id, add: true });
        if (added.ok) await pdb.hunterHolderStatement(ctx, guild.guild_id, winner, now).run();
      }
      report.monthly += 1;
    }

    await ctx.db.batch(pdb.monthlyBaselineStatements(ctx, guild.guild_id, month, now));
  }
}

// ---------------------------------------------------------------------------------------
// Milestone roles: each member gets the highest milestone their best account has reached.
// Members who unlink lose the role. Grants are re-confirmed weekly, because someone who
// leaves and rejoins loses their roles without the bot hearing about it. A "-" grant marks
// a member who left; they are tried again after a week.

export function planRoleChanges({ members, milestones, grants }, now = Date.now()) {
  const granted = new Map();
  for (const grant of grants) {
    const id = String(grant.discord_id);
    if (!granted.has(id)) granted.set(id, new Map());
    granted.get(id).set(grant.role_id, grant.granted_at === undefined || grant.granted_at === null ? now : Number(grant.granted_at));
  }
  const best = new Map(members.map((member) => [String(member.discord_id), Number(member.platinum)]));
  const ascending = [...milestones].sort((a, b) => Number(a.platinums) - Number(b.platinums));

  const changes = [];
  for (const id of new Set([...best.keys(), ...granted.keys()])) {
    const have = granted.get(id) || new Map();
    const left = have.get("-");
    if (left !== undefined && now - left < ROLE_RECHECK_MS) continue;
    const platinum = best.get(id);
    const target = platinum === undefined ? null : ascending.findLast((m) => platinum >= Number(m.platinums))?.role_id || null;
    // We only ever record roles we granted, so anything other than the target goes.
    for (const role of have.keys()) {
      if (role !== "-" && role !== target) changes.push({ discordId: id, roleId: role, add: false });
    }
    const since = target ? have.get(target) : undefined;
    if (target && (since === undefined || left !== undefined || now - since >= ROLE_RECHECK_MS)) {
      changes.push({ discordId: id, roleId: target, add: true });
    }
  }
  return changes;
}

export async function rolesStage(ctx, now, report) {
  if (!ctx.env.DISCORD_BOT_TOKEN || ctx.budget.remaining() < 8) return;
  const guilds = await pdb.getRoleSyncGuilds(ctx, now, 2);

  for (const guildId of guilds) {
    if (ctx.budget.remaining() < 5) break;
    // A few changes per server per run stays under Discord's per-server role rate limit.
    const changes = planRoleChanges(await pdb.getRoleSyncData(ctx, guildId), now).slice(0, MAX_ROLE_CHANGES_PER_GUILD);
    const statements = [];

    for (const change of changes) {
      if (ctx.budget.remaining() < 3) break;
      const result = await setMemberRole(ctx, { guildId, userId: change.discordId, roleId: change.roleId, add: change.add });
      if (result.ok || (!change.add && result.status === 404)) {
        statements.push(
          change.add
            ? pdb.roleGrantStatement(ctx, { guildId, discordId: change.discordId, roleId: change.roleId, now })
            : pdb.roleRevokeStatement(ctx, { guildId, discordId: change.discordId, roleId: change.roleId })
        );
        // They're (back) in the server.
        if (change.add) statements.push(pdb.roleRevokeStatement(ctx, { guildId, discordId: change.discordId, roleId: "-" }));
        if (result.ok) report.roles += 1;
      } else if (result.status === 404 && /10007/.test(result.detail || "")) {
        statements.push(pdb.roleGrantStatement(ctx, { guildId, discordId: change.discordId, roleId: "-", now }));
      } else if (result.status === 403 || result.status === 404) {
        statements.push(pdb.rolesErrorStatement(ctx, guildId, result.status === 403 ? "missing_access" : "bad_request", now));
        break;
      } else {
        break;
      }
    }

    if (statements.length > 0) await ctx.db.batch(statements, { reserved: true });
  }
}

// ---------------------------------------------------------------------------------------
// Recently played games for Platinum accounts (feeds /game and /race).

export async function titleSyncStage(ctx, now, report) {
  const room = Math.min(5, ctx.budget.remaining() - 5);
  if (room <= 0) return;
  const due = await pdb.getTitleSyncDue(ctx, now, now - TITLE_SYNC_INTERVAL_MS, room);
  if (due.length === 0) return;

  try {
    await acquirePsn(ctx, due.length);
  } catch (err) {
    if (err instanceof PsnError) return;
    throw err;
  }

  const usable = due.slice(0, psnAllowance(ctx));
  const results = await mapLimit(usable, 5, (row) => fetchTitles(ctx, row.psn_id, { limit: TITLE_SYNC_LIMIT }));
  const statements = [];

  results.forEach((result, index) => {
    const row = usable[index];
    if (result.ok) {
      statements.push(...result.value.titles.map((title) => db.snapshotStatement(ctx, { ...title, psnUsername: row.psn_username }, now)));
      statements.push(pdb.titlesSyncedStatement(ctx, row.psn_id, now));
      report.titleSyncs += 1;
    } else if (result.error instanceof PsnError && ["private", "not_found"].includes(result.error.code)) {
      statements.push(pdb.titlesSyncedStatement(ctx, row.psn_id, now));
    }
  });

  if (statements.length > 0) await ctx.db.batch(statements, { reserved: true });
}
