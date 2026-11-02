// Checks that every SQL statement the bot runs compiles on the live D1 database. For each one it
// sends `EXPLAIN <statement>`: D1 plans the statement but never runs it, so nothing is read or
// changed. Run it after a deploy that adds or changes queries, because D1 is stricter than the
// local SQLite the tests use.
//
//   node scripts/ops/explain.mjs [all]     check every statement on the live database
//   node scripts/ops/explain.mjs probe     show that EXPLAIN really doesn't execute a write
//   node scripts/ops/explain.mjs --local   the same check on an in-memory copy of schema.sql
//
// The statements come from src/db.js and src/db-premium.js with made-up ids that match no row.
// A test fails if a function exported there isn't listed below, so new queries get checked.

import { getSettings } from "../../src/config.js";
import * as db from "../../src/db.js";
import * as pdb from "../../src/db-premium.js";
import * as premiumJobs from "../../src/premium-jobs.js";
import { connect, createLocalBackend, runCli } from "./lib.mjs";

const SCHEMA_VERSION = db.SCHEMA_VERSION;

// A database stand-in that records the SQL it is asked for instead of running it.
function recorder() {
  const recorded = [];
  const statement = (sql, params = []) => ({
    sql,
    params,
    bind: (...values) => statement(sql, values),
    first: async () => (recorded.push({ sql, params }), null),
    all: async () => (recorded.push({ sql, params }), { results: [] }),
    run: async () => (recorded.push({ sql, params }), {}),
  });
  const ctx = {
    settings: getSettings({}),
    db: {
      prepare: (sql) => statement(sql),
      batch: async (list) => (list.forEach((item) => recorded.push({ sql: item.sql, params: item.params })), list.map(() => ({ results: [] }))),
    },
  };
  return { ctx, recorded };
}

const entries = (kind, name, list) => list.map((item, index) => ({ kind, name: list.length > 1 ? `${name}[${index}]` : name, sql: item.sql, params: item.params }));

