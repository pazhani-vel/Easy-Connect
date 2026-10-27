const assert = require("node:assert/strict");
const { test } = require("node:test");
const { MAX_ROOM_LIFETIME_MS, RoomService } = require("../src/roomService");

test("room service creates unpredictable room IDs and separate owner/peer capabilities", () => {
  const service = new RoomService();
  const first = service.createRoom(100);
  const second = service.createRoom(100);

  assert.match(first.room.id, /^[A-Z0-9]{6}$/u);
  assert.equal(first.room.id.length, 6);
  assert.notEqual(first.room.id, second.room.id);
  assert.equal(first.ownerCapability.length, 32);
  assert.equal(first.joinCapability, first.room.id);
  assert.notEqual(first.ownerCapability, first.joinCapability);
  assert.equal(first.room.createdAt, 100);
  assert.equal(first.room.expiresAt, 100 + 30 * 60 * 1000);
  assert.equal(Buffer.isBuffer(first.room.capabilities.owner), true);
  assert.equal(Buffer.isBuffer(first.room.capabilities.peer), true);
  assert.notEqual(first.room.capabilities.owner.toString(), first.ownerCapability);
});

test("capability checks distinguish roles and reject incorrect capabilities", () => {
  const service = new RoomService();
  const { room, ownerCapability, joinCapability } = service.createRoom();

  assert.equal(service.getRole(room, ownerCapability), "owner");
  assert.equal(service.getRole(room, joinCapability), "peer");
  assert.equal(service.getRole(room, "WRONGCODE"), null);
});

test("room lookup enforces the exact expiry boundary and destroy is idempotent", () => {
  const service = new RoomService({ roomLifetimeMs: 100 });
  const { room } = service.createRoom(1_000);

  assert.equal(service.getRoom(room.id, 1_099), room);
  assert.equal(service.getRoom(room.id, 1_100), null);
  assert.equal(service.rooms.has(room.id), true);
  assert.equal(service.destroyRoom(room.id), room);
  assert.equal(service.destroyRoom(room.id), null);
});

test("capacity is enforced until expired rooms are cleaned up", () => {
  const service = new RoomService({ maxRooms: 1, roomLifetimeMs: 10 });
  const { room } = service.createRoom(100);

  assert.equal(service.createRoom(105).error, "capacity");
  assert.equal(service.getRoom(room.id, 110), null);
  service.destroyRoom(room.id);
  assert.ok(service.createRoom(110).room);
});

test("room service rejects invalid capacities and lifetime configuration", () => {
  for (const maxRooms of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => new RoomService({ maxRooms }), RangeError);
  }
  for (const roomLifetimeMs of [0, -1, 1.5, MAX_ROOM_LIFETIME_MS + 1]) {
    assert.throws(() => new RoomService({ roomLifetimeMs }), RangeError);
  }
  assert.doesNotThrow(() => new RoomService({ maxRooms: 1, roomLifetimeMs: MAX_ROOM_LIFETIME_MS }));
});
