-- Full schema (version 3). The Worker creates and upgrades this automatically on first use,
-- so running this file is only needed for a brand-new database you want to inspect first.
-- test/schema.test.mjs checks that it matches what the built-in migrations produce.

CREATE TABLE IF NOT EXISTS psn_users (
  id TEXT PRIMARY KEY,
  discord_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  psn_username TEXT NOT NULL,
  psn_id TEXT NOT NULL,
  created_at INTEGER
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
  fetched_at INTEGER NOT NULL,
  tier INTEGER,
  avatar_url TEXT,
  is_plus INTEGER,
  tracked INTEGER NOT NULL DEFAULT 0,
  next_refresh_at INTEGER NOT NULL DEFAULT 0,
  fail_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  profile_checked_at INTEGER NOT NULL DEFAULT 0,
  alert_platinum INTEGER,
  alert_synced_at INTEGER NOT NULL DEFAULT 0,
  titles_synced_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS guild_settings (
  guild_id TEXT PRIMARY KEY,
  leaderboard_channel_id TEXT,
  weekly_leaderboard_enabled INTEGER NOT NULL DEFAULT 0,
  last_weekly_post_at INTEGER,
  updated_at INTEGER NOT NULL,
  channel_error TEXT,
  accent_color INTEGER,
  emoji_json TEXT,
  weekly_day INTEGER,
  weekly_hour INTEGER,
  hunter_role_id TEXT,
  hunter_discord_id TEXT,
  monthly_month TEXT,
  roles_error TEXT
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
  last_alerted_platinum INTEGER NOT NULL DEFAULT 0,
  platinum_seen_at INTEGER
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

CREATE TABLE IF NOT EXISTS psn_username_cache (
  normalized_username TEXT PRIMARY KEY,
  psn_username TEXT NOT NULL,
  psn_id TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS psn_auth_state (
  key TEXT PRIMARY KEY,
  access_token TEXT,
  access_token_expires_at INTEGER,
  id_token TEXT,
  refresh_token TEXT,
  refresh_token_expires_at INTEGER,
  scope TEXT,
  token_type TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS psn_platinum_alerts (
  psn_id TEXT NOT NULL,
  np_communication_id TEXT NOT NULL,
  alerted_at INTEGER NOT NULL,
  PRIMARY KEY (psn_id, np_communication_id)
);

CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  used INTEGER NOT NULL,
  cooldown_until INTEGER NOT NULL DEFAULT 0
);

-- Platinum (premium) tier.
CREATE TABLE IF NOT EXISTS premium_guilds (
  guild_id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  note TEXT,
  granted_at INTEGER NOT NULL,
  expires_at INTEGER
);

CREATE TABLE IF NOT EXISTS milestone_roles (
  guild_id TEXT NOT NULL,
  platinums INTEGER NOT NULL,
  role_id TEXT NOT NULL,
  PRIMARY KEY (guild_id, platinums)
);

CREATE TABLE IF NOT EXISTS role_grants (
  guild_id TEXT NOT NULL,
  discord_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  granted_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, discord_id, role_id)
);

CREATE TABLE IF NOT EXISTS monthly_baselines (
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
);

CREATE TABLE IF NOT EXISTS races (
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
);

CREATE TABLE IF NOT EXISTS race_participants (
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
);

CREATE TABLE IF NOT EXISTS trophy_history (
  psn_id TEXT NOT NULL,
  day TEXT NOT NULL,
  platinum INTEGER NOT NULL DEFAULT 0,
  gold INTEGER NOT NULL DEFAULT 0,
  silver INTEGER NOT NULL DEFAULT 0,
  bronze INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  trophy_level INTEGER,
  PRIMARY KEY (psn_id, day)
);

CREATE INDEX IF NOT EXISTS idx_psn_users_guild_id ON psn_users (guild_id);
CREATE INDEX IF NOT EXISTS idx_psn_users_discord_guild ON psn_users (guild_id, discord_id);
CREATE INDEX IF NOT EXISTS idx_psn_users_psn_id ON psn_users (psn_id);
CREATE INDEX IF NOT EXISTS idx_psn_users_guild_psn ON psn_users (guild_id, psn_id);
CREATE INDEX IF NOT EXISTS idx_psn_title_snapshots_psn_id ON psn_title_snapshots (psn_id);
CREATE INDEX IF NOT EXISTS idx_weekly_trophy_baselines_guild_id ON weekly_trophy_baselines (guild_id);
CREATE INDEX IF NOT EXISTS idx_baselines_guild_psn ON weekly_trophy_baselines (guild_id, psn_id);
CREATE INDEX IF NOT EXISTS idx_psn_username_cache_psn_id ON psn_username_cache (psn_id);
CREATE INDEX IF NOT EXISTS idx_cache_refresh ON psn_trophy_cache (tracked, next_refresh_at);
CREATE INDEX IF NOT EXISTS idx_cache_profile ON psn_trophy_cache (tracked, profile_checked_at);
CREATE INDEX IF NOT EXISTS idx_cache_alert_pending ON psn_trophy_cache (alert_synced_at) WHERE platinum > alert_platinum;
CREATE INDEX IF NOT EXISTS idx_races_guild_status ON races (guild_id, status);
CREATE INDEX IF NOT EXISTS idx_races_status_ends ON races (status, ends_at);
CREATE INDEX IF NOT EXISTS idx_snapshots_title ON psn_title_snapshots (np_communication_id);

INSERT INTO job_state (key, value, updated_at) VALUES ('schema_version', '3', 0)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value;
