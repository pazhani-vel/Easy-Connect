const { z } = require("zod");

// Room ID: 6-character simple code or legacy 22-char ID
const roomIdSchema = z.string().regex(/^(?:[A-Za-z0-9]{6}|[A-Za-z0-9_-]{22})$/);
// Capability: 6-character peer code, 32-char hex owner token, or legacy 43-char capability
const capabilitySchema = z.string().regex(/^(?:[A-Za-z0-9]{6}|[A-Za-z0-9]{32}|[A-Za-z0-9_-]{43})$/);
// Room code: simple 6-char code or composite
const roomCodeSchema = z.string().regex(/^(?:[A-Za-z0-9]{6}|[A-Za-z0-9]{6}\.[A-Za-z0-9]{6}|[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43})$/);
const messageIdSchema = z.string().uuid();

const createRoomSchema = z.object({}).strict();
const capabilityBodySchema = z.object({ capability: capabilitySchema }).strict();
const joinEventSchema = z.object({
  roomId: roomIdSchema,
  capability: capabilitySchema,
  sessionId: z.string().uuid(),
}).strict();
const messageEventSchema = z.object({
  roomId: roomIdSchema,
  envelope: z.string().max(48 * 1024),
}).strict();
const deleteEventSchema = z.object({
  roomId: roomIdSchema,
  messageId: messageIdSchema,
}).strict();
const roomEventSchema = z.object({ roomId: roomIdSchema }).strict();

const envelopeSchema = z.object({
  version: z.literal(1),
  id: messageIdSchema,
  nonce: z.string().regex(/^[A-Za-z0-9_-]{16}$/),
  ciphertext: z.string().min(22).max(44_000).regex(/^[A-Za-z0-9_-]+$/),
  createdAt: z.number().int().min(0).max(8_640_000_000_000_000),
  sender: z.enum(["owner", "peer"]),
}).strict();

function parseEnvelope(serialized) {
  try {
    const parsed = JSON.parse(serialized);
    const result = envelopeSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

module.exports = {
  capabilityBodySchema,
  capabilitySchema,
  createRoomSchema,
  deleteEventSchema,
  joinEventSchema,
  messageEventSchema,
  messageIdSchema,
  parseEnvelope,
  roomCodeSchema,
  roomEventSchema,
  roomIdSchema,
};
