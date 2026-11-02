import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import * as db from "../src/db.js";
import * as pdb from "../src/db-premium.js";
import {
  assertPlainVar,
  buildDeployMetadata,
  collectModules,
  diffBindings,
  mergePlainText,
  moduleImportProblems,
  parseVarArgs,
} from "../scripts/ops/deploy.mjs";
import { collectStatements, compileAll } from "../scripts/ops/explain.mjs";
import { findServers, grantPlatinum } from "../scripts/ops/grant-platinum.mjs";
import {
  assertReadOnly,
  createLocalBackend,
  loadCredentials,
  parseEnvFile,
  parseWranglerConfig,
  readWranglerConfig,
  repoRoot,
} from "../scripts/ops/lib.mjs";
import { describeDifferences, structure } from "../scripts/ops/migration-rehearsal.mjs";
import { parseSince } from "../scripts/ops/status.mjs";
import { describeEvent } from "../scripts/ops/tail.mjs";
import { FakeD1 } from "./helpers/harness.mjs";

const DAY = 86_400_000;
const scriptDir = path.join(repoRoot, "scripts", "ops");
const scripts = readdirSync(scriptDir).filter((file) => file.endsWith(".mjs")).sort();

// ---------------------------------------------------------------------------------------
// Credentials and configuration.

test("credential files are read the way people write them", () => {
  const values = parseEnvFile(
    ["# Cloudflare", 'CLOUDFLARE_API_TOKEN="abc=def"', "CLOUDFLARE_ACCOUNT_ID='0123'", "export OTHER = spaced value ", "EMPTY=", "not a setting", "", "WITH_HASH=a#b"].join("\r\n")
  );
  assert.deepEqual(values, { CLOUDFLARE_API_TOKEN: "abc=def", CLOUDFLARE_ACCOUNT_ID: "0123", OTHER: "spaced value", WITH_HASH: "a#b" });
});

test("credentials come from the environment or the file, and mistakes are explained without echoing secrets", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "psn-ops-"));
  const file = path.join(dir, "credentials.env");
  const accountId = "0123456789abcdef0123456789abcdef";
  writeFileSync(file, `CLOUDFLARE_API_TOKEN=file-token\nCLOUDFLARE_ACCOUNT_ID=${accountId}\n`);

  assert.deepEqual(loadCredentials({ env: {}, file }), { apiToken: "file-token", accountId });
  assert.equal(loadCredentials({ env: { CLOUDFLARE_API_TOKEN: "env-token" }, file }).apiToken, "env-token", "the environment wins");
  assert.throws(() => loadCredentials({ env: {}, file: path.join(dir, "missing.env") }), /CLOUDFLARE_API_TOKEN is not set/);

  writeFileSync(file, "CLOUDFLARE_API_TOKEN=super-secret-token\nCLOUDFLARE_ACCOUNT_ID=My Account Name\n");
  assert.throws(
    () => loadCredentials({ env: {}, file }),
    (err) => /32-character account ID/.test(err.message) && !err.message.includes("super-secret-token")
  );
});

