const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { test } = require("node:test");
const {
  capabilityBodySchema,
  createRoomSchema,
  deleteEventSchema,
  joinEventSchema,
  messageEventSchema,
  parseEnvelope,
  roomCodeSchema,
  roomEventSchema,
  roomIdSchema,
} = require("../src/validation");

const roomId = "MDEyMzQ1Njc4OWFiY2RlZg";
const capability = "A".repeat(43);

test("room IDs, room codes, capabilities, and message IDs enforce exact formats", () => {
  assert.equal(roomIdSchema.safeParse(roomId).success, true);
  assert.equal(roomIdSchema.safeParse(`${roomId}x`).success, false);
  assert.equal(roomIdSchema.safeParse(`${roomId}.`).success, false);
  assert.equal(roomCodeSchema.safeParse(`${roomId}.${capability}`).success, true);
  assert.equal(roomCodeSchema.safeParse(`${roomId}.${"A".repeat(42)}`).success, false);
  assert.equal(capabilityBodySchema.safeParse({ capability }).success, true);
  assert.equal(capabilityBodySchema.safeParse({ capability, secret: "not-allowed" }).success, false);
  assert.equal(deleteEventSchema.safeParse({ roomId, messageId: randomUUID() }).success, true);
  assert.equal(deleteEventSchema.safeParse({ roomId, messageId: "not-a-uuid" }).success, false);
});

test("schemas reject extra properties, malformed membership, and oversized payloads", () => {
  assert.equal(createRoomSchema.safeParse({}).success, true);
  assert.equal(createRoomSchema.safeParse({ roomId }).success, false);
  assert.equal(joinEventSchema.safeParse({ roomId, capability, sessionId: randomUUID() }).success, true);
  assert.equal(joinEventSchema.safeParse({ roomId, capability }).success, false);
  assert.equal(joinEventSchema.safeParse({ roomId, capability, sessionId: randomUUID(), role: "owner" }).success, false);
  assert.equal(roomEventSchema.safeParse({ roomId }).success, true);
  assert.equal(roomEventSchema.safeParse({ roomId, capability }).success, false);
  assert.equal(messageEventSchema.safeParse({ roomId, envelope: "x".repeat(48 * 1024) }).success, true);
  assert.equal(messageEventSchema.safeParse({ roomId, envelope: "x".repeat(48 * 1024 + 1) }).success, false);
  assert.equal(messageEventSchema.safeParse({ roomId, envelope: "x", extra: true }).success, false);
});

test("envelope parser accepts the protocol shape and rejects malformed JSON/metadata", () => {
  const valid = {
    version: 1,
    id: randomUUID(),
    nonce: "A".repeat(16),
    ciphertext: "A".repeat(22),
    createdAt: Date.now(),
    sender: "owner",
  };
  assert.deepEqual(parseEnvelope(JSON.stringify(valid)), valid);
  for (const input of [
    "",
    "{",
    JSON.stringify({ ...valid, version: 2 }),
    JSON.stringify({ ...valid, sender: "admin" }),
    JSON.stringify({ ...valid, createdAt: -1 }),
    JSON.stringify({ ...valid, nonce: "short" }),
    JSON.stringify({ ...valid, ciphertext: "not base64!" }),
    JSON.stringify({ ...valid, extra: "unexpected" }),
  ]) {
    assert.equal(parseEnvelope(input), null);
  }
});