// Every statement to check: { kind: "write" | "query", name, sql, params }.
export async function collectStatements() {
  const { ctx, recorded } = recorder();
  const g = "explain-check-guild";
  const p = "explain-check-psn";
  const now = Date.now();
  const stats = { trophyLevel: 1, progress: 0, tier: 1, platinum: 0, gold: 0, silver: 0, bronze: 0, total: 0 };
  const snapshot = {
    id: `${p}:NPWR0`, psnId: p, psnUsername: "x", npCommunicationId: "NPWR0", npServiceName: "trophy2", titleName: "x",
    titleIconUrl: "", platform: "PS5", progress: 0, platinum: 0, gold: 0, silver: 0, bronze: 0, total: 0, lastUpdatedAt: "",
  };
  const auth = {
    key: "explain-check", access_token: "x", access_token_expires_at: now, id_token: "x", refresh_token: "x",
    refresh_token_expires_at: now, scope: "x", token_type: "bearer", updated_at: now,
  };
  const race = { id: "explain-race", guildId: g, channelId: "0", npCommunicationId: "NPWR0", npServiceName: "trophy2", titleName: "x", createdBy: "0", startedAt: now, endsAt: now };

  const writes = {
    // Linking, stats and alerts.
    resetBaselines: db.resetBaselineStatements(ctx, g, now),
    joinBaseline: [db.joinBaselineStatement(ctx, { guildId: g, linkId: "x", psnId: p, discordId: "0", name: "x", stats, now })],
    link: [db.linkStatement(ctx, { id: "explain:x", discordId: "0", guildId: g, name: "x", psnId: p, now })],
    unlink: db.unlinkStatements(ctx, { guildId: g, discordId: "0", psnId: p }),
    identity: [db.identityStatement(ctx, { psnId: p, name: "x", avatarUrl: null, isPlus: null, tracked: false, now })],
    stats: [db.statsStatement(ctx, { psnId: p, name: "x", stats, now, nextRefreshAt: now })],
    refreshFailure: [db.refreshFailureStatement(ctx, { psnId: p, error: "private", nextRefreshAt: now })],
    profile: [db.profileStatement(ctx, { psnId: p, name: "x", avatarUrl: null, isPlus: null, now })],
    snapshot: [db.snapshotStatement(ctx, snapshot, now)],
    alertRecord: [db.alertRecordStatement(ctx, { psnId: p, communicationId: "NPWR0", now })],
    alertSynced: [db.alertSyncedStatement(ctx, { psnId: p, platinum: 0, now })],
    usernameCache: [db.usernameCacheStatement(ctx, { name: "explaincheck", psnId: p, now })],
    // Weekly posts, job state, PSN login and housekeeping.
    enableWeekly: [db.enableWeeklyStatement(ctx, g, "0", now)],
    disableWeekly: [db.disableWeeklyStatement(ctx, g, now)],
    markPosted: [db.markWeeklyPostedStatement(ctx, g, now)],
    channelError: [db.channelErrorStatement(ctx, g, "x", now)],
    jobState: [db.jobStateStatement(ctx, "explain-check", "x", now)],
    cooldown: [db.rateLimitCooldownStatement(ctx, { key: "explain-check", until: 0 })],
    psnAuth: [db.psnAuthStatement(ctx, auth)],
    expireAccessToken: [db.expireAccessTokenStatement(ctx, "explain-check")],
    cleanup: db.cleanupStatements(ctx, now),
    // Platinum.
    grantPremium: [pdb.grantPremiumStatement(ctx, { guildId: g, source: "grant", note: "x", now, expiresAt: null })],
    grantAnnounce: [pdb.grantPremiumStatement(ctx, { guildId: g, source: "grant", note: "x", now, expiresAt: now, announce: true })],
    extendEntitlement: [pdb.extendEntitlementStatement(ctx, { guildId: g, note: "x", now, expiresAt: now })],
    revokePremium: [pdb.revokePremiumStatement(ctx, g)],
    prioritizeRefresh: [pdb.prioritizeGuildRefreshStatement(ctx, g)],
    welcomeStatus: [pdb.welcomeStatusStatement(ctx, g, "posted:0")],
    directory: [pdb.directoryStatement(ctx, { guildId: g, name: "x", members: 1, now })],
    pruneDirectory: [pdb.pruneDirectoryStatement(ctx, 0)],
    accent: [pdb.accentStatement(ctx, g, 1, now)],
    emoji: [pdb.emojiStatement(ctx, g, "{}", now)],
    hunterRole: [pdb.hunterRoleStatement(ctx, g, null, now)],
    rolesError: [pdb.rolesErrorStatement(ctx, g, null, now)],
    weeklySchedule: [pdb.weeklyScheduleStatement(ctx, g, 3, 18, now)],
    addMilestone: [pdb.addMilestoneStatement(ctx, g, 10, "0")],
    removeMilestone: [pdb.removeMilestoneStatement(ctx, g, 10)],
    roleGrant: [pdb.roleGrantStatement(ctx, { guildId: g, discordId: "0", roleId: "0", now })],
    roleRevoke: [pdb.roleRevokeStatement(ctx, { guildId: g, discordId: "0", roleId: "0" })],
    monthlyBaseline: pdb.monthlyBaselineStatements(ctx, g, "2026-11", now),
    joinMonthly: [pdb.joinMonthlyBaselineStatement(ctx, { guildId: g, psnId: p, stats, now })],
    hunterHolder: [pdb.hunterHolderStatement(ctx, g, "0", now)],
    createRace: [pdb.createRaceStatement(ctx, race)],
    endRace: [pdb.endRaceStatement(ctx, race.id)],
    joinRace: [pdb.joinRaceStatement(ctx, { raceId: race.id, psnId: p, discordId: "0", name: "x", now })],
    leaveRace: [pdb.leaveRaceStatement(ctx, race.id, "0")],
    raceProgress: [pdb.raceProgressStatement(ctx, { raceId: race.id, psnId: p, progress: 0, earnedTotal: 0, finishedAt: null, now })],
    history: [pdb.historyStatement(ctx, { psnId: p, day: "2026-11-01", stats })],
    titlesSynced: [pdb.titlesSyncedStatement(ctx, p, now)],
  };

  // Query functions run against the recorder, which records their SQL and answers "no rows".
  const queries = [
    // Leaderboards, ranks and movers.
    ["leaderboardPage", () => db.getLeaderboardPage(ctx, g, 1, 10)],
    ["weeklyData", () => db.getWeeklyData(ctx, g, 10)],
    ["rankNeighborhood", () => db.getRankNeighborhood(ctx, g, "0")],
    ["memberAccounts", () => db.getMemberAccounts(ctx, g, "0")],
    ["memberLinks", () => db.getMemberLinks(ctx, g, "0")],
    ["guildLink", () => db.findGuildLink(ctx, g, p)],
    ["cacheRows", () => db.getCacheRows(ctx, [p, `${p}-2`])],
    ["movers", () => db.getMovers(ctx, g, 10)],
    // Background refresh, alerts and weekly posts.
    ["dueAccounts", () => db.getDueAccounts(ctx, now, 25)],
    ["dueAccountsGuild", () => db.getDueAccounts(ctx, now, 25, g)],
    ["profileBackfill", () => db.getProfileBackfill(ctx, now, 4)],
    ["pendingAlerts", () => db.getPendingAlerts(ctx, 10)],
    ["alertContext", () => db.getAlertContext(ctx, p, ["NPWR0"])],
    ["cachedSnapshots", () => db.getCachedSnapshots(ctx, [p], { limit: 5 })],
    ["cachedPlatinums", () => db.getCachedSnapshots(ctx, [p], { limit: 5, platinumOnly: true })],
    ["cachedUsername", () => db.getUsernameCache(ctx, "explaincheck")],
    ["guildSettings", () => db.getGuildSettings(ctx, g)],
    ["dueWeekly", () => db.getDueWeeklyGuilds(ctx, now, 8, now)],
    ["jobStateRows", () => db.getJobState(ctx, ["explain-check", "explain-check-2"])],
    ["reserveRateLimit", () => db.reserveRateLimit(ctx, { key: "explain-check", wanted: 1, limit: 10, windowMs: 900_000, now })],
    ["psnAuthRecord", () => db.getPsnAuthRecord(ctx, "explain-check")],
    // Platinum.
    ["activePremium", () => pdb.getActivePremiumGuilds(ctx, now)],
    ["branding", () => pdb.getGuildBranding(ctx, g, now)],
    ["premiumState", () => premiumJobs.loadPremiumState(ctx, now)],
    ["pendingWelcomes", () => pdb.getPendingWelcomes(ctx, now, 2)],
    ["directoryNames", () => pdb.getDirectoryNames(ctx, [g, `${g}-2`])],
    ["findDirectory", () => pdb.findDirectory(ctx, "sector", 15)],
    ["milestones", () => pdb.getMilestones(ctx, g)],
    ["roleSyncGuilds", () => pdb.getRoleSyncGuilds(ctx, now, 2)],
    ["roleSyncData", () => pdb.getRoleSyncData(ctx, g)],
    ["monthlyStandings", () => pdb.getMonthlyStandings(ctx, g, 3)],
    ["monthlyDue", () => pdb.getMonthlyDueGuilds(ctx, "2026-11", now, 2)],
    ["activeRace", () => pdb.getActiveRace(ctx, g)],
    ["raceParticipants", () => pdb.getRaceParticipants(ctx, race.id)],
    ["raceChecksDue", () => pdb.getRaceChecksDue(ctx, now, now, 8)],
    ["racesEnding", () => pdb.getRacesEnding(ctx, now, 2)],
    ["finishCount", () => pdb.getFinishCount(ctx, race.id)],
    ["searchTitles", () => pdb.searchGuildTitles(ctx, g, "x", 5)],
    ["listTitles", () => pdb.listGuildTitles(ctx, g, 2000)],
    ["guildTitle", () => pdb.getGuildTitle(ctx, g, "NPWR0")],
    ["gameBoard", () => pdb.getGameBoard(ctx, g, "NPWR0", 15)],
    ["historyRows", () => pdb.getHistory(ctx, [p, `${p}-2`], "2026-09-01")],
    ["titleSyncDue", () => pdb.getTitleSyncDue(ctx, now, now, 5)],
    ["customWeekly", () => pdb.getCustomWeeklyGuilds(ctx, now)],
    ["ownerStats", () => pdb.getOwnerStats(ctx, now)],
    ["exportRows", () => pdb.getExportRows(ctx, g)],
  ];

  const statements = Object.entries(writes).flatMap(([name, list]) => entries("write", name, list));
  for (const [name, run] of queries) {
    recorded.length = 0;
    try {
      await run();
    } catch {
      // The SQL is recorded before the (empty) answer is used, so a failure afterwards doesn't matter.
    }
    if (recorded.length === 0) throw new Error(`explain.mjs: ${name} didn't ask the database for anything`);
    statements.push(...entries("query", name, [...recorded]));
  }
  return statements;
}