test("wrangler.toml tells the tools everything they need", () => {
  const config = readWranglerConfig();
  assert.ok(config.name);
  assert.match(config.main, /^src\/[\w-]+\.js$/);
  assert.match(config.compatibilityDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(config.crons, ["*/5 * * * *"]);
  assert.equal(config.observability, true);
  assert.equal(config.d1.binding, "DB");
  assert.match(config.d1.databaseId, /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/);
  assert.match(config.vars.DISCORD_PUBLIC_KEY, /^[0-9a-f]{64}$/);

  const sample = parseWranglerConfig(`
name = "demo"
main = "src/index.js"
compatibility_date = "2026-01-01"
keep_vars = true

[vars]
A = "1"
# B = "commented out"

[triggers]
crons = ["0 * * * *", "*/5 * * * *"]

[observability]
enabled = false

[[d1_databases]]
binding = "DATA"
database_name = "demo-db"
database_id = "abc"
`);
  assert.deepEqual(sample, {
    name: "demo",
    main: "src/index.js",
    compatibilityDate: "2026-01-01",
    vars: { A: "1" },
    crons: ["0 * * * *", "*/5 * * * *"],
    observability: false,
    d1: { binding: "DATA", databaseName: "demo-db", databaseId: "abc" },
  });
});

// ---------------------------------------------------------------------------------------
// Database access.

test("database inspection only allows a single read-only statement", () => {
  const allowed = [
    "SELECT 1",
    "  select count(*) from psn_users where psn_username like '%update%'",
    "WITH x AS (SELECT 1 AS n) SELECT n FROM x",
    "SELECT 'a; DELETE FROM x' AS note",
    "SELECT 'it''s fine; DROP TABLE x' AS note",
    "SELECT replace(psn_username, 'a', 'b') FROM psn_users",
    "SELECT created_at, updated_at, last_update FROM guild_settings -- DELETE everything",
    "SELECT * FROM psn_users;",
  ];
  for (const sql of allowed) assert.equal(assertReadOnly(sql), sql, sql);

  const rejected = [
    "INSERT INTO job_state VALUES ('a', 'b', 0)",
    "  update job_state set value = 'x'",
    "DELETE FROM psn_users",
    "DROP TABLE psn_users",
    "CREATE TABLE x (a)",
    "REPLACE INTO job_state VALUES ('a', 'b', 0)",
    "PRAGMA writable_schema = 1",
    "SELECT 1; DELETE FROM psn_users",
    "SELECT 1; SELECT 2",
    "SELECT 1 /* harmless */; DROP TABLE psn_users",
    "WITH x AS (SELECT 1) DELETE FROM psn_users",
    "WITH x AS (SELECT 1) INSERT OR REPLACE INTO job_state SELECT 'a', 'b', 0",
    "",
  ];
  for (const sql of rejected) assert.throws(() => assertReadOnly(sql), /only/, sql);
});

test("EXPLAIN compiles a write without running it", async () => {
  const local = await createLocalBackend();
  await local.explain("INSERT INTO job_state (key, value, updated_at) VALUES ('probe', 'x', 0)");
  assert.deepEqual(await local.select("SELECT COUNT(*) AS n FROM job_state WHERE key = 'probe'"), [{ n: 0 }]);
  await assert.rejects(() => local.select("DELETE FROM job_state"), /only SELECT/);
});

test("the compile check covers every query function, and every statement in it is valid", async () => {
  const statements = await collectStatements();
  assert.ok(statements.length > 100, `${statements.length} statements`);
  assert.equal(new Set(statements.map((statement) => statement.name)).size, statements.length, "statement names are unique");

  const local = await createLocalBackend();
  assert.deepEqual(await compileAll(local, statements), []);

  // A broken statement is reported with its name, not hidden.
  const failures = await compileAll(local, [{ name: "broken", sql: "SELEC nonsense", params: [] }]);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].name, "broken");

  // New queries have to be added to the check, so production D1 gets to compile them.
  const source = readFileSync(path.join(scriptDir, "explain.mjs"), "utf8");
  const notQueries = new Set(["ensureSchema", "resetSchemaCacheForTests", "isPremiumSql"]);
  for (const [prefix, exported] of [["db", db], ["pdb", pdb]]) {
    for (const [name, value] of Object.entries(exported)) {
      if (typeof value !== "function" || notQueries.has(name)) continue;
      assert.match(source, new RegExp(`\\b${prefix}\\.${name}\\(`), `${prefix}.${name} isn't in scripts/ops/explain.mjs; add it so the live database compiles it too`);
    }
  }
});

// ---------------------------------------------------------------------------------------
// Deploying.

