const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { test } = require("node:test");
const { io: createClient } = require("socket.io-client");
const { createSecureCodeServer } = require("../src/server");

async function startServer(options) {
  const instance = createSecureCodeServer(options);
  await new Promise((resolve) => instance.httpServer.listen(0, "127.0.0.1", resolve));
  return {
    ...instance,
    baseUrl: `http://127.0.0.1:${instance.httpServer.address().port}`,
  };
}

async function createRoom(baseUrl) {
  const response = await fetch(`${baseUrl}/api/rooms`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(response.status, 201);
  return response.json();
}

async function connectClient(baseUrl, origin) {
  const socket = createClient(baseUrl, {
    reconnection: false,
    transports: ["websocket"],
    ...(origin ? { extraHeaders: { Origin: origin } } : {}),
  });
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("connect_error", reject);
  });
  return socket;
}

function emitAck(socket, event, payload) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

function membership(room, capability, sessionId = randomUUID()) {
  return { roomId: room.roomId, capability, sessionId };
}

test("HTTP endpoints validate inputs and return browser security headers", async () => {
  const server = await startServer({ frontendOrigins: ["https://secure.example"] });
  try {
    const health = await fetch(`${server.baseUrl}/api/health`, {
      headers: { Origin: "https://secure.example" },
    });
    assert.equal(health.status, 200);
    assert.equal(health.headers.get("access-control-allow-origin"), "https://secure.example");
    assert.equal(health.headers.get("x-content-type-options"), "nosniff");
    assert.equal(health.headers.get("x-powered-by"), null);
    assert.match(health.headers.get("content-security-policy"), /default-src 'self'/u);
    assert.equal(health.headers.get("referrer-policy"), "no-referrer");

    const deniedOrigin = await fetch(`${server.baseUrl}/api/health`, {
      headers: { Origin: "https://attacker.example" },
    });
    assert.equal(deniedOrigin.status, 403);
    assert.equal(deniedOrigin.headers.get("access-control-allow-origin"), null);

    const invalidRoomId = await fetch(`${server.baseUrl}/api/rooms/not-a-room`);
    assert.equal(invalidRoomId.status, 400);

    const room = await createRoom(server.baseUrl);
    const invalidCredentials = await fetch(`${server.baseUrl}/api/rooms/${room.roomId}/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability: "too-short" }),
    });
    assert.equal(invalidCredentials.status, 400);

    const wrongCapability = await fetch(`${server.baseUrl}/api/rooms/${room.roomId}/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability: "A".repeat(43) }),
    });
    assert.equal(wrongCapability.status, 404);

    const malformedJson = await fetch(`${server.baseUrl}/api/rooms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{invalid",
    });
    assert.equal(malformedJson.status, 400);
  } finally {
    await server.close();
  }
});

test("HTTP room-capacity and creation-rate limits return explicit errors", async () => {
  const capacityServer = await startServer({ maxRooms: 1 });
  try {
    await createRoom(capacityServer.baseUrl);
    const full = await fetch(`${capacityServer.baseUrl}/api/rooms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(full.status, 503);
    assert.match((await full.json()).error, /capacity/i);
  } finally {
    await capacityServer.close();
  }

  const rateServer = await startServer();
  try {
    const responses = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      responses.push(await fetch(`${rateServer.baseUrl}/api/rooms`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }));
    }
    assert.deepEqual(responses.slice(0, 5).map((response) => response.status), [201, 201, 201, 201, 201]);
    assert.equal(responses[5].status, 429);
  } finally {
    await rateServer.close();
  }
});

test("room verification, joining, and termination endpoints enforce their rate limits", async () => {
  const server = await startServer();
  try {
    const room = await createRoom(server.baseUrl);
    const verificationResponses = [];
    for (let attempt = 0; attempt < 61; attempt += 1) {
      verificationResponses.push(await fetch(`${server.baseUrl}/api/rooms/${room.roomId}`));
    }
    assert.equal(verificationResponses[59].status, 200);
    assert.equal(verificationResponses[60].status, 429);

    const joinResponses = [];
    for (let attempt = 0; attempt < 21; attempt += 1) {
      joinResponses.push(await fetch(`${server.baseUrl}/api/rooms/${room.roomId}/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ capability: "A".repeat(43) }),
      }));
    }
    assert.equal(joinResponses[19].status, 404);
    assert.equal(joinResponses[20].status, 429);

    const endResponses = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      endResponses.push(await fetch(`${server.baseUrl}/api/rooms/${room.roomId}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ capability: room.joinCapability }),
      }));
    }
    assert.equal(endResponses[4].status, 403);
    assert.equal(endResponses[5].status, 429);
  } finally {
    await server.close();
  }
});

test("Socket.IO rejects unapproved origins even when using a direct WebSocket", async () => {
  const server = await startServer({ frontendOrigins: ["https://secure.example"] });
  try {
    await assert.rejects(connectClient(server.baseUrl, "https://attacker.example"), /Origin not allowed/u);
    const allowed = await connectClient(server.baseUrl, "https://secure.example");
    allowed.disconnect();
  } finally {
    await server.close();
  }
});

