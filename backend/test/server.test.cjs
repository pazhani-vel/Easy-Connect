const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { test } = require("node:test");
const { io: createClient } = require("socket.io-client");
const { createSecureCodeServer } = require("../src/server");

async function startServer(options) {
  const instance = createSecureCodeServer(options);
  await new Promise((resolve) => instance.httpServer.listen(0, "127.0.0.1", resolve));
  const address = instance.httpServer.address();
  return { ...instance, baseUrl: `http://127.0.0.1:${address.port}` };
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

async function connectClient(baseUrl) {
  const socket = createClient(baseUrl, { reconnection: false, transports: ["websocket"] });
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("connect_error", reject);
  });
  return socket;
}

function emitAck(socket, event, payload) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

test("health, room authorization, termination, and oversized HTTP requests", async () => {
  const server = await startServer();
  try {
    const health = await fetch(`${server.baseUrl}/api/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "ok" });

    const room = await createRoom(server.baseUrl);
    assert.match(room.roomId, /^[A-Z0-9]{6}$/u);
    assert.equal(room.ownerCapability.length, 32);
    assert.equal(room.joinCapability, room.roomId);

    const verify = await fetch(`${server.baseUrl}/api/rooms/${room.roomId}`);
    assert.equal(verify.status, 200);

    const peerJoin = await fetch(`${server.baseUrl}/api/rooms/${room.roomId}/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability: room.joinCapability }),
    });
    assert.equal((await peerJoin.json()).role, "peer");

    const unauthorizedDelete = await fetch(`${server.baseUrl}/api/rooms/${room.roomId}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability: room.joinCapability }),
    });
    assert.equal(unauthorizedDelete.status, 403);

    const oversized = await fetch(`${server.baseUrl}/api/rooms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payload: "x".repeat(2_000) }),
    });
    assert.equal(oversized.status, 413);

    const terminate = await fetch(`${server.baseUrl}/api/rooms/${room.roomId}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability: room.ownerCapability }),
    });
    assert.equal(terminate.status, 200);
    const missing = await fetch(`${server.baseUrl}/api/rooms/${room.roomId}`);
    assert.equal(missing.status, 404);
  } finally {
    await server.close();
  }
});

test("only authorized members can relay ciphertext and the server keeps no message or key", async () => {
  const server = await startServer();
  let owner;
  let peer;
  let stranger;
  try {
    const room = await createRoom(server.baseUrl);
    owner = await connectClient(server.baseUrl);
    peer = await connectClient(server.baseUrl);
    stranger = await connectClient(server.baseUrl);
    assert.equal((await emitAck(owner, "room:join", {
      roomId: room.roomId,
      capability: room.ownerCapability,
      sessionId: "10000000-0000-4000-8000-000000000001",
    })).ok, true);
    assert.equal((await emitAck(peer, "room:join", {
      roomId: room.roomId,
      capability: room.joinCapability,
      sessionId: "10000000-0000-4000-8000-000000000002",
    })).ok, true);
    assert.equal((await emitAck(stranger, "room:join", {
      roomId: room.roomId,
      capability: "A".repeat(43),
      sessionId: "10000000-0000-4000-8000-000000000003",
    })).ok, false);

    const {
      decryptMessage,
      deriveRoomKey,
      encryptMessage,
      randomRoomSecret,
    } = await import("../../frontend/src/crypto/index.js");
    const secret = randomRoomSecret();
    const key = await deriveRoomKey(secret, room.roomId);
    const plaintext = "fixture-secret-marker / API_TOKEN_value";
    const { serialized } = await encryptMessage(plaintext, key, room.roomId, "owner");
    const received = new Promise((resolve) => peer.once("message:new", resolve));
    const sendResult = await emitAck(owner, "message:send", {
      roomId: room.roomId,
      envelope: serialized,
    });
    assert.equal(sendResult.ok, true);
    const delivery = await received;
    assert.equal(delivery.envelope, serialized);
    assert.equal(delivery.envelope.includes(plaintext), false);
    assert.equal(await decryptMessage(delivery.envelope, key, room.roomId).then((message) => message.text), plaintext);

    const parsedEnvelope = JSON.parse(serialized);
    const reusedNonce = await emitAck(owner, "message:send", {
      roomId: room.roomId,
      envelope: JSON.stringify({ ...parsedEnvelope, id: randomUUID() }),
    });
    assert.equal(reusedNonce.ok, false);

    const unauthorized = await emitAck(stranger, "message:send", {
      roomId: room.roomId,
      envelope: serialized,
    });
    assert.equal(unauthorized.ok, false);

    const messageDeleted = new Promise((resolve) => peer.once("message:deleted", resolve));
    assert.equal((await emitAck(owner, "message:delete", {
      roomId: room.roomId,
      messageId: parsedEnvelope.id,
    })).ok, true);
    assert.deepEqual(await messageDeleted, { messageId: parsedEnvelope.id });
    assert.equal((await emitAck(stranger, "room:clear", { roomId: room.roomId })).ok, false);

    const chatCleared = new Promise((resolve) => peer.once("room:cleared", resolve));
    assert.equal((await emitAck(owner, "room:clear", { roomId: room.roomId })).ok, true);
    await chatCleared;

    const oversized = await emitAck(owner, "message:send", {
      roomId: room.roomId,
      envelope: "x".repeat(48 * 1024 + 1),
    });
    assert.equal(oversized.ok, false);

    const memoryRoom = server.roomService.getRoom(room.roomId);
    assert.equal(JSON.stringify(memoryRoom).includes(plaintext), false);
    assert.equal(JSON.stringify(memoryRoom).includes(secret), false);
    assert.equal(Object.hasOwn(memoryRoom, "messages"), false);
    assert.equal(Object.hasOwn(memoryRoom, "key"), false);
    assert.equal(Object.hasOwn(memoryRoom, "secret"), false);
  } finally {
    owner?.disconnect();
    peer?.disconnect();
    stranger?.disconnect();
    await server.close();
  }
});

test("expired rooms cannot be verified or joined", async () => {
  const server = await startServer({ roomLifetimeMs: 50 });
  try {
    const room = await createRoom(server.baseUrl);
    await new Promise((resolve) => setTimeout(resolve, 70));
    const verify = await fetch(`${server.baseUrl}/api/rooms/${room.roomId}`);
    assert.equal(verify.status, 404);
    const join = await fetch(`${server.baseUrl}/api/rooms/${room.roomId}/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability: room.ownerCapability }),
    });
    assert.equal(join.status, 404);
  } finally {
    await server.close();
  }
});

