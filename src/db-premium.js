// SQL for the Platinum (premium) tier. Same conventions as db.js: query functions cost one
// subrequest each; `*Statement` builders are meant to be batched.

const LINKED_CTE = `linked AS (
  SELECT psn_id, MIN(id) AS link_id, MIN(discord_id) AS discord_id, MIN(psn_username) AS link_name
  FROM psn_users
  WHERE guild_id = ?1
  GROUP BY psn_id
)`;

export function isPremiumSql(guildColumn, nowParam) {
  return `EXISTS (SELECT 1 FROM premium_guilds p WHERE p.guild_id = ${guildColumn} AND (p.expires_at IS NULL OR p.expires_at > ${nowParam}))`;
}

// ---------------------------------------------------------------------------------------
// Premium status.

export async function getActivePremiumGuilds(ctx, now) {
  const { results = [] } = await ctx.db
    .prepare(
      `SELECT guild_id, source, note, granted_at, expires_at, welcome_status FROM premium_guilds
       WHERE expires_at IS NULL OR expires_at > ?1 ORDER BY granted_at`
    )
    .bind(now)
    .all();
  return results;
}

// Premium flag plus branding for one server, in one query. `premium_sku` is the background
// job's latest check of PREMIUM_SKU_ID (whether buy buttons can be shown).
export async function getGuildBranding(ctx, guildId, now) {
  return ctx.db
    .prepare(
      `SELECT ${isPremiumSql("?1", "?2")} AS premium,
              (SELECT expires_at FROM premium_guilds WHERE guild_id = ?1) AS expires_at,
              (SELECT source FROM premium_guilds WHERE guild_id = ?1) AS premium_source,
              (SELECT value FROM job_state WHERE key = 'premium_sku') AS premium_sku,
              g.accent_color, g.emoji_json, g.weekly_day, g.weekly_hour, g.hunter_role_id,
              g.roles_error, g.leaderboard_channel_id, g.weekly_leaderboard_enabled
       FROM (SELECT ?1 AS gid) x
       LEFT JOIN guild_settings g ON g.guild_id = x.gid`
    )
    .bind(guildId, now)
    .first();
}

// `announce` queues a one-time welcome post in the server's bot channel (see welcomeStage).
export function grantPremiumStatement(ctx, { guildId, source, note, now, expiresAt, announce = false }) {
  return ctx.db
    .prepare(
      `INSERT INTO premium_guilds (guild_id, source, note, granted_at, expires_at, welcome_status) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT(guild_id) DO UPDATE SET source = excluded.source, note = COALESCE(excluded.note, premium_guilds.note),
         expires_at = excluded.expires_at, welcome_status = COALESCE(excluded.welcome_status, premium_guilds.welcome_status)`
    )
    .bind(guildId, source, note ?? null, now, expiresAt ?? null, announce ? "pending" : null);
}

// Servers with a welcome post waiting and a working bot channel to post it in. Servers
// without one keep waiting until an admin sets a channel (/weeklyleaderboard set).
export async function getPendingWelcomes(ctx, now, limit) {
  const { results = [] } = await ctx.db
    .prepare(
      `SELECT p.guild_id, p.expires_at, g.leaderboard_channel_id, g.accent_color, g.emoji_json
       FROM premium_guilds p JOIN guild_settings g ON g.guild_id = p.guild_id
       WHERE p.welcome_status = 'pending' AND (p.expires_at IS NULL OR p.expires_at > ?1)
         AND g.leaderboard_channel_id IS NOT NULL AND g.leaderboard_channel_id != '' AND g.channel_error IS NULL
       LIMIT ?2`
    )
    .bind(now, limit)
    .all();
  return results;
}

export function welcomeStatusStatement(ctx, guildId, status) {
  return ctx.db.prepare("UPDATE premium_guilds SET welcome_status = ?2 WHERE guild_id = ?1").bind(guildId, status);
}

// ---------------------------------------------------------------------------------------
// Server directory (names of the servers the bot is in), for /admin.

export function directoryStatement(ctx, { guildId, name, members, now }) {
  return ctx.db
    .prepare(
      `INSERT INTO guild_directory (guild_id, name, member_count, seen_at) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(guild_id) DO UPDATE SET name = excluded.name, member_count = excluded.member_count, seen_at = excluded.seen_at`
    )
    .bind(guildId, name, members ?? null, now);
}

