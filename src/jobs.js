// The background job. One cron run every 5 minutes does a bounded slice of work, so the bot
// fits Workers Free limits (50 subrequests, 10 ms CPU per run) no matter how many servers or
// accounts it tracks — more accounts just means each one is refreshed a little less often.

import {
  ALERT_MAX_AGE_MS,
  ALERT_TITLE_SCAN,
  DAY_MS,
  getSettings,
  LEADERBOARD_PAGE_SIZE,
  MAX_ALERTS_PER_ACCOUNT,
  MINUTE_MS,
  NPSSO_LIFETIME_MS,
  WEEKLY_CATCH_UP_MS,
} from "./config.js";
import * as db from "./db.js";
import { postChannelMessage } from "./discord.js";
import {
  acquirePsn,
  fetchProfile,
  fetchTitles,
  getPsnAuthReminderDecision,
  psnAccounts,
  psnAllowance,
  PsnError,
  refreshAccounts,
} from "./psn.js";
import { Budget, BudgetExceededError, createContext, logEvent, mapLimit, sha256Hex, utcDay, weeklyPostSlot } from "./runtime.js";
import * as ui from "./ui.js";

const JOB_KEYS = [
  "psn_auth_error",
  "maintenance_day",
  "ops_auth_alert_day",
  "npsso_hash_primary",
  "npsso_seen_at_primary",
  "npsso_hash_backup",
  "npsso_seen_at_backup",
];

export async function runScheduled(env, event = {}) {
  const now = Number(event.scheduledTime) || Date.now();
  const settings = getSettings(env);
  const ctx = createContext(env, { now, workBudgetMs: 10 * MINUTE_MS, budget: new Budget(settings.subrequestBudget, 2) });
  ctx.theme = ui.createTheme(env);
  const report = { weekly: 0, alerts: 0, refreshed: 0, profiles: 0, stage: "" };

  try {
    await db.ensureSchema(ctx);
    const state = await db.getJobState(ctx, JOB_KEYS);
    const updates = new Map();

    await stage(report, "weekly", () => postDueWeekly(ctx, now, report));
    await stage(report, "alerts", () => processAlerts(ctx, now, report));
    await stage(report, "refresh", () => refreshDue(ctx, now, report, state, updates));
    await stage(report, "maintenance", () => dailyMaintenance(ctx, now, state, updates));
    await stage(report, "profiles", () => backfillProfiles(ctx, now, report));

    if (updates.size > 0) {
      await ctx.db.batch(
        [...updates].map(([key, value]) => db.jobStateStatement(ctx, key, value, now)),
        { reserved: true }
      );
    }
  } catch (err) {
    console.error("Scheduled run failed:", err);
  }

  logEvent("cron", { ...report, subrequests: ctx.budget.used, d1: ctx.budget.d1, fetches: ctx.budget.fetches });
  return report;
}

async function stage(report, name, fn) {
  try {
    await fn();
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      report.stage = `${name}: budget exhausted`;
      return;
    }
    console.error(`Cron stage ${name} failed:`, err);
  }
}

// ---------------------------------------------------------------------------------------
// Weekly posts: Sunday 16:00 UTC, catching up for 48 h if a run was missed. ~3 subrequests
// per server, so large numbers of servers are spread across consecutive runs.

async function postDueWeekly(ctx, now, report) {
  const slot = weeklyPostSlot(now);
  if (now < slot || now - slot > WEEKLY_CATCH_UP_MS || !ctx.env.DISCORD_BOT_TOKEN) return;

  const capacity = Math.floor((ctx.budget.remaining() - 6) / 4);
  if (capacity <= 0) return;

  const guilds = await db.getDueWeeklyGuilds(ctx, slot, Math.min(capacity, 8));

  for (const guild of guilds) {
    if (ctx.budget.remaining() < 4) break;

    const { board, movers } = await db.getWeeklyData(ctx, guild.guild_id, LEADERBOARD_PAGE_SIZE);

    if (board.rankedCount === 0) {
      await db.markWeeklyPostedStatement(ctx, guild.guild_id, now).run();
      continue;
    }

    const result = await postChannelMessage(
      ctx,
      guild.leaderboard_channel_id,
      ui.weeklyMessage(board, movers, { theme: ctx.theme, pageSize: LEADERBOARD_PAGE_SIZE })
    );

    if (result.ok) {
      await ctx.db.batch([...db.resetBaselineStatements(ctx, guild.guild_id, now), db.markWeeklyPostedStatement(ctx, guild.guild_id, now)]);
      report.weekly += 1;
    } else if (["missing_access", "unknown_channel", "bad_request"].includes(result.error)) {
      await db.channelErrorStatement(ctx, guild.guild_id, result.error, now).run();
    } else {
      break;
    }
  }
}

// ---------------------------------------------------------------------------------------
// Platinum alerts. Any refresh path may raise an account's platinum count; this stage turns
// the difference (platinum > alert_platinum) into announcements, then marks it handled.

