import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { ensureSchema, getLeaderboardPage, resetSchemaCacheForTests, SCHEMA_VERSION } from "../src/db.js";
import { Budget, createContext } from "../src/runtime.js";
import { FakeD1 } from "./helpers/harness.mjs";

function structure(db) {
  const tables = db.rows("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
  const result = {};
  for (const { name } of tables) {
    result[name] = db
      .rows(`PRAGMA table_info(${name})`)
      .map(({ name: column, type, notnull, dflt_value, pk }) => `${column} ${type}${notnull ? " NOT NULL" : ""}${dflt_value !== null ? ` DEFAULT ${dflt_value}` : ""}${pk ? ` PK${pk}` : ""}`)
      .sort();
  }
  result.indexes = db
    .rows("SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY name")
    .map((row) => `${row.name} ${row.sql.replace(/\s+/g, " ").replace(/IF NOT EXISTS /, "")}`);
  return result;
}

async function migrate(db) {
  resetSchemaCacheForTests();
  const ctx = createContext({ DB: db }, { budget: new Budget(1000, 0) });
  await ensureSchema(ctx);
  return ctx;
}

const V1_SCHEMA = `
  CREATE TABLE psn_users (id TEXT PRIMARY KEY, discord_id TEXT NOT NULL, guild_id TEXT NOT NULL, psn_username TEXT NOT NULL, psn_id TEXT NOT NULL);
  CREATE TABLE psn_trophy_cache (psn_id TEXT PRIMARY KEY, psn_username TEXT NOT NULL, trophy_level INTEGER, progress INTEGER, platinum INTEGER NOT NULL DEFAULT 0, gold INTEGER NOT NULL DEFAULT 0, silver INTEGER NOT NULL DEFAULT 0, bronze INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL DEFAULT 0, fetched_at INTEGER NOT NULL);
  CREATE TABLE guild_settings (guild_id TEXT PRIMARY KEY, leaderboard_channel_id TEXT, weekly_leaderboard_enabled INTEGER NOT NULL DEFAULT 0, last_weekly_post_at INTEGER, updated_at INTEGER NOT NULL);
  CREATE TABLE psn_title_snapshots (id TEXT PRIMARY KEY, psn_id TEXT NOT NULL, psn_username TEXT NOT NULL, np_communication_id TEXT NOT NULL, np_service_name TEXT, title_name TEXT NOT NULL, title_icon_url TEXT, platform TEXT, progress INTEGER NOT NULL DEFAULT 0, earned_platinum INTEGER NOT NULL DEFAULT 0, earned_gold INTEGER NOT NULL DEFAULT 0, earned_silver INTEGER NOT NULL DEFAULT 0, earned_bronze INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL DEFAULT 0, last_updated_at TEXT, last_seen_at INTEGER NOT NULL, last_alerted_platinum INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE weekly_trophy_baselines (id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, psn_user_id TEXT NOT NULL, psn_id TEXT NOT NULL, discord_id TEXT NOT NULL, psn_username TEXT NOT NULL, platinum INTEGER NOT NULL DEFAULT 0, gold INTEGER NOT NULL DEFAULT 0, silver INTEGER NOT NULL DEFAULT 0, bronze INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL DEFAULT 0, baseline_at INTEGER NOT NULL);
  CREATE TABLE job_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE psn_username_cache (normalized_username TEXT PRIMARY KEY, psn_username TEXT NOT NULL, psn_id TEXT NOT NULL, fetched_at INTEGER NOT NULL);
  CREATE TABLE psn_auth_state (key TEXT PRIMARY KEY, access_token TEXT, access_token_expires_at INTEGER, id_token TEXT, refresh_token TEXT, refresh_token_expires_at INTEGER, scope TEXT, token_type TEXT, updated_at INTEGER NOT NULL);
  CREATE INDEX idx_psn_users_guild_id ON psn_users (guild_id);
`;

test("schema.sql matches the schema the Worker builds itself", async () => {
  const migrated = new FakeD1({ read: 0, write: 0 });
  await migrate(migrated);

  const fromFile = new FakeD1({ read: 0, write: 0 });
  fromFile.sqlite.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));

  assert.deepEqual(structure(fromFile), structure(migrated));
  assert.equal(Number(fromFile.row("SELECT value FROM job_state WHERE key = 'schema_version'").value), SCHEMA_VERSION);
});

test("running the migrations twice changes nothing", async () => {
  const db = new FakeD1({ read: 0, write: 0 });
  await migrate(db);
  const first = structure(db);
  await migrate(db);
  assert.deepEqual(structure(db), first);
});

test("a database created by the old bot is upgraded in place, keeping every link", async () => {
  const db = new FakeD1({ read: 0, write: 0 });
  db.sqlite.exec(V1_SCHEMA);
  const now = Date.now();
  db.sqlite.exec(`
    INSERT INTO psn_users VALUES ('g1:u1:alice', 'u1', 'g1', 'alice', 'p1');
    INSERT INTO psn_users VALUES ('g1:u2:bob', 'u2', 'g1', 'Bob', 'p2');
    INSERT INTO psn_users VALUES ('g2:u2:bob', 'u2', 'g2', 'Bob', 'p2');
    INSERT INTO psn_trophy_cache (psn_id, psn_username, platinum, gold, silver, bronze, total, fetched_at) VALUES ('p1', 'alice', 9, 1, 1, 1, 12, ${now - 3600000});
    INSERT INTO psn_trophy_cache (psn_id, psn_username, platinum, gold, silver, bronze, total, fetched_at) VALUES ('stranger', 'x', 1, 1, 1, 1, 4, ${now});
    INSERT INTO psn_title_snapshots (id, psn_id, psn_username, np_communication_id, title_name, earned_platinum, last_seen_at) VALUES ('p1:NP1', 'p1', 'alice', 'NP1', 'Old Game', 1, ${now});
  `);

  const ctx = await migrate(db);

  const alice = db.row("SELECT * FROM psn_trophy_cache WHERE psn_id = 'p1'");
  assert.equal(alice.tracked, 1);
  assert.equal(alice.alert_platinum, 9, "existing platinums are not re-announced");
  assert.ok(alice.next_refresh_at > now, "fresh data is not refetched immediately");

  const bob = db.row("SELECT * FROM psn_trophy_cache WHERE psn_id = 'p2'");
  assert.equal(bob.tracked, 1, "linked accounts without stats get queued");
  assert.equal(bob.fetched_at, 0);
  assert.equal(bob.next_refresh_at, 0);

  assert.equal(db.row("SELECT tracked FROM psn_trophy_cache WHERE psn_id = 'stranger'").tracked, 0);
  assert.equal(db.row("SELECT platinum_seen_at FROM psn_title_snapshots").platinum_seen_at, 0);
  assert.equal(db.rows("SELECT * FROM psn_users").length, 3);

  const board = await getLeaderboardPage(ctx, "g1", 1, 10);
  assert.equal(board.linkedCount, 2);
  assert.equal(board.rankedCount, 1);
  assert.equal(board.pendingCount, 1);
  assert.equal(board.rows[0].name, "alice");
});