test("a deploy uploads every module, flat, and every import resolves", () => {
  const modules = collectModules();
  const files = readdirSync(path.join(repoRoot, "src")).filter((file) => file.endsWith(".js")).sort();
  assert.deepEqual(modules.map((module) => module.name), files);
  assert.ok(modules.some((module) => module.name === path.basename(readWranglerConfig().main)), "the main module is uploaded");
  assert.deepEqual(moduleImportProblems(modules), []);

  // The check really sees imports: it finds what an upload couldn't satisfy, and skips comments.
  const problems = moduleImportProblems([
    { name: "a.js", source: 'import { x } from "./b.js";\nexport * from "./c.js";\nconst d = await import("./b.js");\n// import nothing from "left-pad"\n/* import y from "./nowhere.js" */\nconsole.log(import.meta.url);' },
    { name: "b.js", source: 'import fs from "node:fs";\nimport z from "left-pad";\nimport "./sub/deep.js";\nimport {\n  a,\n  b,\n} from "./missing.js";' },
    { name: "c.js", source: "export const c = 1;" },
  ]);
  assert.equal(problems.length, 4, problems.join("\n"));
  for (const expected of ["node:fs", "left-pad", "./sub/deep.js", "./missing.js"]) {
    assert.ok(problems.some((problem) => problem.includes(`"${expected}"`)), `reports ${expected}`);
  }
});

test("modules in a folder are refused, because the upload is flat", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "psn-src-"));
  writeFileSync(path.join(dir, "worker.js"), "export default {};");
  assert.deepEqual(collectModules(dir).map((module) => module.name), ["worker.js"]);
  mkdirSync(path.join(dir, "lib"));
  assert.throws(() => collectModules(dir), /lib\/ is a folder/);
});

test("a deploy keeps secrets and dashboard variables, and never turns a secret into a variable", () => {
  const config = readWranglerConfig();
  const live = { SUPPORT_URL: "https://ko-fi.com/example", PREMIUM_SKU_ID: "1", DISCORD_PUBLIC_KEY: "stale" };
  const plain = mergePlainText(live, config.vars, parseVarArgs(["deploy", "--var", "PREMIUM_SKU_ID=2", "--var", "NOTE=a=b"]));
  assert.equal(plain.SUPPORT_URL, "https://ko-fi.com/example", "dashboard variables are kept");
  assert.equal(plain.PREMIUM_SKU_ID, "2", "--var wins");
  assert.equal(plain.NOTE, "a=b", "only the first = splits the name");
  assert.equal(plain.DISCORD_PUBLIC_KEY, config.vars.DISCORD_PUBLIC_KEY, "wrangler.toml wins for the variables it defines");

  const metadata = buildDeployMetadata({ config, plainText: plain });
  assert.equal(metadata.main_module, path.basename(config.main));
  assert.equal(metadata.compatibility_date, config.compatibilityDate);
  assert.deepEqual(metadata.keep_bindings, ["secret_text"], "secrets are left exactly as they are");
  assert.deepEqual(metadata.bindings[0], { type: "d1", name: "DB", id: config.d1.databaseId });
  assert.deepEqual(metadata.bindings.slice(1).map((binding) => binding.name), ["DISCORD_PUBLIC_KEY", "NOTE", "PREMIUM_SKU_ID", "SUPPORT_URL"]);
  assert.ok(metadata.bindings.every((binding) => binding.type !== "secret_text"));
  assert.throws(() => buildDeployMetadata({ config, plainText: { SUPPORT_URL: "x" } }), /DISCORD_PUBLIC_KEY/);

  for (const name of ["DISCORD_BOT_TOKEN", "PSN_NPSSO", "PSN_NPSSO_BACKUP", "MY_SECRET", "DB_PASSWORD"]) {
    assert.throws(() => assertPlainVar(name), /looks like a secret/, name);
  }
  for (const name of ["DISCORD_PUBLIC_KEY", "PREMIUM_SKU_ID", "SUPPORT_URL", "OWNER_GUILD_ID"]) assert.doesNotThrow(() => assertPlainVar(name), name);
  assert.throws(() => parseVarArgs(["--var", "bad"]), /NAME=value/);
  assert.throws(() => parseVarArgs(["--var"]), /NAME=value/);
});

