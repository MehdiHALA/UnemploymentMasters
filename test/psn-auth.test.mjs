import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildPsnAuthRecord,
  getPsnAuthReminderDecision,
  selectPsnAuthAction,
} from "../src/worker.js";

test("selectPsnAuthAction uses a cached access token that is not near expiry", () => {
  const now = 1_000_000;
  const record = {
    access_token: "access",
    access_token_expires_at: now + 20 * 60 * 1000,
    refresh_token: "refresh",
    refresh_token_expires_at: now + 30 * 24 * 60 * 60 * 1000,
  };

  assert.equal(selectPsnAuthAction(record, now), "access");
});

test("selectPsnAuthAction refreshes when access is stale but refresh is valid", () => {
  const now = 1_000_000;
  const record = {
    access_token: "access",
    access_token_expires_at: now + 60 * 1000,
    refresh_token: "refresh",
    refresh_token_expires_at: now + 30 * 24 * 60 * 60 * 1000,
  };

  assert.equal(selectPsnAuthAction(record, now), "refresh");
});

test("selectPsnAuthAction falls back to NPSSO when no valid refresh token exists", () => {
  const now = 1_000_000;
  const expiredRefresh = {
    access_token: "access",
    access_token_expires_at: now - 60 * 1000,
    refresh_token: "refresh",
    refresh_token_expires_at: now - 60 * 1000,
  };

  assert.equal(selectPsnAuthAction(expiredRefresh, now), "npsso");
  assert.equal(selectPsnAuthAction(null, now), "npsso");
});

test("buildPsnAuthRecord stores token expiries as absolute timestamps", () => {
  const now = 1_000_000;
  const record = buildPsnAuthRecord(
    {
      accessToken: "access",
      expiresIn: 3600,
      idToken: "id",
      refreshToken: "refresh",
      refreshTokenExpiresIn: 5_184_000,
      scope: "psn:mobile.v2.core psn:clientapp",
      tokenType: "bearer",
    },
    now
  );

  assert.deepEqual(record, {
    key: "primary",
    access_token: "access",
    access_token_expires_at: now + 3_600_000,
    id_token: "id",
    refresh_token: "refresh",
    refresh_token_expires_at: now + 5_184_000_000,
    scope: "psn:mobile.v2.core psn:clientapp",
    token_type: "bearer",
    updated_at: now,
  });
});

test("getPsnAuthReminderDecision warns from stored refresh token expiry thresholds", () => {
  const now = Date.UTC(2026, 7, 3, 8, 0, 0);
  const refreshExpiresAt = now + 7 * 24 * 60 * 60 * 1000;

  assert.deepEqual(
    getPsnAuthReminderDecision(
      {
        refresh_token: "refresh",
        refresh_token_expires_at: refreshExpiresAt,
      },
      now
    ),
    {
      kind: "refresh",
      key: "refresh_2026-08-10_7d",
      daysRemaining: 7,
      expiresAt: refreshExpiresAt,
    }
  );
});

test("getPsnAuthReminderDecision skips valid stored refresh tokens outside warning thresholds", () => {
  const now = Date.UTC(2026, 7, 3, 8, 0, 0);

  assert.equal(
    getPsnAuthReminderDecision(
      {
        refresh_token: "refresh",
        refresh_token_expires_at: now + 10 * 24 * 60 * 60 * 1000,
      },
      now
    ),
    null
  );
});
