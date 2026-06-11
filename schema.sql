CREATE TABLE IF NOT EXISTS psn_users (
  id TEXT PRIMARY KEY,
  discord_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  psn_username TEXT NOT NULL,
  psn_id TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_psn_users_guild_id ON psn_users (guild_id);
