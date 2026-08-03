import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildSupportPayload,
  commands,
} from "../src/worker.js";

test("commands exposes a public support command", () => {
  const supportCommand = commands.find((command) => command.name === "support");

  assert.deepEqual(supportCommand, {
    name: "support",
    description: "Support the free PSN Trophy Bot",
    type: 1,
  });
});

test("buildSupportPayload includes a donation button when a support URL is configured", () => {
  const payload = buildSupportPayload({ supportUrl: "https://example.com/support" });

  assert.equal(payload.embeds[0].title, "Support PSN Trophy Bot");
  assert.match(payload.embeds[0].description, /free/i);
  assert.equal(payload.components[0].type, 1);
  assert.deepEqual(payload.components[0].components[0], {
    type: 2,
    style: 5,
    label: "Support the bot",
    url: "https://example.com/support",
  });
});

test("buildSupportPayload omits the donation button when no support URL is configured", () => {
  const payload = buildSupportPayload({});

  assert.equal(payload.components, undefined);
  assert.match(payload.embeds[0].description, /being set up/i);
});
