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

CREATE INDEX IF NOT EXISTS idx_psn_users_guild_id ON psn_users (guild_id);
CREATE INDEX IF NOT EXISTS idx_psn_users_discord_guild ON psn_users (guild_id, discord_id);
