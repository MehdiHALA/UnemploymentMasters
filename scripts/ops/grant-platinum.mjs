// Gives a server Platinum straight in the live database, using the same statements as
// `/admin grant`, for when Discord isn't handy. The next background run (within 5 minutes)
// registers the Platinum commands in that server and, with --announce, posts the welcome.
//
//   node scripts/ops/grant-platinum.mjs find "<part of the server name>"
//   node scripts/ops/grant-platinum.mjs grant <server_id> <days|forever> "<note>" [--announce]
//
// `find` searches the daily list of the servers the bot is in. `forever` means no end date.

import { grantStatements } from "../../src/premium.js";
import { connect, iso, runCli } from "./lib.mjs";

const PLATINUM_SCHEMA = 3;

async function requirePlatinumSchema(backend) {
  const [row] = await backend.select("SELECT value FROM job_state WHERE key = 'schema_version'");
  const version = Number(row?.value || 0);
  if (version < PLATINUM_SCHEMA) throw new Error(`the database is on schema v${version}; deploy the Platinum update first, so the upgrade runs`);
}

// Servers whose name contains `name`, biggest first.
export async function findServers(backend, name, now = Date.now()) {
  await requirePlatinumSchema(backend);
  return backend.select(
    `SELECT d.guild_id, d.name, d.member_count,
            (SELECT COUNT(*) FROM psn_users u WHERE u.guild_id = d.guild_id) AS links,
            (SELECT leaderboard_channel_id FROM guild_settings g WHERE g.guild_id = d.guild_id) AS bot_channel,
            (SELECT channel_error FROM guild_settings g WHERE g.guild_id = d.guild_id) AS channel_error,
            EXISTS (SELECT 1 FROM premium_guilds p WHERE p.guild_id = d.guild_id AND (p.expires_at IS NULL OR p.expires_at > ?2)) AS platinum
     FROM guild_directory d
     WHERE d.name LIKE ?1
     ORDER BY COALESCE(d.member_count, 0) DESC
     LIMIT 20`,
    [`%${String(name).replace(/[%_]/g, "")}%`, now]
  );
}

// `days` is a whole number of days, or null for no end date. Returns the saved premium row.
export async function grantPlatinum(backend, { guildId, days, note = null, announce = false, now = Date.now() }, log = () => {}) {
  if (!/^\d{15,25}$/.test(String(guildId ?? ""))) throw new Error("the server ID is the long number from Copy Server ID (Developer Mode on)");
  if (days !== null && (!Number.isInteger(days) || days < 1)) throw new Error('days must be a whole number of days, or "forever"');
  await requirePlatinumSchema(backend);

  const active = await backend.select("SELECT guild_id FROM premium_guilds WHERE guild_id = ?1 AND (expires_at IS NULL OR expires_at > ?2)", [guildId, now]);

  // grantStatements() only builds statements, so a recording stand-in is all it needs.
  const statement = (sql, params = []) => ({ sql, params, bind: (...values) => statement(sql, values) });
  const ctx = { db: { prepare: (sql) => statement(sql) } };
  const statements = grantStatements(ctx, { guildId, days, note, now, startMonthly: active.length === 0, announce });

  for (const [index, { sql, params }] of statements.entries()) {
    const { meta } = await backend.query(sql, params);
    log(`step ${index + 1}/${statements.length}: ok, ${meta?.changes ?? "?"} row(s) changed`);
  }
  const [saved] = await backend.select("SELECT guild_id, source, note, granted_at, expires_at, welcome_status FROM premium_guilds WHERE guild_id = ?1", [guildId]);
  return saved;
}

const describeServer = (row) =>
  `${Number(row.platinum) === 1 ? "💠" : "▫️"} ${row.name} · ${row.guild_id} · ${row.member_count ?? "?"} members · ${row.links} links · ` +
  `bot channel: ${row.bot_channel ? `${row.bot_channel}${row.channel_error ? ` (${row.channel_error})` : ""}` : "none"}`;

export async function main(args) {
  const [mode, ...rest] = args;

  if (mode === "find") {
    const rows = await findServers(connect(), rest[0] || "");
    console.log(rows.length > 0 ? rows.map(describeServer).join("\n") : "no match in the server list (the bot refreshes it once a day)");
    return;
  }

  if (mode === "grant") {
    const [guildId, daysText, note] = rest;
    const days = daysText === "forever" ? null : Number(daysText);
    const saved = await grantPlatinum(connect(), { guildId, days, note: note || null, announce: rest.includes("--announce") }, console.log);
    console.log(`Granted: ${saved.guild_id} · ${saved.source} · ${saved.note ?? "no note"} · until ${saved.expires_at ? iso(saved.expires_at) : "no end date"} · welcome ${saved.welcome_status ?? "not requested"}`);
    console.log("The Platinum commands appear in that server within 5 minutes.");
    return;
  }

  console.error('Usage: node scripts/ops/grant-platinum.mjs find "<name>" | grant <server_id> <days|forever> "<note>" [--announce]');
  process.exitCode = 1;
}

runCli(import.meta.url, () => main(process.argv.slice(2)));