// Servers not seen for a while: the bot was removed from them.
export function pruneDirectoryStatement(ctx, seenBefore) {
  return ctx.db.prepare("DELETE FROM guild_directory WHERE seen_at < ?1").bind(seenBefore);
}

export async function getDirectoryNames(ctx, guildIds) {
  const ids = [...new Set(guildIds)].slice(0, 90);
  if (ids.length === 0) return new Map();
  const { results = [] } = await ctx.db
    .prepare(`SELECT guild_id, name FROM guild_directory WHERE guild_id IN (${ids.map((_, i) => `?${i + 1}`).join(", ")})`)
    .bind(...ids)
    .all();
  return new Map(results.map((row) => [row.guild_id, row.name]));
}

// Servers whose name contains `query`, biggest first, with how many members linked accounts.
export async function findDirectory(ctx, query, limit) {
  const { results = [] } = await ctx.db
    .prepare(
      `SELECT d.guild_id, d.name, d.member_count,
              (SELECT COUNT(*) FROM psn_users u WHERE u.guild_id = d.guild_id) AS links,
              ${isPremiumSql("d.guild_id", "?2")} AS premium
       FROM guild_directory d
       WHERE d.name LIKE ?1
       ORDER BY COALESCE(d.member_count, 0) DESC
       LIMIT ?3`
    )
    .bind(`%${String(query).replace(/[%_]/g, "")}%`, Date.now(), limit)
    .all();
  return results;
}

// A paid subscription: only ever extends Platinum (a grant with no end date is left alone).
export function extendEntitlementStatement(ctx, { guildId, note, now, expiresAt }) {
  return ctx.db
    .prepare(
      `INSERT INTO premium_guilds (guild_id, source, note, granted_at, expires_at) VALUES (?1, 'entitlement', ?2, ?3, ?4)
       ON CONFLICT(guild_id) DO UPDATE SET source = 'entitlement', note = excluded.note, expires_at = excluded.expires_at
       WHERE premium_guilds.expires_at IS NOT NULL AND premium_guilds.expires_at < excluded.expires_at`
    )
    .bind(guildId, note, now, expiresAt);
}

export function revokePremiumStatement(ctx, guildId) {
  return ctx.db.prepare("DELETE FROM premium_guilds WHERE guild_id = ?1").bind(guildId);
}

// Refresh this server's accounts first after it gets Platinum.
export function prioritizeGuildRefreshStatement(ctx, guildId) {
  return ctx.db
    .prepare(
      `UPDATE psn_trophy_cache SET next_refresh_at = 0
       WHERE tracked = 1 AND last_error IS NULL AND psn_id IN (SELECT psn_id FROM psn_users WHERE guild_id = ?1)`
    )
    .bind(guildId);
}

// ---------------------------------------------------------------------------------------
// Settings.

function settingsUpsert(ctx, guildId, column, value, now) {
  return ctx.db
    .prepare(
      `INSERT INTO guild_settings (guild_id, weekly_leaderboard_enabled, updated_at, ${column}) VALUES (?1, 0, ?2, ?3)
       ON CONFLICT(guild_id) DO UPDATE SET ${column} = excluded.${column}, updated_at = excluded.updated_at`
    )
    .bind(guildId, now, value);
}

export const accentStatement = (ctx, guildId, color, now) => settingsUpsert(ctx, guildId, "accent_color", color, now);
export const emojiStatement = (ctx, guildId, json, now) => settingsUpsert(ctx, guildId, "emoji_json", json, now);
export const hunterRoleStatement = (ctx, guildId, roleId, now) => settingsUpsert(ctx, guildId, "hunter_role_id", roleId, now);
export const rolesErrorStatement = (ctx, guildId, error, now) => settingsUpsert(ctx, guildId, "roles_error", error, now);