function isNewPlatinum(snapshot, syncedAt) {
  if (!snapshot || Number(snapshot.earned_platinum) === 0) return true;
  if (snapshot.platinum_seen_at === null || snapshot.platinum_seen_at === undefined) return true;
  return Number(snapshot.platinum_seen_at) > Number(syncedAt);
}

async function processAlerts(ctx, now, report) {
  if (!ctx.env.DISCORD_BOT_TOKEN || ctx.budget.remaining() < 8) return;

  const pending = await db.getPendingAlerts(ctx, 3);
  if (pending.length === 0) return;

  try {
    await acquirePsn(ctx, pending.length);
  } catch (err) {
    if (err instanceof PsnError) return;
    throw err;
  }

  for (const account of pending.slice(0, psnAllowance(ctx))) {
    if (ctx.budget.remaining() < 4) break;

    let titles;
    try {
      ({ titles } = await fetchTitles(ctx, account.psn_id, { limit: ALERT_TITLE_SCAN }));
    } catch (err) {
      if (err instanceof PsnError && ["private", "not_found"].includes(err.code)) {
        await db.alertSyncedStatement(ctx, { psnId: account.psn_id, platinum: account.platinum, now }).run();
        continue;
      }
      if (err instanceof PsnError) break;
      throw err;
    }

    const context = await db.getAlertContext(ctx, account.psn_id, titles.map((title) => title.npCommunicationId));
    const gain = Math.max(0, Math.min(Number(account.platinum) - Number(account.alert_platinum), MAX_ALERTS_PER_ACCOUNT));
    const fresh = titles
      .filter((title) => title.platinum > 0)
      .filter((title) => !context.alerted.has(title.npCommunicationId))
      .filter((title) => isNewPlatinum(context.snapshots.get(title.npCommunicationId), account.alert_synced_at))
      .sort((a, b) => (Date.parse(b.lastUpdatedAt) || 0) - (Date.parse(a.lastUpdatedAt) || 0))
      .slice(0, gain);

    // Record first, then post: a failed post can lose an alert but never duplicates one.
    await ctx.db.batch(
      [
        ...fresh.map((title) => db.alertRecordStatement(ctx, { psnId: account.psn_id, communicationId: title.npCommunicationId, now })),
        ...titles.map((title) => db.snapshotStatement(ctx, { ...title, psnUsername: account.psn_username }, now)),
        db.alertSyncedStatement(ctx, { psnId: account.psn_id, platinum: account.platinum, now }),
      ],
      { reserved: true }
    );

    // Catch-up after downtime: platinums earned long ago are recorded above but not announced
    // as "new".
    const recent = fresh.filter((title) => now - (Date.parse(title.lastUpdatedAt) || 0) <= ALERT_MAX_AGE_MS);
    if (recent.length === 0) continue;

    const payload = ui.platinumAlertMessage(
      { owner: account.psn_username, avatarUrl: account.avatar_url, titles: recent, platinumCount: Number(account.platinum) },
      { theme: ctx.theme }
    );

    for (const target of context.targets) {
      if (ctx.budget.remaining() < 1) break;
      const result = await postChannelMessage(ctx, target.channel_id, payload);
      if (result.ok) {
        report.alerts += 1;
      } else if (["missing_access", "unknown_channel"].includes(result.error) && ctx.budget.remaining() > 0) {
        await db.channelErrorStatement(ctx, target.guild_id, result.error, now).run();
      }
    }
  }
}

// ---------------------------------------------------------------------------------------
// Background refresh of the stalest tracked accounts.

function recordAuthError(state, updates, err) {
  const message = String(err?.message || err).slice(0, 500);
  if (state.get("psn_auth_error") !== message) updates.set("psn_auth_error", message);
}

async function refreshDue(ctx, now, report, state, updates) {
  const wanted = Math.min(ctx.settings.refreshPerRun, ctx.budget.remaining() - 5);
  if (wanted <= 0) return;

  const due = await db.getDueAccounts(ctx, now, wanted);
  if (due.length === 0) return;

  try {
    await acquirePsn(ctx, due.length);
  } catch (err) {
    if (err instanceof PsnError && err.code === "auth") {
      recordAuthError(state, updates, err);
      return;
    }
    throw err;
  }

  if (state.get("psn_auth_error")) updates.set("psn_auth_error", "");
  if (psnAllowance(ctx) === 0) return;

  const { refreshed, stopError } = await refreshAccounts(ctx, due, { now });
  report.refreshed = refreshed.length;
  if (stopError instanceof PsnError && stopError.code === "auth") recordAuthError(state, updates, stopError);
}

// ---------------------------------------------------------------------------------------
// Avatars and canonical Online IDs for accounts linked before the bot stored them.

