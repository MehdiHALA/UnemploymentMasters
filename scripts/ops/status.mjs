// A health report for the live bot: how far the database has got, Platinum, the weekly posts
// and Cloudflare's request analytics. Read-only; prints results, never token values.
//
//   node scripts/ops/status.mjs [--since 24h | 90m | 2026-11-01T08:41:00Z]
//
// --since sets where "refreshed since" and the analytics start (default: the last 24 hours).

import { nextWeeklyPostSlot, weeklyPostSlot } from "../../src/runtime.js";
import { connect, iso, runCli } from "./lib.mjs";

const UNITS = { m: 60_000, h: 3_600_000, d: 86_400_000 };

// "6h", "90m", "2d" (that long ago) or a date and time.
export function parseSince(text, now = Date.now()) {
  if (!text) return now - UNITS.d;
  const relative = /^(\d+(?:\.\d+)?)([mhd])$/.exec(text);
  if (relative) return now - Number(relative[1]) * UNITS[relative[2]];
  const at = Date.parse(text);
  if (!Number.isFinite(at)) throw new Error(`can't read "${text}" as a time (try 6h, 90m or 2026-11-01T08:41:00Z)`);
  return at;
}

const ANALYTICS = `query ($account: String!, $script: String!, $from: Time!, $to: Time!) {
  viewer { accounts(filter: { accountTag: $account }) {
    workersInvocationsAdaptive(limit: 20, filter: { scriptName: $script, datetime_geq: $from, datetime_leq: $to }) {
      sum { requests errors subrequests }
      quantiles { cpuTimeP50 cpuTimeP99 }
      dimensions { status }
    }
  } }
}`;

export async function main(args) {
  const cf = connect();
  const now = Date.now();
  const at = args.indexOf("--since");
  const since = parseSince(at === -1 ? args.find((arg) => !arg.startsWith("--")) : args[at + 1], now);
  const slot = weeklyPostSlot(now);

  const [cache] = await cf.select(
    `SELECT COUNT(*) AS tracked,
       SUM(CASE WHEN fetched_at > ?1 THEN 1 ELSE 0 END) AS fresh_6h,
       SUM(CASE WHEN fetched_at > ?2 THEN 1 ELSE 0 END) AS refreshed_since,
       SUM(CASE WHEN last_error = 'private' THEN 1 ELSE 0 END) AS private,
       SUM(CASE WHEN fetched_at = 0 AND COALESCE(last_error, '') != 'private' THEN 1 ELSE 0 END) AS never_loaded,
       SUM(CASE WHEN next_refresh_at <= ?3 THEN 1 ELSE 0 END) AS due_now,
       SUM(CASE WHEN avatar_url IS NOT NULL THEN 1 ELSE 0 END) AS with_avatar,
       SUM(CASE WHEN platinum > alert_platinum THEN 1 ELSE 0 END) AS pending_alerts
     FROM psn_trophy_cache WHERE tracked = 1`,
    [now - 6 * UNITS.h, since, now]
  );
  const auth = await cf.select("SELECT key, updated_at, refresh_token_expires_at FROM psn_auth_state ORDER BY key");
  const jobs = await cf.select("SELECT key, value FROM job_state WHERE key IN ('psn_auth_error', 'schema_version', 'maintenance_day')");
  const limits = await cf.select("SELECT key, used, window_start, cooldown_until FROM rate_limits");
  const [alerts] = await cf.select("SELECT COUNT(*) AS sent, MAX(alerted_at) AS last FROM psn_platinum_alerts");
  const [weekly] = await cf.select(
    `SELECT COUNT(*) AS enabled,
       SUM(CASE WHEN channel_error IS NOT NULL THEN 1 ELSE 0 END) AS channel_errors,
       SUM(CASE WHEN last_weekly_post_at >= ?1 THEN 1 ELSE 0 END) AS posted_this_slot
     FROM guild_settings WHERE weekly_leaderboard_enabled = 1`,
    [slot]
  );
  const [links] = await cf.select(
    `SELECT COUNT(*) AS total, SUM(CASE WHEN created_at > ?1 THEN 1 ELSE 0 END) AS new_since, COUNT(DISTINCT guild_id) AS servers
     FROM psn_users`,
    [since]
  );

  console.log(`now ${iso(now)} · since ${iso(since)}`);
  console.log("CACHE", JSON.stringify(cache));
  console.log(
    "AUTH",
    JSON.stringify(auth.map((row) => ({ key: row.key, logged_in: iso(row.updated_at), refresh_days_left: ((row.refresh_token_expires_at - now) / UNITS.d).toFixed(1) })))
  );
  console.log("JOBS", JSON.stringify(jobs));
  console.log("RATE", JSON.stringify(limits.map((row) => ({ ...row, window_start: iso(row.window_start) }))));
  console.log("ALERTS", JSON.stringify({ sent: alerts.sent, last: iso(alerts.last) }));
  console.log("WEEKLY", JSON.stringify({ ...weekly, slot: iso(slot), next: iso(nextWeeklyPostSlot(now)) }));
  console.log("LINKS", JSON.stringify(links));

  // Platinum needs schema v3; an older database simply has none of it.
  try {
    const [premium] = await cf.select("SELECT COUNT(*) AS servers FROM premium_guilds WHERE expires_at IS NULL OR expires_at > ?1", [now]);
    const [sku] = await cf.select("SELECT value FROM job_state WHERE key = 'premium_sku'");
    const status = sku ? JSON.parse(sku.value) : null;
    console.log("PLATINUM", JSON.stringify({ servers: premium.servers, sku_ready: status?.ready ?? null, sku_checked: iso(status?.checked_at) }));
  } catch (err) {
    console.log(`PLATINUM unavailable: ${err.message.slice(0, 120)}`);
  }

  const analytics = await cf.graphql(ANALYTICS, { account: cf.accountId, script: cf.config.name, from: iso(since), to: iso(now) });
  if (analytics.errors?.length) {
    console.log(`ANALYTICS unavailable: ${analytics.errors.map((error) => error.message).join("; ").slice(0, 300)}`);
    return;
  }
  const rows = analytics.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive || [];
  for (const row of rows) {
    const { requests, errors, subrequests } = row.sum;
    const { cpuTimeP50, cpuTimeP99 } = row.quantiles;
    console.log(
      `ANALYTICS status=${row.dimensions.status} requests=${requests} errors=${errors} subrequests=${subrequests} cpuP50=${(cpuTimeP50 / 1000).toFixed(2)}ms cpuP99=${(cpuTimeP99 / 1000).toFixed(2)}ms`
    );
  }
  if (rows.length === 0) console.log("ANALYTICS no invocations recorded in this period");
}

runCli(import.meta.url, () => main(process.argv.slice(2)));