export function weeklyScheduleStatement(ctx, guildId, day, hour, now) {
  return ctx.db
    .prepare(
      `INSERT INTO guild_settings (guild_id, weekly_leaderboard_enabled, updated_at, weekly_day, weekly_hour, last_weekly_post_at)
       VALUES (?1, 0, ?2, ?3, ?4, ?2)
       ON CONFLICT(guild_id) DO UPDATE SET weekly_day = excluded.weekly_day, weekly_hour = excluded.weekly_hour,
         last_weekly_post_at = MAX(COALESCE(guild_settings.last_weekly_post_at, 0), excluded.last_weekly_post_at),
         updated_at = excluded.updated_at`
    )
    .bind(guildId, now, day, hour);
}

// ---------------------------------------------------------------------------------------
// Milestone roles.

export async function getMilestones(ctx, guildId) {
  const { results = [] } = await ctx.db
    .prepare("SELECT platinums, role_id FROM milestone_roles WHERE guild_id = ?1 ORDER BY platinums")
    .bind(guildId)
    .all();
  return results;
}

export function addMilestoneStatement(ctx, guildId, platinums, roleId) {
  return ctx.db
    .prepare(
      `INSERT INTO milestone_roles (guild_id, platinums, role_id) VALUES (?1, ?2, ?3)
       ON CONFLICT(guild_id, platinums) DO UPDATE SET role_id = excluded.role_id`
    )
    .bind(guildId, platinums, roleId);
}

export function removeMilestoneStatement(ctx, guildId, platinums) {
  return ctx.db.prepare("DELETE FROM milestone_roles WHERE guild_id = ?1 AND platinums = ?2").bind(guildId, platinums);
}

// Premium servers with milestone roles (random order spreads the work across runs).
export async function getRoleSyncGuilds(ctx, now, limit) {
  const { results = [] } = await ctx.db
    .prepare(
      `SELECT m.guild_id FROM milestone_roles m
       JOIN premium_guilds p ON p.guild_id = m.guild_id AND (p.expires_at IS NULL OR p.expires_at > ?1)
       LEFT JOIN guild_settings g ON g.guild_id = m.guild_id
       WHERE g.roles_error IS NULL
       GROUP BY m.guild_id
       ORDER BY RANDOM()
       LIMIT ?2`
    )
    .bind(now, limit)
    .all();
  return results.map((row) => row.guild_id);
}

// Everything needed to work out role changes for one server, in one round trip.
export async function getRoleSyncData(ctx, guildId) {
  const [members, milestones, grants] = await ctx.db.batch([
    ctx.db
      .prepare(
        `SELECT u.discord_id, MAX(c.platinum) AS platinum
         FROM psn_users u JOIN psn_trophy_cache c ON c.psn_id = u.psn_id AND c.fetched_at > 0
         WHERE u.guild_id = ?1
         GROUP BY u.discord_id`
      )
      .bind(guildId),
    ctx.db.prepare("SELECT platinums, role_id FROM milestone_roles WHERE guild_id = ?1 ORDER BY platinums").bind(guildId),
    ctx.db.prepare("SELECT discord_id, role_id, granted_at FROM role_grants WHERE guild_id = ?1").bind(guildId),
  ]);
  return { members: members.results || [], milestones: milestones.results || [], grants: grants.results || [] };
}

export function roleGrantStatement(ctx, { guildId, discordId, roleId, now }) {
  return ctx.db
    .prepare(
      `INSERT INTO role_grants (guild_id, discord_id, role_id, granted_at) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(guild_id, discord_id, role_id) DO UPDATE SET granted_at = excluded.granted_at`
    )
    .bind(guildId, discordId, roleId, now);
}

export function roleRevokeStatement(ctx, { guildId, discordId, roleId }) {
  return ctx.db
    .prepare("DELETE FROM role_grants WHERE guild_id = ?1 AND discord_id = ?2 AND role_id = ?3")
    .bind(guildId, discordId, roleId);
}

// ---------------------------------------------------------------------------------------
// Monthly standings.