async function backfillProfiles(ctx, now, report) {
  const limit = Math.min(5, ctx.budget.remaining() - 4);
  if (limit <= 0) return;

  const rows = await db.getProfileBackfill(ctx, now - 30 * DAY_MS, limit);
  if (rows.length === 0) return;

  try {
    await acquirePsn(ctx, rows.length);
  } catch (err) {
    if (err instanceof PsnError) return;
    throw err;
  }

  const usable = rows.slice(0, psnAllowance(ctx));
  const results = await mapLimit(usable, 5, (row) => fetchProfile(ctx, row.psn_id));
  const statements = [];

  results.forEach((result, index) => {
    const row = usable[index];
    if (result.ok) {
      statements.push(db.profileStatement(ctx, { psnId: row.psn_id, ...result.value, name: result.value.onlineId, now }));
      if (result.value.onlineId) statements.push(db.usernameCacheStatement(ctx, { name: result.value.onlineId, psnId: row.psn_id, now }));
      report.profiles += 1;
    } else if (result.error instanceof PsnError && ["not_found", "private"].includes(result.error.code)) {
      statements.push(db.profileStatement(ctx, { psnId: row.psn_id, name: "", avatarUrl: null, isPlus: null, now }));
    }
  });

  if (statements.length > 0) await ctx.db.batch(statements, { reserved: true });
}

// ---------------------------------------------------------------------------------------
// Once a day: PSN login reminders for the bot owner, and database cleanup.

async function dailyMaintenance(ctx, now, state, updates) {
  const day = utcDay(now);
  if (state.get("maintenance_day") === day || ctx.budget.remaining() < 8) return;

  const opsChannel = ctx.settings.opsChannelId;
  const notices = [];

  for (const account of psnAccounts(ctx.env)) {
    let seenAt = Number(state.get(`npsso_seen_at_${account.key}`) || 0);

    if (account.npsso) {
      const hash = await sha256Hex(account.npsso);
      if (state.get(`npsso_hash_${account.key}`) !== hash) {
        seenAt = now;
        updates.set(`npsso_hash_${account.key}`, hash);
        updates.set(`npsso_seen_at_${account.key}`, now);
      }
    }

    const stored = await db.getPsnAuthRecord(ctx, account.key);
    const explicitExpiry = Date.parse(ctx.env[account.key === "backup" ? "PSN_NPSSO_BACKUP_EXPIRES_AT" : "PSN_NPSSO_EXPIRES_AT"] || "");
    const npssoExpiry = Number.isFinite(explicitExpiry) ? explicitExpiry : (seenAt || now) + NPSSO_LIFETIME_MS;
    const decision = getPsnAuthReminderDecision(stored, now, npssoExpiry);
    if (decision) notices.push({ account: account.key, decision, sentKey: `psn_auth_reminder_${account.key}_${decision.key}` });
  }

  const sent = notices.length > 0 ? await db.getJobState(ctx, notices.map((n) => n.sentKey)) : new Map();

  for (const notice of notices) {
    if (sent.has(notice.sentKey) || !ctx.env.DISCORD_BOT_TOKEN) continue;
    const result = await postChannelMessage(ctx, opsChannel, authReminderPayload(notice));
    if (result.ok) updates.set(notice.sentKey, new Date(now).toISOString());
  }

  const authError = updates.has("psn_auth_error") ? updates.get("psn_auth_error") : state.get("psn_auth_error");
  if (authError && state.get("ops_auth_alert_day") !== day && ctx.env.DISCORD_BOT_TOKEN) {
    const result = await postChannelMessage(
      ctx,
      opsChannel,
      ui.opsAuthView({
        title: "PSN login is failing",
        lines: [
          "Cached stats still work, but nothing is being refreshed.",
          `Last error: \`${String(authError).slice(0, 200)}\``,
          ...refreshSteps(),
        ],
      })
    );
    if (result.ok) updates.set("ops_auth_alert_day", day);
  }

  await ctx.db.batch(db.cleanupStatements(ctx, now));
  updates.set("maintenance_day", day);
}

function refreshSteps() {
  return [
    "",
    "**How to fix**",
    "1. Log in at playstation.com with the bot's PSN account.",
    "2. Open `https://ca.account.sony.com/api/v1/ssocookie` and copy the `npsso` value.",
    "3. Run `npx wrangler secret put PSN_NPSSO` (or `PSN_NPSSO_BACKUP`) and paste it. No redeploy needed.",
  ];
}

function authReminderPayload({ account, decision }) {
  const expired = decision.daysRemaining <= 0;
  const subject = decision.kind === "refresh" ? "PSN refresh token" : "PSN NPSSO";
  const date = new Date(decision.expiresAt).toISOString().slice(0, 10);
  return ui.opsAuthView({
    title: expired ? `${subject} (${account}) has expired` : `${subject} (${account}) expires in ${decision.daysRemaining} day${decision.daysRemaining === 1 ? "" : "s"}`,
    lines: [`Expiry: **${date}**. Refresh it before then so trophy updates keep flowing.`, ...refreshSteps()],
  });
}
