// Looks at the live bot's Cloudflare setup and database. Read-only: only SELECT statements
// reach the database, and no token or secret value is ever printed.
//
//   node scripts/ops/inspect.mjs access            what the Cloudflare token can reach
//   node scripts/ops/inspect.mjs stats             servers, links, caches, PSN login and job state
//   node scripts/ops/inspect.mjs worker            the Worker's bindings, secret names, schedule, deployments
//   node scripts/ops/inspect.mjs sql "SELECT ..."  run your own SELECT (one statement per argument)

import { connect, iso, runCli } from "./lib.mjs";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

async function access(cf) {
  // Account-scoped tokens verify under the account, personal ones under the user.
  let check = await cf.request(cf.account("/tokens/verify"));
  if (!check.ok) check = await cf.request("/user/tokens/verify");
  const result = check.body.result;
  console.log(`Cloudflare token: ${check.ok ? result?.status : `not valid (${check.status})`}${result?.expires_on ? `, expires ${result.expires_on}` : ""}`);

  const databases = await cf.request(cf.account("/d1/database?per_page=50"));
  console.log(
    databases.ok
      ? `D1 databases visible: ${(databases.body.result || []).map((db) => `${db.name}${db.uuid === cf.config.d1.databaseId ? " (the bot's)" : ""}`).join(", ") || "none"}`
      : `D1 list failed (${databases.status})`
  );

  try {
    const [row] = await cf.select("SELECT COUNT(*) AS links FROM psn_users");
    console.log(`D1 read access: OK (${row.links} links in psn_users)`);
  } catch (err) {
    console.log(`D1 read access: ${err.message}`);
  }

  const scripts = await cf.request(cf.account("/workers/scripts"));
  console.log(`Workers scripts access: ${scripts.ok ? `yes (${(scripts.body.result || []).map((script) => script.id).join(", ")})` : `no (${scripts.status})`}`);
}

async function stats(cf) {
  const now = Date.now();

  const [totals] = await cf.select(`SELECT
      (SELECT COUNT(DISTINCT guild_id) FROM psn_users) AS servers_with_links,
      (SELECT COUNT(*) FROM psn_users) AS total_links,
      (SELECT COUNT(DISTINCT psn_id) FROM psn_users) AS psn_accounts,
      (SELECT COUNT(DISTINCT discord_id) FROM psn_users) AS discord_members,
      (SELECT COUNT(*) FROM guild_settings WHERE weekly_leaderboard_enabled = 1) AS weekly_servers,
      (SELECT COUNT(*) FROM guild_settings) AS servers_with_settings`);
  console.log("TOTALS", JSON.stringify(totals));

  const perServer = await cf.select(`SELECT guild_id, COUNT(*) AS links, COUNT(DISTINCT discord_id) AS members, COUNT(DISTINCT psn_id) AS accounts
      FROM psn_users GROUP BY guild_id ORDER BY links DESC`);
  console.log("PER_SERVER", JSON.stringify(perServer));

  const [cache] = await cf.select(
    `SELECT COUNT(*) AS cached,
       SUM(CASE WHEN fetched_at > ?1 THEN 1 ELSE 0 END) AS fresh_6h,
       SUM(CASE WHEN fetched_at > ?2 THEN 1 ELSE 0 END) AS fresh_7d,
       MAX(fetched_at) AS last_refresh,
       SUM(platinum) AS total_platinums, MAX(platinum) AS top_platinums
     FROM psn_trophy_cache`,
    [now - 6 * HOUR, now - 7 * DAY]
  );
  console.log("CACHE", JSON.stringify(cache));

  console.log("PSN_AUTH_EXPIRY", JSON.stringify(await cf.select("SELECT key, access_token_expires_at, refresh_token_expires_at, updated_at FROM psn_auth_state")));
  console.log("JOB_STATE", JSON.stringify(await cf.select("SELECT key, substr(value, 1, 160) AS value, updated_at FROM job_state ORDER BY key")));

  const [activity] = await cf.select(
    "SELECT COUNT(*) AS snapshots, COUNT(DISTINCT psn_id) AS accounts_with_games, MAX(last_seen_at) AS last_game_seen FROM psn_title_snapshots"
  );
  console.log("ACTIVITY", JSON.stringify(activity));
}

// Worker metadata only. Cloudflare never returns a secret's value, just its name.
async function worker(cf) {
  const scripts = await cf.request(cf.account("/workers/scripts"));
  const script = (scripts.body.result || []).find((item) => item.id === cf.config.name);
  console.log(`Worker: ${script ? `created ${script.created_on}, last deployed ${script.modified_on}` : "not found"}`);

  const schedules = await cf.request(cf.script("/schedules"));
  console.log(`Cron schedule: ${schedules.ok ? (schedules.body.result?.schedules || []).map((item) => item.cron).join(", ") || "none" : `unavailable (${schedules.status})`}`);

  const secrets = await cf.request(cf.script("/secrets"));
  console.log(`Secrets set (names only): ${secrets.ok ? (secrets.body.result || []).map((item) => item.name).join(", ") || "none" : `unavailable (${secrets.status})`}`);

  const settings = await cf.request(cf.script("/settings"));
  if (settings.ok) {
    const bindings = settings.body.result?.bindings || [];
    console.log(`Bindings: ${bindings.map((item) => `${item.name} (${item.type})`).join(", ")}`);
    console.log(`Observability: ${JSON.stringify(settings.body.result?.observability ?? null)} · compatibility_date ${settings.body.result?.compatibility_date}`);
  } else {
    console.log(`Settings unavailable (${settings.status})`);
  }

  const deployments = await cf.request(cf.script("/deployments"));
  if (deployments.ok) {
    const items = deployments.body.result?.deployments || [];
    console.log(`Recent deployments: ${items.slice(0, 5).map((item) => `${iso(Date.parse(item.created_on))} (${item.source || "?"})`).join("; ") || "none"}`);
  }
}

async function sql(cf, statements) {
  if (statements.length === 0) throw new Error('give at least one query: node scripts/ops/inspect.mjs sql "SELECT COUNT(*) FROM psn_users"');
  for (const statement of statements) console.log(JSON.stringify(await cf.select(statement)));
}

const MODES = { access, stats, worker };

export async function main(args) {
  const [mode = "access", ...rest] = args;
  if (mode === "sql") return sql(connect(), rest);
  if (!MODES[mode]) {
    console.error("Usage: node scripts/ops/inspect.mjs access | stats | worker | sql \"SELECT ...\"");
    process.exitCode = 1;
    return;
  }
  return MODES[mode](connect());
}

runCli(import.meta.url, () => main(process.argv.slice(2)));