export function monthlyBaselineStatements(ctx, guildId, month, now) {
  return [
    ctx.db.prepare("DELETE FROM monthly_baselines WHERE guild_id = ?1").bind(guildId),
    ctx.db
      .prepare(
        `WITH ${LINKED_CTE}
         INSERT INTO monthly_baselines (guild_id, psn_id, month, platinum, gold, silver, bronze, total, baseline_at)
         SELECT ?1, l.psn_id, ?2, c.platinum, c.gold, c.silver, c.bronze, c.total, ?3
         FROM linked l JOIN psn_trophy_cache c ON c.psn_id = l.psn_id AND c.fetched_at > 0`
      )
      .bind(guildId, month, now),
    ctx.db
      .prepare(
        `INSERT INTO guild_settings (guild_id, weekly_leaderboard_enabled, updated_at, monthly_month) VALUES (?1, 0, ?2, ?3)
         ON CONFLICT(guild_id) DO UPDATE SET monthly_month = excluded.monthly_month, updated_at = excluded.updated_at`
      )
      .bind(guildId, now, month),
  ];
}

// Add a newly linked account to the running month without resetting anyone else.
export function joinMonthlyBaselineStatement(ctx, { guildId, psnId, stats, now }) {
  return ctx.db
    .prepare(
      `INSERT OR IGNORE INTO monthly_baselines (guild_id, psn_id, month, platinum, gold, silver, bronze, total, baseline_at)
       SELECT ?1, ?2, month, ?3, ?4, ?5, ?6, ?7, ?8 FROM (SELECT monthly_month AS month FROM guild_settings WHERE guild_id = ?1 AND monthly_month IS NOT NULL)`
    )
    .bind(guildId, psnId, stats.platinum, stats.gold, stats.silver, stats.bronze, stats.total, now);
}

export async function getMonthlyStandings(ctx, guildId, limit) {
  const [rows, meta] = await ctx.db.batch([
    ctx.db
      .prepare(
        `WITH ${LINKED_CTE}
         SELECT l.psn_id, l.discord_id, COALESCE(NULLIF(c.psn_username, ''), l.link_name) AS name, c.avatar_url,
                MAX(c.platinum - b.platinum, 0) AS platinum_gain, MAX(c.gold - b.gold, 0) AS gold_gain,
                MAX(c.silver - b.silver, 0) AS silver_gain, MAX(c.bronze - b.bronze, 0) AS bronze_gain,
                MAX(c.total - b.total, 0) AS total_gain
         FROM linked l
         JOIN monthly_baselines b ON b.guild_id = ?1 AND b.psn_id = l.psn_id
         JOIN psn_trophy_cache c ON c.psn_id = l.psn_id AND c.fetched_at > 0
         WHERE c.total > b.total
         ORDER BY platinum_gain DESC, total_gain DESC, lower(name)
         LIMIT ?2`
      )
      .bind(guildId, limit),
    ctx.db
      .prepare("SELECT MIN(month) AS month, MIN(baseline_at) AS baseline_at, COUNT(*) AS tracked FROM monthly_baselines WHERE guild_id = ?1")
      .bind(guildId),
  ]);
  const info = meta.results?.[0] || {};
  return {
    hasBaseline: Number(info.tracked || 0) > 0,
    month: info.month || null,
    baselineAt: Number(info.baseline_at || 0),
    trackedCount: Number(info.tracked || 0),
    movers: rows.results || [],
  };
}

// Premium servers whose monthly cycle has not caught up with the current month.
export async function getMonthlyDueGuilds(ctx, month, now, limit) {
  const { results = [] } = await ctx.db
    .prepare(
      `SELECT p.guild_id, g.monthly_month, g.leaderboard_channel_id, g.channel_error, g.hunter_role_id,
              g.hunter_discord_id, g.accent_color, g.emoji_json
       FROM premium_guilds p
       LEFT JOIN guild_settings g ON g.guild_id = p.guild_id
       WHERE (p.expires_at IS NULL OR p.expires_at > ?2)
         AND (g.monthly_month IS NULL OR g.monthly_month < ?1)
       ORDER BY RANDOM()
       LIMIT ?3`
    )
    .bind(month, now, limit)
    .all();
  return results;
}

export function hunterHolderStatement(ctx, guildId, discordId, now) {
  return settingsUpsert(ctx, guildId, "hunter_discord_id", discordId, now);
}

// ---------------------------------------------------------------------------------------
// Races.

export async function getActiveRace(ctx, guildId) {
  return ctx.db
    .prepare("SELECT * FROM races WHERE guild_id = ?1 AND status = 'active' ORDER BY started_at DESC LIMIT 1")
    .bind(guildId)
    .first();
}