test("the deploy shows what would change in the bindings, ignoring secrets", () => {
  const config = readWranglerConfig();
  const live = [
    { name: "DB", type: "d1", id: config.d1.databaseId },
    { name: "DISCORD_BOT_TOKEN", type: "secret_text" },
    { name: "SUPPORT_URL", type: "plain_text", text: "old" },
    { name: "GONE", type: "plain_text", text: "x" },
    { name: "CACHE", type: "kv_namespace", namespace_id: "n" },
  ];
  const wanted = [
    { type: "d1", name: "DB", id: config.d1.databaseId },
    { type: "plain_text", name: "SUPPORT_URL", text: "new" },
    { type: "plain_text", name: "ADDED", text: "1" },
  ];
  assert.deepEqual(diffBindings(wanted, live), [
    { change: "change", name: "SUPPORT_URL", type: "plain_text" },
    { change: "add", name: "ADDED", type: "plain_text" },
    { change: "remove", name: "GONE", type: "plain_text" },
    { change: "remove", name: "CACHE", type: "kv_namespace" },
  ]);
  assert.deepEqual(diffBindings(wanted.slice(0, 1), live.slice(0, 2)), [], "unchanged bindings and kept secrets make no changes");
});

// ---------------------------------------------------------------------------------------
// Reports.

