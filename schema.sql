CREATE TABLE IF NOT EXISTS psn_users (
  id TEXT PRIMARY KEY,
  discord_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  psn_username TEXT NOT NULL,
  psn_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS psn_trophy_cache (
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
);

CREATE TABLE IF NOT EXISTS guild_settings (
  guild_id TEXT PRIMARY KEY,
  leaderboard_channel_id TEXT,
  weekly_leaderboard_enabled INTEGER NOT NULL DEFAULT 0,
  last_weekly_post_at INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS psn_title_snapshots (
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
);

CREATE TABLE IF NOT EXISTS weekly_trophy_baselines (
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
);

CREATE TABLE IF NOT EXISTS job_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_psn_users_guild_id ON psn_users (guild_id);
CREATE INDEX IF NOT EXISTS idx_psn_users_discord_guild ON psn_users (guild_id, discord_id);
CREATE INDEX IF NOT EXISTS idx_psn_title_snapshots_psn_id ON psn_title_snapshots (psn_id);
CREATE INDEX IF NOT EXISTS idx_weekly_trophy_baselines_guild_id ON weekly_trophy_baselines (guild_id);