export function createRaceStatement(ctx, race) {
  return ctx.db
    .prepare(
      `INSERT INTO races (id, guild_id, channel_id, np_communication_id, np_service_name, title_name, title_icon_url, platform,
         created_by, started_at, ends_at, status)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'active')`
    )
    .bind(
      race.id,
      race.guildId,
      race.channelId ?? null,
      race.npCommunicationId,
      race.npServiceName ?? null,
      race.titleName,
      race.titleIconUrl ?? null,
      race.platform ?? null,
      race.createdBy,
      race.startedAt,
      race.endsAt
    );
}

export function endRaceStatement(ctx, raceId) {
  return ctx.db.prepare("UPDATE races SET status = 'ended' WHERE id = ?1").bind(raceId);
}

export function joinRaceStatement(ctx, { raceId, psnId, discordId, name, now }) {
  return ctx.db
    .prepare(
      `INSERT OR IGNORE INTO race_participants (race_id, psn_id, discord_id, name, joined_at, checked_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 0)`
    )
    .bind(raceId, psnId, discordId, name, now);
}

export function leaveRaceStatement(ctx, raceId, discordId) {
  return ctx.db.prepare("DELETE FROM race_participants WHERE race_id = ?1 AND discord_id = ?2").bind(raceId, discordId);
}

export async function getRaceParticipants(ctx, raceId) {
  const { results = [] } = await ctx.db
    .prepare(
      `SELECT * FROM race_participants WHERE race_id = ?1
       ORDER BY CASE WHEN finished_at IS NULL THEN 1 ELSE 0 END, finished_at, progress DESC, earned_total DESC, lower(name)`
    )
    .bind(raceId)
    .all();
  return results;
}

// Participants of active races in premium servers that are due for a progress check.
export async function getRaceChecksDue(ctx, now, staleBefore, limit) {
  const { results = [] } = await ctx.db
    .prepare(
      `SELECT rp.race_id, rp.psn_id, rp.discord_id, rp.name, rp.progress, rp.finished_at,
              r.guild_id, r.channel_id, r.np_communication_id, r.np_service_name, r.title_name, r.title_icon_url, r.platform,
              r.ends_at, g.accent_color, g.emoji_json
       FROM race_participants rp
       JOIN races r ON r.id = rp.race_id AND r.status = 'active' AND r.ends_at > ?1
       LEFT JOIN guild_settings g ON g.guild_id = r.guild_id
       WHERE rp.finished_at IS NULL AND rp.checked_at < ?2
         AND ${isPremiumSql("r.guild_id", "?1")}
       ORDER BY rp.checked_at
       LIMIT ?3`
    )
    .bind(now, staleBefore, limit)
    .all();
  return results;
}

export function raceProgressStatement(ctx, { raceId, psnId, progress, earnedTotal, finishedAt, now }) {
  return ctx.db
    .prepare(
      `UPDATE race_participants SET progress = ?3, earned_total = ?4, checked_at = ?6,
         finished_at = COALESCE(finished_at, ?5)
       WHERE race_id = ?1 AND psn_id = ?2`
    )
    .bind(raceId, psnId, progress, earnedTotal, finishedAt ?? null, now);
}

export async function getRacesEnding(ctx, now, limit) {
  const { results = [] } = await ctx.db
    .prepare(
      `SELECT r.*, g.accent_color, g.emoji_json FROM races r LEFT JOIN guild_settings g ON g.guild_id = r.guild_id
       WHERE r.status = 'active' AND r.ends_at <= ?1 ORDER BY r.ends_at LIMIT ?2`
    )
    .bind(now, limit)
    .all();
  return results;
}

export async function getFinishCount(ctx, raceId) {
  const row = await ctx.db
    .prepare("SELECT COUNT(*) AS n FROM race_participants WHERE race_id = ?1 AND finished_at IS NOT NULL")
    .bind(raceId)
    .first();
  return Number(row?.n || 0);
}

// ---------------------------------------------------------------------------------------
// Games known to this server (from stored game lists), for autocomplete and per-game boards.