test("socket join attempts are rate limited", async () => {
  const server = await startServer();
  let socket;
  try {
    const room = await createRoom(server.baseUrl);
    socket = await connectClient(server.baseUrl);
    const results = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      results.push(await emitAck(socket, "room:join", {
        roomId: room.roomId,
        capability: room.ownerCapability,
        sessionId: "10000000-0000-4000-8000-000000000004",
      }));
    }
    assert.match(results[5].error, /rate limit/i);
  } finally {
    socket?.disconnect();
    await server.close();
  }
});

test("a reconnecting socket can reclaim only its own temporary session", async () => {
  const server = await startServer();
  let original;
  let replacement;
  let stranger;
  try {
    const room = await createRoom(server.baseUrl);
    original = await connectClient(server.baseUrl);
    const sessionId = "10000000-0000-4000-8000-000000000005";
    assert.equal((await emitAck(original, "room:join", {
      roomId: room.roomId,
      capability: room.ownerCapability,
      sessionId,
    })).ok, true);

    replacement = await connectClient(server.baseUrl);
    const originalDisconnected = new Promise((resolve) => original.once("disconnect", resolve));
    assert.equal((await emitAck(replacement, "room:join", {
      roomId: room.roomId,
      capability: room.ownerCapability,
      sessionId,
    })).ok, true);
    await originalDisconnected;

    stranger = await connectClient(server.baseUrl);
    const duplicateSession = await emitAck(stranger, "room:join", {
      roomId: room.roomId,
      capability: room.ownerCapability,
      sessionId: "10000000-0000-4000-8000-000000000006",
    });
    assert.equal(duplicateSession.ok, false);
    assert.match(duplicateSession.error, /another session/i);
  } finally {
    original?.disconnect();
    replacement?.disconnect();
    stranger?.disconnect();
    await server.close();
  }
});