// Compiles each statement on `backend`; returns the ones it rejected.
export async function compileAll(backend, statements, onResult = () => {}) {
  const failures = [];
  for (const { name, sql, params } of statements) {
    try {
      await backend.explain(sql, params);
      onResult(name, null);
    } catch (err) {
      failures.push({ name, message: err.message });
      onResult(name, err.message);
    }
  }
  return failures;
}

async function probe(backend) {
  await backend.explain("INSERT INTO job_state (key, value, updated_at) VALUES ('explain-probe', 'x', 0)");
  const [row] = await backend.select("SELECT COUNT(*) AS n FROM job_state WHERE key = 'explain-probe'");
  console.log(`EXPLAIN executed the write? ${row.n > 0 ? "YES: stop, and delete the 'explain-probe' row from job_state" : "no (safe)"}`);
  if (row.n > 0) process.exitCode = 1;
}

async function check(backend, where) {
  const [version] = await backend.select("SELECT value FROM job_state WHERE key = 'schema_version'");
  const live = Number(version?.value || 0);
  if (live < SCHEMA_VERSION) {
    console.log(`The database is on schema v${live} but the code expects v${SCHEMA_VERSION}: deploy first, so the upgrade runs, then run this again.`);
    process.exitCode = 2;
    return;
  }

  const statements = await collectStatements();
  const failures = await compileAll(backend, statements, (name, message) => console.log(message ? `FAIL  ${name}: ${message}` : `ok    ${name}`));
  const writes = statements.filter((statement) => statement.kind === "write").length;

  if (failures.length > 0) {
    console.log(`${failures.length} statement(s) rejected by ${where}`);
    process.exitCode = 1;
  } else {
    console.log(`all ${writes} writes and ${statements.length - writes} queries compile on ${where}`);
  }
}

export async function main(args) {
  const local = args.includes("--local");
  const mode = args.find((arg) => !arg.startsWith("--")) ?? "all";
  if (!["all", "probe"].includes(mode) || (mode === "probe" && local)) {
    console.error("Usage: node scripts/ops/explain.mjs [all | probe | --local]");
    process.exitCode = 1;
    return;
  }

  const backend = local ? await createLocalBackend() : connect();
  if (mode === "probe") return probe(backend);
  return check(backend, local ? "the local schema" : "production D1");
}

runCli(import.meta.url, () => main(process.argv.slice(2)));