export async function searchGuildTitles(ctx, guildId, query, limit = 25) {
  const { results = [] } = await ctx.db
    .prepare(
      `SELECT s.np_communication_id, MAX(s.title_name) AS title_name, MAX(s.platform) AS platform, COUNT(DISTINCT s.psn_id) AS players
       FROM psn_title_snapshots s
       WHERE s.psn_id IN (SELECT psn_id FROM psn_users WHERE guild_id = ?1)
         AND s.title_name LIKE ?2
       GROUP BY s.np_communication_id
       ORDER BY players DESC, title_name
       LIMIT ?3`
    )
    .bind(guildId, `%${query.replace(/[%_]/g, "")}%`, limit)
    .all();
  return results;
}

export async function listGuildTitles(ctx, guildId, limit) {
  const { results = [] } = await ctx.db
    .prepare(
      `SELECT s.np_communication_id, MAX(s.title_name) AS title_name, MAX(s.platform) AS platform, COUNT(DISTINCT s.psn_id) AS players
       FROM psn_title_snapshots s
       WHERE s.psn_id IN (SELECT psn_id FROM psn_users WHERE guild_id = ?1)
       GROUP BY s.np_communication_id
       ORDER BY players DESC, title_name
       LIMIT ?2`
    )
    .bind(guildId, limit)
    .all();
  return results;
}

export async function getGuildTitle(ctx, guildId, npCommunicationId) {
  return ctx.db
    .prepare(
      `SELECT np_communication_id, MAX(title_name) AS title_name, MAX(title_icon_url) AS title_icon_url,
              MAX(platform) AS platform, MAX(np_service_name) AS np_service_name
       FROM psn_title_snapshots
       WHERE np_communication_id = ?2 AND psn_id IN (SELECT psn_id FROM psn_users WHERE guild_id = ?1)
       GROUP BY np_communication_id`
    )
    .bind(guildId, npCommunicationId)
    .first();
}

export async function getGameBoard(ctx, guildId, npCommunicationId, limit) {
  const { results = [] } = await ctx.db
    .prepare(
      `WITH ${LINKED_CTE}
       SELECT l.psn_id, l.discord_id, COALESCE(NULLIF(c.psn_username, ''), l.link_name) AS name,
              s.progress, s.earned_platinum AS platinum, s.earned_gold AS gold, s.earned_silver AS silver,
              s.earned_bronze AS bronze, s.total, s.last_updated_at, s.title_name, s.title_icon_url, s.platform,
              COUNT(*) OVER () AS players
       FROM linked l
       JOIN psn_title_snapshots s ON s.psn_id = l.psn_id AND s.np_communication_id = ?2
       LEFT JOIN psn_trophy_cache c ON c.psn_id = l.psn_id
       ORDER BY s.earned_platinum DESC, s.progress DESC, s.total DESC, lower(name)
       LIMIT ?3`
    )
    .bind(guildId, npCommunicationId, limit)
    .all();
  return results;
}

// ---------------------------------------------------------------------------------------
// Trophy history (premium accounts, one row per day).

export function historyStatement(ctx, { psnId, day, stats }) {
  return ctx.db
    .prepare(
      `INSERT INTO trophy_history (psn_id, day, platinum, gold, silver, bronze, total, trophy_level)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
       ON CONFLICT(psn_id, day) DO UPDATE SET platinum = excluded.platinum, gold = excluded.gold, silver = excluded.silver,
         bronze = excluded.bronze, total = excluded.total, trophy_level = excluded.trophy_level`
    )
    .bind(psnId, day, stats.platinum, stats.gold, stats.silver, stats.bronze, stats.total, stats.trophyLevel ?? null);
}

export async function getHistory(ctx, psnIds, sinceDay) {
  if (psnIds.length === 0) return [];
  const placeholders = psnIds.map((_, index) => `?${index + 2}`).join(", ");
  const { results = [] } = await ctx.db
    .prepare(`SELECT * FROM trophy_history WHERE day >= ?1 AND psn_id IN (${placeholders}) ORDER BY day`)
    .bind(sinceDay, ...psnIds)
    .all();
  return results;
}

// ---------------------------------------------------------------------------------------
// Game-list sync for premium accounts (feeds per-game boards and races).

