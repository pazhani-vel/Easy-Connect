const { createHash, randomBytes, timingSafeEqual } = require("node:crypto");

const ROOM_ID_BYTES = 16;
const CAPABILITY_BYTES = 32;
const MAX_ROOM_LIFETIME_MS = 2 * 60 * 60 * 1000;

function hashCapability(capability) {
  return createHash("sha256").update(capability, "utf8").digest();
}

class RoomService {
  constructor({ maxRooms = 10_000, roomLifetimeMs = 30 * 60 * 1000 } = {}) {
    if (!Number.isSafeInteger(maxRooms) || maxRooms < 1) {
      throw new RangeError("maxRooms must be a positive safe integer.");
    }
    if (!Number.isSafeInteger(roomLifetimeMs) || roomLifetimeMs < 1 || roomLifetimeMs > MAX_ROOM_LIFETIME_MS) {
      throw new RangeError("roomLifetimeMs must be between 1 ms and 2 hours.");
    }
    this.maxRooms = maxRooms;
    this.roomLifetimeMs = roomLifetimeMs;
    this.rooms = new Map();
  }

  createRoom(now = Date.now()) {
    if (this.rooms.size >= this.maxRooms) {
      return { error: "capacity" };
    }

    let roomId;
    do {
      roomId = randomBytes(ROOM_ID_BYTES).toString("base64url");
    } while (this.rooms.has(roomId));

    const ownerCapability = randomBytes(CAPABILITY_BYTES).toString("base64url");
    const joinCapability = randomBytes(CAPABILITY_BYTES).toString("base64url");
    const room = {
      id: roomId,
      createdAt: now,
      expiresAt: now + this.roomLifetimeMs,
      capabilities: {
        owner: hashCapability(ownerCapability),
        peer: hashCapability(joinCapability),
      },
      connections: new Map(),
      seenMessages: new Set(),
      seenNonces: new Set(),
    };
    this.rooms.set(roomId, room);

    return {
      room,
      ownerCapability,
      joinCapability,
    };
  }

  getRoom(roomId, now = Date.now()) {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    if (room.expiresAt <= now) return null;
    return room;
  }

  getRole(room, capability) {
    const providedHash = hashCapability(capability);
    if (timingSafeEqual(room.capabilities.owner, providedHash)) return "owner";
    if (timingSafeEqual(room.capabilities.peer, providedHash)) return "peer";
    return null;
  }

  destroyRoom(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    this.rooms.delete(roomId);
    return room;
  }
}

module.exports = { MAX_ROOM_LIFETIME_MS, RoomService };
