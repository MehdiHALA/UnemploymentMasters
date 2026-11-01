// Schema migrations and every SQL query the bot runs. Each exported query function costs
// exactly one subrequest; statement builders (`*Statement`) are meant to be batched.

const NOW_MS_SQL = "CAST(strftime('%s', 'now') AS INTEGER) * 1000";

const MIGRATIONS = [
  {
    version: 1,
    statements: [
      `CREATE TABLE IF NOT EXISTS psn_users (
        id TEXT PRIMARY KEY,
        discord_id TEXT NOT NULL,
        guild_id TEXT NOT NULL,
        psn_username TEXT NOT NULL,
        psn_id TEXT NOT NULL
      )`,
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
      )`,
      `CREATE TABLE IF NOT EXISTS guild_settings (
        guild_id TEXT PRIMARY KEY,
        leaderboard_channel_id TEXT,
        weekly_leaderboard_enabled INTEGER NOT NULL DEFAULT 0,
        last_weekly_post_at INTEGER,
        updated_at INTEGER NOT NULL
      )`,
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
      )`,
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
      )`,
      `CREATE TABLE IF NOT EXISTS job_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS psn_username_cache (
        normalized_username TEXT PRIMARY KEY,
        psn_username TEXT NOT NULL,
        psn_id TEXT NOT NULL,
        fetched_at INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS psn_auth_state (
        key TEXT PRIMARY KEY,
        access_token TEXT,
        access_token_expires_at INTEGER,
        id_token TEXT,
        refresh_token TEXT,
        refresh_token_expires_at INTEGER,
        scope TEXT,
        token_type TEXT,
        updated_at INTEGER NOT NULL
      )`,
      "CREATE INDEX IF NOT EXISTS idx_psn_users_guild_id ON psn_users (guild_id)",
      "CREATE INDEX IF NOT EXISTS idx_psn_users_discord_guild ON psn_users (guild_id, discord_id)",
      "CREATE INDEX IF NOT EXISTS idx_psn_title_snapshots_psn_id ON psn_title_snapshots (psn_id)",
      "CREATE INDEX IF NOT EXISTS idx_weekly_trophy_baselines_guild_id ON weekly_trophy_baselines (guild_id)",
      "CREATE INDEX IF NOT EXISTS idx_psn_username_cache_psn_id ON psn_username_cache (psn_id)",
    ],
  },
  {
    version: 2,
    statements: [
      "ALTER TABLE psn_users ADD COLUMN created_at INTEGER",
      "ALTER TABLE psn_trophy_cache ADD COLUMN tier INTEGER",
      "ALTER TABLE psn_trophy_cache ADD COLUMN avatar_url TEXT",
      "ALTER TABLE psn_trophy_cache ADD COLUMN is_plus INTEGER",
      "ALTER TABLE psn_trophy_cache ADD COLUMN tracked INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE psn_trophy_cache ADD COLUMN next_refresh_at INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE psn_trophy_cache ADD COLUMN fail_count INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE psn_trophy_cache ADD COLUMN last_error TEXT",
      "ALTER TABLE psn_trophy_cache ADD COLUMN profile_checked_at INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE psn_trophy_cache ADD COLUMN alert_platinum INTEGER",
      "ALTER TABLE psn_trophy_cache ADD COLUMN alert_synced_at INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE guild_settings ADD COLUMN channel_error TEXT",
      "ALTER TABLE psn_title_snapshots ADD COLUMN platinum_seen_at INTEGER",
      `CREATE TABLE IF NOT EXISTS psn_platinum_alerts (
        psn_id TEXT NOT NULL,
        np_communication_id TEXT NOT NULL,
        alerted_at INTEGER NOT NULL,
        PRIMARY KEY (psn_id, np_communication_id)
      )`,
      `CREATE TABLE IF NOT EXISTS rate_limits (
        key TEXT PRIMARY KEY,
        window_start INTEGER NOT NULL,
        used INTEGER NOT NULL,
        cooldown_until INTEGER NOT NULL DEFAULT 0
      )`,
      // Every linked account gets a cache row so the background refresher can find it.
      `INSERT OR IGNORE INTO psn_trophy_cache (psn_id, psn_username, fetched_at)
       SELECT psn_id, MIN(psn_username), 0 FROM psn_users GROUP BY psn_id`,
      `UPDATE psn_trophy_cache SET
         tracked = CASE WHEN psn_id IN (SELECT psn_id FROM psn_users) THEN 1 ELSE 0 END,
         next_refresh_at = CASE WHEN fetched_at > 0 THEN fetched_at + 21600000 ELSE 0 END,
         alert_platinum = CASE WHEN fetched_at > 0 THEN platinum ELSE NULL END,
         alert_synced_at = ${NOW_MS_SQL}`,
      // Platinums already on record are "old news" for the new alert logic.
      "UPDATE psn_title_snapshots SET platinum_seen_at = 0 WHERE earned_platinum > 0",
      "CREATE INDEX IF NOT EXISTS idx_cache_refresh ON psn_trophy_cache (tracked, next_refresh_at)",
      "CREATE INDEX IF NOT EXISTS idx_cache_profile ON psn_trophy_cache (tracked, profile_checked_at)",
      "CREATE INDEX IF NOT EXISTS idx_cache_alert_pending ON psn_trophy_cache (alert_synced_at) WHERE platinum > alert_platinum",
      "CREATE INDEX IF NOT EXISTS idx_psn_users_psn_id ON psn_users (psn_id)",
      "CREATE INDEX IF NOT EXISTS idx_psn_users_guild_psn ON psn_users (guild_id, psn_id)",
      "CREATE INDEX IF NOT EXISTS idx_baselines_guild_psn ON weekly_trophy_baselines (guild_id, psn_id)",
    ],
  },
  {
    // Platinum (premium) tier.
    version: 3,
    statements: [
      `CREATE TABLE IF NOT EXISTS premium_guilds (
        guild_id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        note TEXT,
        granted_at INTEGER NOT NULL,
        expires_at INTEGER,
        welcome_status TEXT
      )`,
      // Names of the servers the bot is in, refreshed daily, for the owner's /admin tools.
      `CREATE TABLE IF NOT EXISTS guild_directory (
        guild_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        member_count INTEGER,
        seen_at INTEGER NOT NULL
      )`,
      "ALTER TABLE guild_settings ADD COLUMN accent_color INTEGER",
      "ALTER TABLE guild_settings ADD COLUMN emoji_json TEXT",
      "ALTER TABLE guild_settings ADD COLUMN weekly_day INTEGER",
      "ALTER TABLE guild_settings ADD COLUMN weekly_hour INTEGER",
      "ALTER TABLE guild_settings ADD COLUMN hunter_role_id TEXT",
      "ALTER TABLE guild_settings ADD COLUMN hunter_discord_id TEXT",
      "ALTER TABLE guild_settings ADD COLUMN monthly_month TEXT",
      "ALTER TABLE guild_settings ADD COLUMN roles_error TEXT",
      "ALTER TABLE psn_trophy_cache ADD COLUMN titles_synced_at INTEGER NOT NULL DEFAULT 0",
      `CREATE TABLE IF NOT EXISTS milestone_roles (
        guild_id TEXT NOT NULL,
        platinums INTEGER NOT NULL,
        role_id TEXT NOT NULL,
        PRIMARY KEY (guild_id, platinums)
      )`,
      `CREATE TABLE IF NOT EXISTS role_grants (
        guild_id TEXT NOT NULL,
        discord_id TEXT NOT NULL,
        role_id TEXT NOT NULL,
        granted_at INTEGER NOT NULL,
        PRIMARY KEY (guild_id, discord_id, role_id)
      )`,
      `CREATE TABLE IF NOT EXISTS monthly_baselines (
        guild_id TEXT NOT NULL,
        psn_id TEXT NOT NULL,
        month TEXT NOT NULL,
        platinum INTEGER NOT NULL DEFAULT 0,
        gold INTEGER NOT NULL DEFAULT 0,
        silver INTEGER NOT NULL DEFAULT 0,
        bronze INTEGER NOT NULL DEFAULT 0,
        total INTEGER NOT NULL DEFAULT 0,
        baseline_at INTEGER NOT NULL,
        PRIMARY KEY (guild_id, psn_id)
      )`,
      `CREATE TABLE IF NOT EXISTS races (
        id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        channel_id TEXT,
        np_communication_id TEXT NOT NULL,
        np_service_name TEXT,
        title_name TEXT NOT NULL,
        title_icon_url TEXT,
        platform TEXT,
        created_by TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ends_at INTEGER NOT NULL,
        status TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS race_participants (
        race_id TEXT NOT NULL,
        psn_id TEXT NOT NULL,
        discord_id TEXT NOT NULL,
        name TEXT NOT NULL,
        progress INTEGER NOT NULL DEFAULT 0,
        earned_total INTEGER NOT NULL DEFAULT 0,
        finished_at INTEGER,
        joined_at INTEGER NOT NULL,
        checked_at INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (race_id, psn_id)
      )`,
      `CREATE TABLE IF NOT EXISTS trophy_history (
        psn_id TEXT NOT NULL,
        day TEXT NOT NULL,
        platinum INTEGER NOT NULL DEFAULT 0,
        gold INTEGER NOT NULL DEFAULT 0,
        silver INTEGER NOT NULL DEFAULT 0,
        bronze INTEGER NOT NULL DEFAULT 0,
        total INTEGER NOT NULL DEFAULT 0,
        trophy_level INTEGER,
        PRIMARY KEY (psn_id, day)
      )`,
      "CREATE INDEX IF NOT EXISTS idx_races_guild_status ON races (guild_id, status)",
      "CREATE INDEX IF NOT EXISTS idx_races_status_ends ON races (status, ends_at)",
      "CREATE INDEX IF NOT EXISTS idx_snapshots_title ON psn_title_snapshots (np_communication_id)",
    ],
  },
];

export const SCHEMA_VERSION = MIGRATIONS.at(-1).version;

let schemaReady = null;

// Runs pending migrations once per isolate. When the schema is current this costs a single
// query per isolate, instead of re-running every CREATE statement on every command.
export function ensureSchema(ctx) {
  if (!schemaReady) {
    schemaReady = migrate(ctx).catch((err) => {
      schemaReady = null;
      throw err;
    });
  }
  return schemaReady;
}

export function resetSchemaCacheForTests() {
  schemaReady = null;
}

async function readSchemaVersion(ctx) {
  try {
    const row = await ctx.db.prepare("SELECT value FROM job_state WHERE key = 'schema_version'").first();
    return Number(row?.value || 0);
  } catch (err) {
    if (/no such table/i.test(String(err?.message))) return 0;
    throw err;
  }
}

async function migrate(ctx) {
  let version = await readSchemaVersion(ctx);

  for (const migration of MIGRATIONS) {
    if (migration.version <= version) continue;

    const statements = [
      ...migration.statements.map((sql) => ctx.db.prepare(sql)),
      ctx.db
        .prepare(
          `INSERT INTO job_state (key, value, updated_at) VALUES ('schema_version', ?1, ?2)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
        )
        .bind(String(migration.version), Date.now()),
    ];

    try {
      await ctx.db.batch(statements);
      version = migration.version;
    } catch (err) {
      // Another isolate may have applied it at the same time.
      const current = await readSchemaVersion(ctx);
      if (current >= migration.version) {
        version = current;
        continue;
      }
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------------------
// Leaderboard reads: one query, ranked and paged inside D1, independent of server size.

const LINKED_CTE = `linked AS (
  SELECT psn_id, MIN(id) AS link_id, MIN(discord_id) AS discord_id, MIN(psn_username) AS link_name
  FROM psn_users
  WHERE guild_id = ?1
  GROUP BY psn_id
)`;

const RANKED_CTE = `ranked AS (
  SELECT l.psn_id, l.link_id, l.discord_id,
         COALESCE(NULLIF(c.psn_username, ''), l.link_name) AS name,
         c.avatar_url, c.trophy_level, c.progress, c.tier, c.is_plus, c.last_error,
         COALESCE(c.platinum, 0) AS platinum, COALESCE(c.gold, 0) AS gold,
         COALESCE(c.silver, 0) AS silver, COALESCE(c.bronze, 0) AS bronze,
         COALESCE(c.total, 0) AS total, COALESCE(c.fetched_at, 0) AS fetched_at,
         ROW_NUMBER() OVER (
           ORDER BY (COALESCE(c.fetched_at, 0) = 0),
                    COALESCE(c.platinum, 0) DESC, COALESCE(c.gold, 0) DESC,
                    COALESCE(c.silver, 0) DESC, COALESCE(c.bronze, 0) DESC,
                    lower(COALESCE(NULLIF(c.psn_username, ''), l.link_name))
         ) AS rank,
         COUNT(*) OVER () AS linked_count,
         SUM(CASE WHEN COALESCE(c.fetched_at, 0) = 0 THEN 1 ELSE 0 END) OVER () AS pending_count,
         SUM(CASE WHEN COALESCE(c.fetched_at, 0) = 0 AND c.last_error = 'private' THEN 1 ELSE 0 END) OVER () AS private_count,
         MAX(COALESCE(c.fetched_at, 0)) OVER () AS updated_at
  FROM linked l
  LEFT JOIN psn_trophy_cache c ON c.psn_id = l.psn_id
)`;

function summarizeRanking(rows) {
  const first = rows[0];
  const linked = Number(first?.linked_count || 0);
  const pending = Number(first?.pending_count || 0);
  return {
    linkedCount: linked,
    pendingCount: pending,
    privateCount: Number(first?.private_count || 0),
    rankedCount: linked - pending,
    updatedAt: Number(first?.updated_at || 0),
  };
}

function leaderboardPageStatement(ctx, guildId, page, pageSize) {
  const start = (page - 1) * pageSize;
  // `OR rank = 1` guarantees the window totals come back even for an out-of-range page.
  return ctx.db
    .prepare(
      `WITH ${LINKED_CTE}, ${RANKED_CTE}
       SELECT * FROM ranked WHERE (rank > ?2 AND rank <= ?3) OR rank = 1 ORDER BY rank`
    )
    .bind(guildId, start, start + pageSize);
}

function parseLeaderboardPage(results = [], page, pageSize) {
  const start = (page - 1) * pageSize;
  const rows = results.filter((row) => row.rank > start && row.rank <= start + pageSize && row.fetched_at > 0);
  return { ...summarizeRanking(results), rows };
}

export async function getLeaderboardPage(ctx, guildId, page, pageSize) {
  const { results = [] } = await leaderboardPageStatement(ctx, guildId, page, pageSize).all();
  return parseLeaderboardPage(results, page, pageSize);
}

// Page 1 plus weekly movers in a single round trip (used by weekly posts).
export async function getWeeklyData(ctx, guildId, pageSize) {
  const [board, movers, meta] = await ctx.db.batch([
    leaderboardPageStatement(ctx, guildId, 1, pageSize),
    ...moversStatements(ctx, guildId, pageSize),
  ]);
  return {
    board: parseLeaderboardPage(board.results, 1, pageSize),
    movers: parseMovers(movers, meta),
  };
}

export async function getRankNeighborhood(ctx, guildId, discordId) {
  const { results = [] } = await ctx.db
    .prepare(
      `WITH ${LINKED_CTE}, ${RANKED_CTE},
       mine AS (
         SELECT rank FROM ranked
         WHERE fetched_at > 0
           AND psn_id IN (SELECT psn_id FROM psn_users WHERE guild_id = ?1 AND discord_id = ?2)
       )
       SELECT r.*, CASE WHEN r.rank IN (SELECT rank FROM mine) THEN 1 ELSE 0 END AS is_mine
       FROM ranked r
       WHERE r.rank = 1
          OR (r.fetched_at > 0 AND (
               r.rank IN (SELECT rank FROM mine)
            OR r.rank IN (SELECT rank - 1 FROM mine)
            OR r.rank IN (SELECT rank + 1 FROM mine)))
       ORDER BY r.rank`
    )
    .bind(guildId, discordId)
    .all();

  const summary = summarizeRanking(results);
  const rows = results.filter((row) => row.fetched_at > 0 && (row.is_mine || results.some((m) => m.is_mine && Math.abs(m.rank - row.rank) === 1)));
  return { ...summary, rows };
}

// A member's linked accounts with their stats and server rank (pending ones included).
export async function getMemberAccounts(ctx, guildId, discordId) {
  const { results = [] } = await ctx.db
    .prepare(
      `WITH ${LINKED_CTE}, ${RANKED_CTE},
       member AS (SELECT psn_id FROM psn_users WHERE guild_id = ?1 AND discord_id = ?2)
       SELECT r.*, CASE WHEN r.psn_id IN (SELECT psn_id FROM member) THEN 1 ELSE 0 END AS is_member
       FROM ranked r
       WHERE r.rank = 1 OR r.psn_id IN (SELECT psn_id FROM member)
       ORDER BY r.rank`
    )
    .bind(guildId, discordId)
    .all();

  return { ...summarizeRanking(results), rows: results.filter((row) => row.is_member) };
}

export async function getMemberLinks(ctx, guildId, discordId) {
  const { results = [] } = await ctx.db
    .prepare(
      `SELECT u.id, u.psn_id, u.psn_username, c.psn_username AS cache_name, c.avatar_url
       FROM psn_users u
       LEFT JOIN psn_trophy_cache c ON c.psn_id = u.psn_id
       WHERE u.guild_id = ?1 AND u.discord_id = ?2
       ORDER BY lower(u.psn_username)`
    )
    .bind(guildId, discordId)
    .all();
  return results;
}

export async function findGuildLink(ctx, guildId, psnId) {
  return ctx.db
    .prepare("SELECT discord_id FROM psn_users WHERE guild_id = ?1 AND psn_id = ?2 LIMIT 1")
    .bind(guildId, psnId)
    .first();
}

export async function getCacheRows(ctx, psnIds) {
  if (psnIds.length === 0) return [];
  const placeholders = psnIds.map((_, index) => `?${index + 1}`).join(", ");
  const { results = [] } = await ctx.db
    .prepare(`SELECT * FROM psn_trophy_cache WHERE psn_id IN (${placeholders})`)
    .bind(...psnIds)
    .all();
  return results;
}

// ---------------------------------------------------------------------------------------
// Weekly movers and baselines.

function moversStatements(ctx, guildId, limit) {
  return [
    ctx.db
      .prepare(
        `WITH ${LINKED_CTE},
         base AS (
           SELECT psn_id, MAX(platinum) AS platinum, MAX(gold) AS gold, MAX(silver) AS silver,
                  MAX(bronze) AS bronze, MAX(total) AS total
           FROM weekly_trophy_baselines WHERE guild_id = ?1 GROUP BY psn_id
         )
         SELECT l.psn_id, l.discord_id, COALESCE(NULLIF(c.psn_username, ''), l.link_name) AS name, c.avatar_url,
                MAX(c.platinum - b.platinum, 0) AS platinum_gain, MAX(c.gold - b.gold, 0) AS gold_gain,
                MAX(c.silver - b.silver, 0) AS silver_gain, MAX(c.bronze - b.bronze, 0) AS bronze_gain,
                MAX(c.total - b.total, 0) AS total_gain, c.platinum, c.total
         FROM linked l
         JOIN base b ON b.psn_id = l.psn_id
         JOIN psn_trophy_cache c ON c.psn_id = l.psn_id AND c.fetched_at > 0
         WHERE c.total > b.total
         ORDER BY platinum_gain DESC, total_gain DESC, gold_gain DESC, silver_gain DESC, bronze_gain DESC, lower(name)
         LIMIT ?2`
      )
      .bind(guildId, limit),
    ctx.db
      .prepare(
        `SELECT MIN(baseline_at) AS baseline_at, COUNT(DISTINCT psn_id) AS tracked
         FROM weekly_trophy_baselines WHERE guild_id = ?1`
      )
      .bind(guildId),
  ];
}

function parseMovers(movers, meta) {
  const info = meta?.results?.[0] || {};
  return {
    hasBaseline: Number(info.tracked || 0) > 0,
    baselineAt: Number(info.baseline_at || 0),
    trackedCount: Number(info.tracked || 0),
    movers: movers?.results || [],
  };
}

export async function getMovers(ctx, guildId, limit) {
  const [movers, meta] = await ctx.db.batch(moversStatements(ctx, guildId, limit));
  return parseMovers(movers, meta);
}

export function resetBaselineStatements(ctx, guildId, now) {
  return [
    ctx.db.prepare("DELETE FROM weekly_trophy_baselines WHERE guild_id = ?1").bind(guildId),
    ctx.db
      .prepare(
        `WITH ${LINKED_CTE}
         INSERT INTO weekly_trophy_baselines
           (id, guild_id, psn_user_id, psn_id, discord_id, psn_username, platinum, gold, silver, bronze, total, baseline_at)
         SELECT ?1 || ':' || l.psn_id, ?1, l.link_id, l.psn_id, l.discord_id,
                COALESCE(NULLIF(c.psn_username, ''), l.link_name),
                c.platinum, c.gold, c.silver, c.bronze, c.total, ?2
         FROM linked l
         JOIN psn_trophy_cache c ON c.psn_id = l.psn_id AND c.fetched_at > 0`
      )
      .bind(guildId, now),
  ];
}

// When someone links mid-week, start tracking their gains from now.
export function joinBaselineStatement(ctx, { guildId, linkId, psnId, discordId, name, stats, now }) {
  return ctx.db
    .prepare(
      `INSERT OR IGNORE INTO weekly_trophy_baselines
         (id, guild_id, psn_user_id, psn_id, discord_id, psn_username, platinum, gold, silver, bronze, total, baseline_at)
       SELECT ?1 || ':' || ?2, ?1, ?3, ?2, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11
       WHERE EXISTS (SELECT 1 FROM weekly_trophy_baselines WHERE guild_id = ?1)`
    )
    .bind(guildId, psnId, linkId, discordId, name, stats.platinum, stats.gold, stats.silver, stats.bronze, stats.total, now);
}

// ---------------------------------------------------------------------------------------
// Links.

export function linkStatement(ctx, { id, discordId, guildId, name, psnId, now }) {
  return ctx.db
    .prepare(
      `INSERT INTO psn_users (id, discord_id, guild_id, psn_username, psn_id, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT(id) DO UPDATE SET psn_username = excluded.psn_username, psn_id = excluded.psn_id`
    )
    .bind(id, discordId, guildId, name, psnId, now);
}

export function unlinkStatements(ctx, { guildId, discordId, psnId }) {
  return [
    ctx.db
      .prepare("DELETE FROM psn_users WHERE guild_id = ?1 AND discord_id = ?2 AND psn_id = ?3")
      .bind(guildId, discordId, psnId),
    ctx.db
      .prepare(
        `DELETE FROM weekly_trophy_baselines
         WHERE guild_id = ?1 AND psn_id = ?2
           AND NOT EXISTS (SELECT 1 FROM psn_users WHERE guild_id = ?1 AND psn_id = ?2)`
      )
      .bind(guildId, psnId),
    ctx.db
      .prepare(
        `UPDATE psn_trophy_cache
         SET tracked = CASE WHEN EXISTS (SELECT 1 FROM psn_users WHERE psn_id = ?1) THEN 1 ELSE 0 END
         WHERE psn_id = ?1`
      )
      .bind(psnId),
  ];
}

// ---------------------------------------------------------------------------------------
// Trophy cache.

export function identityStatement(ctx, { psnId, name, avatarUrl, isPlus, tracked, now }) {
  return ctx.db
    .prepare(
      `INSERT INTO psn_trophy_cache (psn_id, psn_username, fetched_at, tracked, next_refresh_at, avatar_url, is_plus, profile_checked_at)
       VALUES (?1, ?2, 0, ?3, 0, ?4, ?5, ?6)
       ON CONFLICT(psn_id) DO UPDATE SET
         psn_username = excluded.psn_username,
         tracked = MAX(psn_trophy_cache.tracked, excluded.tracked),
         avatar_url = COALESCE(excluded.avatar_url, psn_trophy_cache.avatar_url),
         is_plus = COALESCE(excluded.is_plus, psn_trophy_cache.is_plus),
         profile_checked_at = MAX(psn_trophy_cache.profile_checked_at, excluded.profile_checked_at)`
    )
    .bind(psnId, name, tracked ? 1 : 0, avatarUrl || null, isPlus === undefined || isPlus === null ? null : Number(Boolean(isPlus)), avatarUrl ? now : 0);
}

// Stores a fresh trophy summary. The first successful fetch also sets the platinum alert
// baseline, so linking an account never announces its old platinums.
export function statsStatement(ctx, { psnId, name, stats, now, nextRefreshAt, tracked = false }) {
  return ctx.db
    .prepare(
      `INSERT INTO psn_trophy_cache
         (psn_id, psn_username, trophy_level, progress, tier, platinum, gold, silver, bronze, total,
          fetched_at, tracked, next_refresh_at, fail_count, last_error, alert_platinum, alert_synced_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 0, NULL, ?6, ?11)
       ON CONFLICT(psn_id) DO UPDATE SET
         psn_username = COALESCE(NULLIF(psn_trophy_cache.psn_username, ''), excluded.psn_username),
         trophy_level = excluded.trophy_level,
         progress = excluded.progress,
         tier = excluded.tier,
         platinum = excluded.platinum,
         gold = excluded.gold,
         silver = excluded.silver,
         bronze = excluded.bronze,
         total = excluded.total,
         tracked = MAX(psn_trophy_cache.tracked, excluded.tracked),
         next_refresh_at = excluded.next_refresh_at,
         fail_count = 0,
         last_error = NULL,
         alert_platinum = CASE
           WHEN psn_trophy_cache.fetched_at = 0 OR psn_trophy_cache.alert_platinum IS NULL
             OR excluded.platinum < psn_trophy_cache.alert_platinum THEN excluded.platinum
           ELSE psn_trophy_cache.alert_platinum END,
         alert_synced_at = CASE
           WHEN psn_trophy_cache.fetched_at = 0 OR psn_trophy_cache.alert_platinum IS NULL
             OR excluded.platinum < psn_trophy_cache.alert_platinum THEN excluded.fetched_at
           ELSE psn_trophy_cache.alert_synced_at END,
         fetched_at = excluded.fetched_at`
    )
    .bind(
      psnId,
      name || psnId,
      stats.trophyLevel,
      stats.progress,
      stats.tier,
      stats.platinum,
      stats.gold,
      stats.silver,
      stats.bronze,
      stats.total,
      now,
      tracked ? 1 : 0,
      nextRefreshAt
    );
}

export function refreshFailureStatement(ctx, { psnId, error, nextRefreshAt }) {
  return ctx.db
    .prepare(
      `UPDATE psn_trophy_cache
       SET fail_count = fail_count + 1, last_error = ?2, next_refresh_at = ?3
       WHERE psn_id = ?1`
    )
    .bind(psnId, error, nextRefreshAt);
}

export function profileStatement(ctx, { psnId, name, avatarUrl, isPlus, now }) {
  return ctx.db
    .prepare(
      `UPDATE psn_trophy_cache
       SET psn_username = COALESCE(NULLIF(?2, ''), psn_username),
           avatar_url = COALESCE(?3, avatar_url),
           is_plus = COALESCE(?4, is_plus),
           profile_checked_at = ?5
       WHERE psn_id = ?1`
    )
    .bind(psnId, name || "", avatarUrl || null, isPlus === undefined || isPlus === null ? null : Number(Boolean(isPlus)), now);
}

// `is_premium` marks accounts linked in a Platinum server (refreshed more often, with history).
const IS_PREMIUM_ACCOUNT = `EXISTS (SELECT 1 FROM psn_users pu JOIN premium_guilds pg ON pg.guild_id = pu.guild_id
  WHERE pu.psn_id = psn_trophy_cache.psn_id AND (pg.expires_at IS NULL OR pg.expires_at > ?1)) AS is_premium`;

export async function getDueAccounts(ctx, now, limit, guildId = null) {
  const statement = guildId
    ? ctx.db
        .prepare(
          `SELECT psn_id, psn_username, platinum, fetched_at, fail_count, ${IS_PREMIUM_ACCOUNT} FROM psn_trophy_cache
           WHERE tracked = 1 AND next_refresh_at <= ?1
             AND psn_id IN (SELECT psn_id FROM psn_users WHERE guild_id = ?2)
           ORDER BY next_refresh_at LIMIT ?3`
        )
        .bind(now, guildId, limit)
    : ctx.db
        .prepare(
          `SELECT psn_id, psn_username, platinum, fetched_at, fail_count, ${IS_PREMIUM_ACCOUNT} FROM psn_trophy_cache
           WHERE tracked = 1 AND next_refresh_at <= ?1
           ORDER BY next_refresh_at LIMIT ?2`
        )
        .bind(now, limit);

  const { results = [] } = await statement.all();
  return results;
}

export async function getProfileBackfill(ctx, olderThan, limit) {
  const { results = [] } = await ctx.db
    .prepare(
      `SELECT psn_id, psn_username FROM psn_trophy_cache
       WHERE tracked = 1 AND profile_checked_at < ?1
       ORDER BY profile_checked_at LIMIT ?2`
    )
    .bind(olderThan, limit)
    .all();
  return results;
}

// ---------------------------------------------------------------------------------------
// Platinum alerts.

export async function getPendingAlerts(ctx, limit) {
  const { results = [] } = await ctx.db
    .prepare(
      `SELECT psn_id, psn_username, platinum, alert_platinum, alert_synced_at, avatar_url
       FROM psn_trophy_cache
       WHERE platinum > alert_platinum AND tracked = 1
       ORDER BY alert_synced_at LIMIT ?1`
    )
    .bind(limit)
    .all();
  return results;
}

export async function getAlertContext(ctx, psnId, communicationIds) {
  const ids = communicationIds.length > 0 ? communicationIds : [""];
  const placeholders = ids.map((_, index) => `?${index + 2}`).join(", ");
  const [snapshots, alerted, targets] = await ctx.db.batch([
    ctx.db
      .prepare(
        `SELECT np_communication_id, earned_platinum, platinum_seen_at FROM psn_title_snapshots
         WHERE psn_id = ?1 AND np_communication_id IN (${placeholders})`
      )
      .bind(psnId, ...ids),
    ctx.db
      .prepare(`SELECT np_communication_id FROM psn_platinum_alerts WHERE psn_id = ?1 AND np_communication_id IN (${placeholders})`)
      .bind(psnId, ...ids),
    ctx.db
      .prepare(
        `SELECT DISTINCT u.guild_id, g.leaderboard_channel_id AS channel_id, g.accent_color, g.emoji_json,
                EXISTS (SELECT 1 FROM premium_guilds p WHERE p.guild_id = u.guild_id
                        AND (p.expires_at IS NULL OR p.expires_at > ?2)) AS premium
         FROM psn_users u
         JOIN guild_settings g ON g.guild_id = u.guild_id
         WHERE u.psn_id = ?1 AND g.weekly_leaderboard_enabled = 1
           AND g.leaderboard_channel_id IS NOT NULL AND g.leaderboard_channel_id != ''
           AND g.channel_error IS NULL`
      )
      .bind(psnId, ctx.now ?? Date.now()),
  ]);

  return {
    snapshots: new Map((snapshots.results || []).map((row) => [row.np_communication_id, row])),
    alerted: new Set((alerted.results || []).map((row) => row.np_communication_id)),
    targets: targets.results || [],
  };
}

export function alertRecordStatement(ctx, { psnId, communicationId, now }) {
  return ctx.db
    .prepare("INSERT OR IGNORE INTO psn_platinum_alerts (psn_id, np_communication_id, alerted_at) VALUES (?1, ?2, ?3)")
    .bind(psnId, communicationId, now);
}

export function alertSyncedStatement(ctx, { psnId, platinum, now }) {
  return ctx.db
    .prepare("UPDATE psn_trophy_cache SET alert_platinum = ?2, alert_synced_at = ?3 WHERE psn_id = ?1")
    .bind(psnId, platinum, now);
}

// ---------------------------------------------------------------------------------------
// Title snapshots (game lists), stored only for linked accounts.

export function snapshotStatement(ctx, snapshot, now) {
  return ctx.db
    .prepare(
      `INSERT INTO psn_title_snapshots (
         id, psn_id, psn_username, np_communication_id, np_service_name, title_name, title_icon_url, platform,
         progress, earned_platinum, earned_gold, earned_silver, earned_bronze, total, last_updated_at, last_seen_at,
         last_alerted_platinum, platinum_seen_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?10,
               CASE WHEN ?10 > 0 THEN ?16 ELSE NULL END)
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
         platinum_seen_at = CASE
           WHEN psn_title_snapshots.platinum_seen_at IS NOT NULL THEN psn_title_snapshots.platinum_seen_at
           WHEN excluded.earned_platinum > 0 THEN excluded.last_seen_at
           ELSE NULL END`
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
      now
    );
}

export async function getCachedSnapshots(ctx, psnIds, { limit, platinumOnly = false }) {
  if (psnIds.length === 0) return [];
  const placeholders = psnIds.map((_, index) => `?${index + 2}`).join(", ");
  const { results = [] } = await ctx.db
    .prepare(
      `SELECT * FROM psn_title_snapshots
       WHERE psn_id IN (${placeholders}) ${platinumOnly ? "AND earned_platinum > 0" : ""}
       ORDER BY last_updated_at DESC, last_seen_at DESC
       LIMIT ?1`
    )
    .bind(limit, ...psnIds)
    .all();
  return results;
}

// ---------------------------------------------------------------------------------------
// Username cache.

export async function getUsernameCache(ctx, normalized) {
  return ctx.db.prepare("SELECT * FROM psn_username_cache WHERE normalized_username = ?1").bind(normalized).first();
}

export function usernameCacheStatement(ctx, { name, psnId, now }) {
  return ctx.db
    .prepare(
      `INSERT INTO psn_username_cache (normalized_username, psn_username, psn_id, fetched_at)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(normalized_username) DO UPDATE SET
         psn_username = excluded.psn_username, psn_id = excluded.psn_id, fetched_at = excluded.fetched_at`
    )
    .bind(name.toLowerCase(), name, psnId, now);
}

// ---------------------------------------------------------------------------------------
// Guild settings.

export async function getGuildSettings(ctx, guildId) {
  return ctx.db.prepare("SELECT * FROM guild_settings WHERE guild_id = ?1").bind(guildId).first();
}

export function enableWeeklyStatement(ctx, guildId, channelId, now) {
  return ctx.db
    .prepare(
      `INSERT INTO guild_settings (guild_id, leaderboard_channel_id, weekly_leaderboard_enabled, last_weekly_post_at, updated_at, channel_error)
       VALUES (?1, ?2, 1, ?3, ?3, NULL)
       ON CONFLICT(guild_id) DO UPDATE SET
         leaderboard_channel_id = excluded.leaderboard_channel_id,
         weekly_leaderboard_enabled = 1,
         channel_error = NULL,
         last_weekly_post_at = COALESCE(guild_settings.last_weekly_post_at, excluded.last_weekly_post_at),
         updated_at = excluded.updated_at`
    )
    .bind(guildId, channelId, now);
}

export function disableWeeklyStatement(ctx, guildId, now) {
  return ctx.db
    .prepare(
      `INSERT INTO guild_settings (guild_id, weekly_leaderboard_enabled, updated_at) VALUES (?1, 0, ?2)
       ON CONFLICT(guild_id) DO UPDATE SET weekly_leaderboard_enabled = 0, updated_at = excluded.updated_at`
    )
    .bind(guildId, now);
}

export function markWeeklyPostedStatement(ctx, guildId, now) {
  return ctx.db
    .prepare("UPDATE guild_settings SET last_weekly_post_at = ?2, updated_at = ?2 WHERE guild_id = ?1")
    .bind(guildId, now);
}

export function channelErrorStatement(ctx, guildId, error, now) {
  return ctx.db
    .prepare("UPDATE guild_settings SET channel_error = ?2, updated_at = ?3 WHERE guild_id = ?1")
    .bind(guildId, error, now);
}

// Servers due for the standard Sunday post. Platinum servers with their own schedule are
// handled by the premium job instead.
export async function getDueWeeklyGuilds(ctx, slotStart, limit, now = Date.now()) {
  const { results = [] } = await ctx.db
    .prepare(
      `SELECT g.guild_id, g.leaderboard_channel_id, g.accent_color, g.emoji_json,
              EXISTS (SELECT 1 FROM premium_guilds p WHERE p.guild_id = g.guild_id
                      AND (p.expires_at IS NULL OR p.expires_at > ?3)) AS premium
       FROM guild_settings g
       WHERE g.weekly_leaderboard_enabled = 1
         AND g.leaderboard_channel_id IS NOT NULL AND g.leaderboard_channel_id != ''
         AND g.channel_error IS NULL
         AND (g.last_weekly_post_at IS NULL OR g.last_weekly_post_at < ?1)
         AND NOT (g.weekly_day IS NOT NULL AND EXISTS (SELECT 1 FROM premium_guilds p WHERE p.guild_id = g.guild_id
                                                       AND (p.expires_at IS NULL OR p.expires_at > ?3)))
       ORDER BY COALESCE(g.last_weekly_post_at, 0)
       LIMIT ?2`
    )
    .bind(slotStart, limit, now)
    .all();
  return results;
}

// ---------------------------------------------------------------------------------------
// Job state and the shared PSN rate limiter.

export async function getJobState(ctx, keys) {
  const placeholders = keys.map((_, index) => `?${index + 1}`).join(", ");
  const { results = [] } = await ctx.db
    .prepare(`SELECT key, value FROM job_state WHERE key IN (${placeholders})`)
    .bind(...keys)
    .all();
  return new Map(results.map((row) => [row.key, row.value]));
}

export function jobStateStatement(ctx, key, value, now) {
  return ctx.db
    .prepare(
      `INSERT INTO job_state (key, value, updated_at) VALUES (?1, ?2, ?3)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .bind(key, String(value ?? ""), now);
}

// Reserves `wanted` PSN calls in the current 15-minute window; returns how many were granted.
export async function reserveRateLimit(ctx, { key, wanted, limit, windowMs, now }) {
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const row = await ctx.db
    .prepare(
      `INSERT INTO rate_limits (key, window_start, used, cooldown_until) VALUES (?1, ?2, ?3, 0)
       ON CONFLICT(key) DO UPDATE SET
         used = CASE WHEN rate_limits.window_start = excluded.window_start THEN rate_limits.used + excluded.used ELSE excluded.used END,
         window_start = excluded.window_start
       RETURNING used, cooldown_until`
    )
    .bind(key, windowStart, wanted)
    .first();

  if (Number(row?.cooldown_until || 0) > now) return 0;
  const usedBefore = Number(row?.used || wanted) - wanted;
  return Math.max(0, Math.min(wanted, limit - usedBefore));
}

export function rateLimitCooldownStatement(ctx, { key, until }) {
  return ctx.db.prepare("UPDATE rate_limits SET cooldown_until = ?2 WHERE key = ?1").bind(key, until);
}

// ---------------------------------------------------------------------------------------
// PSN auth state.

export async function getPsnAuthRecord(ctx, key) {
  return ctx.db.prepare("SELECT * FROM psn_auth_state WHERE key = ?1").bind(key).first();
}

export function psnAuthStatement(ctx, record) {
  return ctx.db
    .prepare(
      `INSERT INTO psn_auth_state (key, access_token, access_token_expires_at, id_token, refresh_token,
         refresh_token_expires_at, scope, token_type, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
       ON CONFLICT(key) DO UPDATE SET
         access_token = excluded.access_token,
         access_token_expires_at = excluded.access_token_expires_at,
         id_token = excluded.id_token,
         refresh_token = excluded.refresh_token,
         refresh_token_expires_at = excluded.refresh_token_expires_at,
         scope = excluded.scope,
         token_type = excluded.token_type,
         updated_at = excluded.updated_at`
    )
    .bind(
      record.key,
      record.access_token,
      record.access_token_expires_at,
      record.id_token,
      record.refresh_token,
      record.refresh_token_expires_at,
      record.scope,
      record.token_type,
      record.updated_at
    );
}

export function expireAccessTokenStatement(ctx, key) {
  return ctx.db.prepare("UPDATE psn_auth_state SET access_token_expires_at = 0 WHERE key = ?1").bind(key);
}

// ---------------------------------------------------------------------------------------
// Daily cleanup: keeps the database small and stops storing strangers' data forever.

export function cleanupStatements(ctx, now) {
  const month = now - 30 * 24 * 60 * 60 * 1000;
  return [
    ctx.db
      .prepare(
        `DELETE FROM psn_title_snapshots
         WHERE last_seen_at < ?1
           AND psn_id NOT IN (SELECT psn_id FROM psn_trophy_cache WHERE tracked = 1)`
      )
      .bind(month),
    ctx.db.prepare("DELETE FROM psn_trophy_cache WHERE tracked = 0 AND fetched_at < ?1").bind(month),
    ctx.db.prepare("DELETE FROM psn_username_cache WHERE fetched_at < ?1").bind(now - 90 * 24 * 60 * 60 * 1000),
    ctx.db.prepare("DELETE FROM psn_platinum_alerts WHERE alerted_at < ?1").bind(now - 365 * 24 * 60 * 60 * 1000),
    // Platinum history is kept 90 days, and dropped once an account is unlinked everywhere;
    // finished races go 90 days after their end (both promised in the privacy policy).
    ctx.db
      .prepare("DELETE FROM trophy_history WHERE day < ?1 OR psn_id NOT IN (SELECT psn_id FROM psn_trophy_cache WHERE tracked = 1)")
      .bind(new Date(now - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)),
    ctx.db
      .prepare("DELETE FROM race_participants WHERE race_id IN (SELECT id FROM races WHERE status = 'ended' AND ends_at < ?1)")
      .bind(now - 90 * 24 * 60 * 60 * 1000),
    ctx.db.prepare("DELETE FROM races WHERE status = 'ended' AND ends_at < ?1").bind(now - 90 * 24 * 60 * 60 * 1000),
  ];
}