test("socket authorization prevents role spoofing and membership across rooms", async () => {
  const server = await startServer();
  let owner;
  let peer;
  let stranger;
  try {
    const room = await createRoom(server.baseUrl);
    const otherRoom = await createRoom(server.baseUrl);
    owner = await connectClient(server.baseUrl);
    peer = await connectClient(server.baseUrl);
    stranger = await connectClient(server.baseUrl);
    assert.equal((await emitAck(owner, "room:join", membership(room, room.ownerCapability))).ok, true);
    assert.equal((await emitAck(peer, "room:join", membership(room, room.joinCapability))).ok, true);

    const duplicateRole = await emitAck(stranger, "room:join", membership(room, room.ownerCapability));
    assert.equal(duplicateRole.ok, false);
    assert.match(duplicateRole.error, /already connected/u);

    const joinedElsewhere = await emitAck(owner, "room:join", membership(otherRoom, otherRoom.ownerCapability));
    assert.equal(joinedElsewhere.ok, false);
    assert.match(joinedElsewhere.error, /already joined/u);

    const { deriveRoomKey, encryptMessage, randomRoomSecret } = await import("../../frontend/src/crypto/index.js");
    const key = await deriveRoomKey(randomRoomSecret(), room.roomId);
    const forged = await encryptMessage("role spoof", key, room.roomId, "owner");
    const spoofedSend = await emitAck(peer, "message:send", {
      roomId: room.roomId,
      envelope: forged.serialized,
    });
    assert.equal(spoofedSend.ok, false);

    const unjoinedSend = await emitAck(stranger, "message:send", {
      roomId: room.roomId,
      envelope: forged.serialized,
    });
    assert.equal(unjoinedSend.ok, false);
    assert.equal((await emitAck(stranger, "message:delete", {
      roomId: room.roomId,
      messageId: randomUUID(),
    })).ok, false);
    assert.equal((await emitAck(stranger, "room:end", { roomId: room.roomId })).ok, false);
  } finally {
    owner?.disconnect();
    peer?.disconnect();
    stranger?.disconnect();
    await server.close();
  }
});

test("socket message rate limits reject the 16th message in a 10-second window", async () => {
  const server = await startServer();
  let owner;
  let peer;
  try {
    const room = await createRoom(server.baseUrl);
    owner = await connectClient(server.baseUrl);
    peer = await connectClient(server.baseUrl);
    assert.equal((await emitAck(owner, "room:join", membership(room, room.ownerCapability))).ok, true);
    assert.equal((await emitAck(peer, "room:join", membership(room, room.joinCapability))).ok, true);

    const { deriveRoomKey, encryptMessage, randomRoomSecret } = await import("../../frontend/src/crypto/index.js");
    const key = await deriveRoomKey(randomRoomSecret(), room.roomId);
    const results = [];
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const { serialized } = await encryptMessage(`test message ${attempt}`, key, room.roomId, "owner");
      results.push(await emitAck(owner, "message:send", { roomId: room.roomId, envelope: serialized }));
    }
    assert.equal(results.slice(0, 15).every((result) => result.ok), true);
    assert.equal(results[15].ok, false);
    assert.match(results[15].error, /rate limit/i);
  } finally {
    owner?.disconnect();
    peer?.disconnect();
    await server.close();
  }
});

test("an expired joined room notifies its connected participant and is removed", async () => {
  const server = await startServer({ roomLifetimeMs: 40 });
  let owner;
  try {
    const room = await createRoom(server.baseUrl);
    owner = await connectClient(server.baseUrl);
    assert.equal((await emitAck(owner, "room:join", membership(room, room.ownerCapability))).ok, true);
    const ended = new Promise((resolve) => owner.once("room:ended", resolve));
    await new Promise((resolve) => setTimeout(resolve, 55));
    const verify = await fetch(`${server.baseUrl}/api/rooms/${room.roomId}`);
    assert.equal(verify.status, 404);
    assert.deepEqual(await ended, { reason: "expired" });
    assert.equal(server.roomService.rooms.has(room.roomId), false);
  } finally {
    owner?.disconnect();
    await server.close();
  }
});

test("socket room termination is creator-only and notifies both connected participants", async () => {
  const server = await startServer();
  let owner;
  let peer;
  try {
    const room = await createRoom(server.baseUrl);
    owner = await connectClient(server.baseUrl);
    peer = await connectClient(server.baseUrl);
    assert.equal((await emitAck(owner, "room:join", membership(room, room.ownerCapability))).ok, true);
    assert.equal((await emitAck(peer, "room:join", membership(room, room.joinCapability))).ok, true);
    const ownerEnded = new Promise((resolve) => owner.once("room:ended", resolve));
    const peerEnded = new Promise((resolve) => peer.once("room:ended", resolve));
    assert.equal((await emitAck(peer, "room:end", { roomId: room.roomId })).ok, false);
    assert.equal((await emitAck(owner, "room:end", { roomId: room.roomId })).ok, true);
    assert.deepEqual(await ownerEnded, { reason: "ended" });
    assert.deepEqual(await peerEnded, { reason: "ended" });
    assert.equal(server.roomService.rooms.has(room.roomId), false);
  } finally {
    owner?.disconnect();
    peer?.disconnect();
    await server.close();
  }
});