export async function getTitleSyncDue(ctx, now, staleBefore, limit) {
  const { results = [] } = await ctx.db
    .prepare(
      `SELECT c.psn_id, c.psn_username FROM psn_trophy_cache c
       WHERE c.tracked = 1 AND c.last_error IS NULL AND c.titles_synced_at < ?2
         AND EXISTS (SELECT 1 FROM psn_users u JOIN premium_guilds p ON p.guild_id = u.guild_id
                     WHERE u.psn_id = c.psn_id AND (p.expires_at IS NULL OR p.expires_at > ?1))
       ORDER BY c.titles_synced_at
       LIMIT ?3`
    )
    .bind(now, staleBefore, limit)
    .all();
  return results;
}

export function titlesSyncedStatement(ctx, psnId, now) {
  return ctx.db.prepare("UPDATE psn_trophy_cache SET titles_synced_at = ?2 WHERE psn_id = ?1").bind(psnId, now);
}

// ---------------------------------------------------------------------------------------
// Premium weekly posts on a custom day/hour.

export async function getCustomWeeklyGuilds(ctx, now) {
  const { results = [] } = await ctx.db
    .prepare(
      `SELECT g.guild_id, g.leaderboard_channel_id, g.last_weekly_post_at, g.weekly_day, g.weekly_hour,
              g.accent_color, g.emoji_json
       FROM guild_settings g
       WHERE g.weekly_leaderboard_enabled = 1 AND g.weekly_day IS NOT NULL
         AND g.leaderboard_channel_id IS NOT NULL AND g.leaderboard_channel_id != '' AND g.channel_error IS NULL
         AND ${isPremiumSql("g.guild_id", "?1")}`
    )
    .bind(now)
    .all();
  return results;
}

// ---------------------------------------------------------------------------------------
// Owner statistics and exports.

export async function getOwnerStats(ctx, now) {
  const [totals, top, premium, health] = await ctx.db.batch([
    ctx.db.prepare(
      `SELECT COUNT(DISTINCT guild_id) AS servers, COUNT(*) AS links, COUNT(DISTINCT psn_id) AS accounts,
              COUNT(DISTINCT discord_id) AS people
       FROM psn_users`
    ),
    ctx.db.prepare(
      `SELECT guild_id, COUNT(*) AS links, COUNT(DISTINCT discord_id) AS people
       FROM psn_users GROUP BY guild_id ORDER BY links DESC LIMIT 5`
    ),
    ctx.db.prepare("SELECT COUNT(*) AS premium FROM premium_guilds WHERE expires_at IS NULL OR expires_at > ?1").bind(now),
    ctx.db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM guild_settings WHERE weekly_leaderboard_enabled = 1) AS weekly_servers,
           (SELECT COUNT(*) FROM psn_trophy_cache WHERE tracked = 1 AND fetched_at > ?1) AS fresh_6h,
           (SELECT COUNT(*) FROM psn_trophy_cache WHERE tracked = 1 AND last_error = 'private') AS private,
           (SELECT value FROM job_state WHERE key = 'psn_auth_error') AS auth_error,
           (SELECT MIN(refresh_token_expires_at) FROM psn_auth_state) AS login_expires`
      )
      .bind(now - 6 * 3600 * 1000),
  ]);

  return {
    totals: totals.results?.[0] || {},
    top: top.results || [],
    premium: Number(premium.results?.[0]?.premium || 0),
    health: health.results?.[0] || {},
  };
}

export async function getExportRows(ctx, guildId) {
  const { results = [] } = await ctx.db
    .prepare(
      `WITH ${LINKED_CTE}
       SELECT l.discord_id, COALESCE(NULLIF(c.psn_username, ''), l.link_name) AS name, c.trophy_level, c.platinum, c.gold,
              c.silver, c.bronze, c.total, c.fetched_at, c.last_error
       FROM linked l LEFT JOIN psn_trophy_cache c ON c.psn_id = l.psn_id
       ORDER BY (COALESCE(c.fetched_at, 0) = 0), c.platinum DESC, c.gold DESC, c.silver DESC, c.bronze DESC, lower(name)`
    )
    .bind(guildId)
    .all();
  return results;
}