test("--since understands hours, minutes, days and dates", () => {
  const now = Date.parse("2026-11-02T12:00:00Z");
  assert.equal(parseSince(undefined, now), now - DAY);
  assert.equal(parseSince("6h", now), now - 6 * 3_600_000);
  assert.equal(parseSince("90m", now), now - 90 * 60_000);
  assert.equal(parseSince("2d", now), now - 2 * DAY);
  assert.equal(parseSince("2026-11-01T08:41:00Z", now), Date.parse("2026-11-01T08:41:00Z"));
  assert.throws(() => parseSince("yesterday", now), /can't read/);
});

test("tail lines show the trigger, the outcome, the bot's log lines and errors", () => {
  const cron = describeEvent({
    eventTimestamp: Date.parse("2026-11-02T09:00:21Z"),
    outcome: "ok",
    event: { cron: "*/5 * * * *", scheduledTime: 1 },
    logs: [{ level: "log", message: ['{"event":"cron","subrequests":41}'] }],
    exceptions: [],
  });
  assert.deepEqual(cron, { isCron: true, isError: false, lines: ["[09:00:21] cron */5 * * * * → ok", '    log: {"event":"cron","subrequests":41}'] });

  const failed = describeEvent({
    eventTimestamp: Date.parse("2026-11-02T09:01:00Z"),
    outcome: "exception",
    event: { request: { method: "POST", url: "https://bot.example/" }, response: { status: 500 } },
    logs: [{ level: "error", message: ["boom"] }],
    exceptions: [{ name: "Error", message: "bad" }],
  });
  assert.equal(failed.isCron, false);
  assert.equal(failed.isError, true);
  assert.deepEqual(failed.lines, ["[09:01:00] POST / → exception 500", "    error: boom", "    EXCEPTION Error: bad"]);
});

test("the migration rehearsal compares two structures table by table", () => {
  const schema = readFileSync(path.join(repoRoot, "schema.sql"), "utf8");
  const build = () => {
    const database = new FakeD1({ read: 0, write: 0 });
    database.sqlite.exec(schema);
    return database;
  };

  const same = build();
  assert.deepEqual(describeDifferences(structure(build()), structure(same)), []);

  same.sqlite.exec("ALTER TABLE premium_guilds ADD COLUMN extra TEXT");
  const differences = describeDifferences(structure(build()), structure(same));
  assert.equal(differences.length, 1);
  assert.match(differences[0], /^premium_guilds:/);
});

// ---------------------------------------------------------------------------------------
// Granting Platinum by hand.

const SECTOR = "100000000000000078";
const ELSEWHERE = "100000000000000079";

async function serverList() {
  const local = await createLocalBackend();
  const now = Date.now();
  await local.query("INSERT INTO guild_directory (guild_id, name, member_count, seen_at) VALUES (?1, 'Sector 78', 1160, ?3), (?2, 'Other Place', 50, ?3)", [SECTOR, ELSEWHERE, now]);
  for (const index of [1, 2, 3]) {
    await local.query("INSERT INTO psn_users (id, discord_id, guild_id, psn_username, psn_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)", [`u${index}`, `${index}`, SECTOR, `Player${index}`, `psn${index}`, now]);
    await local.query(
      `INSERT INTO psn_trophy_cache (psn_id, psn_username, platinum, gold, silver, bronze, total, fetched_at, tracked, next_refresh_at)
       VALUES (?1, ?2, ?3, 4, 5, 6, 50, ?4, 1, ?5)`,
      [`psn${index}`, `Player${index}`, index * 10, now, now + 6 * 3_600_000]
    );
  }
  return local;
}

test("granting Platinum from the command line does what /admin grant does", async () => {
  const local = await serverList();
  const now = Date.parse("2026-11-02T12:00:00Z");
  const log = [];

  const saved = await grantPlatinum(local, { guildId: SECTOR, days: 181, note: "6 months free", announce: true, now }, (line) => log.push(line));
  assert.deepEqual({ ...saved }, { guild_id: SECTOR, source: "grant", note: "6 months free", granted_at: now, expires_at: now + 181 * DAY, welcome_status: "pending" });
  assert.equal(log.length, 5);
  assert.deepEqual(await local.select("SELECT COUNT(*) AS n FROM psn_trophy_cache WHERE next_refresh_at = 0"), [{ n: 3 }], "its accounts jump the refresh queue");
  assert.deepEqual(await local.select("SELECT COUNT(*) AS n FROM monthly_baselines WHERE guild_id = ?1", [SECTOR]), [{ n: 3 }], "this month's standings start");
  assert.deepEqual(await local.select("SELECT monthly_month FROM guild_settings WHERE guild_id = ?1", [SECTOR]), [{ monthly_month: "2026-11" }]);

  // Granting again extends it, keeps the queued welcome and the note, and doesn't restart the month.
  await local.query("UPDATE monthly_baselines SET platinum = 99 WHERE guild_id = ?1", [SECTOR]);
  const again = await grantPlatinum(local, { guildId: SECTOR, days: 30, now: now + 1000 });
  assert.equal(again.expires_at, now + 1000 + 30 * DAY);
  assert.equal(again.welcome_status, "pending");
  assert.equal(again.note, "6 months free");
  assert.deepEqual(await local.select("SELECT DISTINCT platinum FROM monthly_baselines WHERE guild_id = ?1", [SECTOR]), [{ platinum: 99 }]);

  const forever = await grantPlatinum(local, { guildId: ELSEWHERE, days: null, now });
  assert.equal(forever.expires_at, null);
  assert.equal(forever.welcome_status, null, "no welcome unless asked for");
});

test("granting Platinum checks its input and the database first", async () => {
  const local = await serverList();
  await assert.rejects(() => grantPlatinum(local, { guildId: "123", days: 5 }), /server ID/);
  await assert.rejects(() => grantPlatinum(local, { guildId: undefined, days: 5 }), /server ID/);
  for (const days of [0, -3, 1.5, Number.NaN]) await assert.rejects(() => grantPlatinum(local, { guildId: SECTOR, days }), /whole number/, String(days));
  assert.deepEqual(await local.select("SELECT COUNT(*) AS n FROM premium_guilds"), [{ n: 0 }], "nothing was written");

  await local.query("UPDATE job_state SET value = '2' WHERE key = 'schema_version'");
  await assert.rejects(() => grantPlatinum(local, { guildId: SECTOR, days: 5 }), /schema v2/);
  await assert.rejects(() => findServers(local, "sector"), /schema v2/);
});

test("servers can be found by name, with their links, bot channel and Platinum status", async () => {
  const local = await serverList();
  const now = Date.now();
  const [found, ...rest] = await findServers(local, "sector", now);
  assert.equal(rest.length, 0);
  assert.deepEqual({ ...found }, { guild_id: SECTOR, name: "Sector 78", member_count: 1160, links: 3, bot_channel: null, channel_error: null, platinum: 0 });
  assert.deepEqual(await findServers(local, "Sector_78", now), [], "_ is not a wildcard");
  assert.equal((await findServers(local, "", now)).length, 2, "an empty search lists everything, biggest first");

  await grantPlatinum(local, { guildId: SECTOR, days: 10, now });
  assert.equal((await findServers(local, "sector", now))[0].platinum, 1);
  assert.equal((await findServers(local, "sector", now + 11 * DAY))[0].platinum, 0, "an expired grant isn't Platinum");
});

// ---------------------------------------------------------------------------------------
// The scripts themselves.

function runScript(file, args = [], env = {}) {
  const home = mkdtempSync(path.join(os.tmpdir(), "psn-home-"));
  return spawnSync(process.execPath, ["--no-warnings", path.join(scriptDir, file), ...args], {
    encoding: "utf8",
    env: { ...process.env, PSN_BOT_HOME: home, CLOUDFLARE_API_TOKEN: "", CLOUDFLARE_ACCOUNT_ID: "", ...env },
  });
}

test("every ops script is valid JavaScript, described in the README, and free of hard-coded ids", () => {
  const readme = readFileSync(path.join(repoRoot, "README.md"), "utf8");
  assert.ok(scripts.length >= 8, scripts.join(", "));

  for (const file of scripts) {
    const check = spawnSync(process.execPath, ["--check", path.join(scriptDir, file)], { encoding: "utf8" });
    assert.equal(check.status, 0, `${file}: ${check.stderr}`);
    if (file !== "lib.mjs") assert.ok(readme.includes(file), `${file} isn't mentioned in the README`);

    // Ids come from wrangler.toml and the credentials file, so none may be written into a script.
    const source = readFileSync(path.join(scriptDir, file), "utf8");
    assert.doesNotMatch(source, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, `${file} contains a UUID`);
    assert.doesNotMatch(source, /\b[0-9a-f]{32}\b/i, `${file} contains a 32-character id or key`);
  }
});

test("run directly, a script explains a missing token or a wrong step without touching the network", () => {
  const noToken = runScript("status.mjs");
  assert.equal(noToken.status, 1);
  assert.match(noToken.stderr, /error: CLOUDFLARE_API_TOKEN is not set/);
  assert.equal(noToken.stdout, "");

  const wrongStep = runScript("deploy.mjs", ["bogus"], { CLOUDFLARE_API_TOKEN: "x", CLOUDFLARE_ACCOUNT_ID: "0".repeat(32) });
  assert.equal(wrongStep.status, 1);
  assert.match(wrongStep.stderr, /Usage: node scripts\/ops\/deploy\.mjs deploy \| verify \| rollback/);

  const writeAttempt = runScript("inspect.mjs", ["sql", "DELETE FROM psn_users"], { CLOUDFLARE_API_TOKEN: "x", CLOUDFLARE_ACCOUNT_ID: "0".repeat(32) });
  assert.equal(writeAttempt.status, 1);
  assert.match(writeAttempt.stderr, /only SELECT queries are allowed here/);
});
