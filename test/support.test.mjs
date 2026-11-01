import assert from "node:assert/strict";
import { test } from "node:test";

import { buildSupportPayload, commands } from "../src/worker.js";
import { allText, findButtons, validateMessage } from "./helpers/discord-validate.mjs";

test("commands exposes a public support command", () => {
  const supportCommand = commands.find((command) => command.name === "support");

  assert.deepEqual(supportCommand, {
    name: "support",
    description: "Support the free PSN Trophy Bot",
    type: 1,
    contexts: [0],
    integration_types: [0],
  });
});

test("buildSupportPayload includes a donation button when a support URL is configured", () => {
  const payload = buildSupportPayload({ supportUrl: "https://example.com/support" });

  assert.deepEqual(validateMessage(payload), []);
  assert.match(allText(payload), /Support PSN Trophy Bot/);
  assert.match(allText(payload), /free/i);
  assert.deepEqual(findButtons(payload), [
    { type: 2, style: 5, label: "Support the bot", emoji: { name: "💙" }, url: "https://example.com/support" },
  ]);
});

test("buildSupportPayload omits the donation button when no support URL is configured", () => {
  const payload = buildSupportPayload({});

  assert.deepEqual(findButtons(payload), []);
  assert.match(allText(payload), /being set up/i);
});

test("buildSupportPayload ignores non-web links", () => {
  assert.deepEqual(findButtons(buildSupportPayload({ supportUrl: "javascript:alert(1)" })), []);
});
