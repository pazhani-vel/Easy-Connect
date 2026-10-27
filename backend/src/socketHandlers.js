const {
  deleteEventSchema,
  joinEventSchema,
  messageEventSchema,
  parseEnvelope,
  roomEventSchema,
} = require("./validation");

const ROOM_EVENT_LIMITS = {
  join: { count: 5, windowMs: 60_000 },
  message: { count: 15, windowMs: 10_000 },
  mutation: { count: 20, windowMs: 10_000 },
  end: { count: 2, windowMs: 60_000 },
};

function createSocketHandlers(io, roomService) {
  const eventTimes = new Map();

  function allowEvent(socket, category) {
    const { count, windowMs } = ROOM_EVENT_LIMITS[category];
    const now = Date.now();
    const key = `${socket.id}:${category}`;
    const recent = (eventTimes.get(key) || []).filter((time) => now - time < windowMs);
    if (recent.length >= count) {
      eventTimes.set(key, recent);
      return false;
    }
    recent.push(now);
    eventTimes.set(key, recent);
    return true;
  }

  function reply(ack, result) {
    if (typeof ack === "function") ack(result);
  }

  function endRoom(roomId, reason) {
    const room = roomService.destroyRoom(roomId);
    if (!room) return false;
    io.to(roomId).emit("room:ended", { reason });
    for (const connection of room.connections.values()) {
      const peerSocket = io.sockets.sockets.get(connection.socketId);
      if (!peerSocket) continue;
      peerSocket.leave(roomId);
      peerSocket.data.roomId = null;
      peerSocket.data.role = null;
    }
    return true;
  }

  function getActiveRoom(roomId) {
    const room = roomService.getRoom(roomId);
    if (!room && roomService.rooms.has(roomId)) endRoom(roomId, "expired");
    return room;
  }

  function cleanupExpired() {
    const now = Date.now();
    for (const [roomId, room] of roomService.rooms) {
      if (room.expiresAt <= now) endRoom(roomId, "expired");
    }
  }

  io.on("connection", (socket) => {
    socket.data.roomId = null;
    socket.data.role = null;

    socket.on("room:join", (payload, ack) => {
      if (!allowEvent(socket, "join")) {
        reply(ack, { ok: false, error: "Join rate limit reached. Please wait." });
        return;
      }

      const input = joinEventSchema.safeParse(payload);
      if (!input.success) {
        reply(ack, { ok: false, error: "Invalid room credentials." });
        return;
      }
      if (socket.data.roomId) {
        reply(ack, { ok: false, error: "This connection has already joined a room." });
        return;
      }

      const room = getActiveRoom(input.data.roomId);
      const role = room && roomService.getRole(room, input.data.capability);
      if (!room || !role) {
        reply(ack, { ok: false, error: "Room unavailable or access code is invalid." });
        return;
      }
      const previousConnection = room.connections.get(role);
      if (previousConnection && previousConnection.sessionId !== input.data.sessionId) {
        reply(ack, { ok: false, error: "This room role is already connected in another session." });
        return;
      }
      if (previousConnection) {
        const previousSocket = io.sockets.sockets.get(previousConnection.socketId);
        if (previousSocket) {
          previousSocket.leave(room.id);
          previousSocket.data.roomId = null;
          previousSocket.data.role = null;
          previousSocket.data.sessionId = null;
          previousSocket.disconnect(true);
        }
        room.connections.delete(role);
      }
      if (room.connections.size >= 2) {
        reply(ack, { ok: false, error: "This room already has two connected participants." });
        return;
      }

      room.connections.set(role, {
        socketId: socket.id,
        sessionId: input.data.sessionId,
      });
      socket.data.roomId = room.id;
      socket.data.role = role;
      socket.data.sessionId = input.data.sessionId;
      socket.join(room.id);
      reply(ack, {
        ok: true,
        role,
        peerConnected: room.connections.size === 2,
        expiresAt: room.expiresAt,
      });
      socket.to(room.id).emit("room:peer-status", { online: true });
    });

    socket.on("message:send", (payload, ack) => {
      if (!allowEvent(socket, "message")) {
        reply(ack, { ok: false, error: "Message rate limit reached. Please wait." });
        return;
      }
      const input = messageEventSchema.safeParse(payload);
      const room = input.success && socket.data.roomId === input.data.roomId
        ? roomService.getRoom(input.data.roomId)
        : null;
      const envelope = input.success ? parseEnvelope(input.data.envelope) : null;
      if (!room || !socket.data.role || !envelope || envelope.sender !== socket.data.role) {
        reply(ack, { ok: false, error: "Message rejected." });
        return;
      }
      if (room.connections.size < 2) {
        reply(ack, { ok: false, error: "Wait for your peer to connect before sending." });
        return;
      }
      if (room.seenMessages.has(envelope.id)) {
        reply(ack, { ok: false, error: "Duplicate message rejected." });
        return;
      }
      if (room.seenNonces.has(envelope.nonce)) {
        reply(ack, { ok: false, error: "Message nonce was already used in this room." });
        return;
      }

      room.seenMessages.add(envelope.id);
      room.seenNonces.add(envelope.nonce);
      socket.to(room.id).emit("message:new", {
        roomId: room.id,
        envelope: input.data.envelope,
      });
      reply(ack, { ok: true });
    });

    socket.on("message:delete", (payload, ack) => {
      const input = deleteEventSchema.safeParse(payload);
      const room = input.success && socket.data.roomId === input.data.roomId
        ? getActiveRoom(input.data.roomId)
        : null;
      if (!allowEvent(socket, "mutation") || !room) {
        reply(ack, { ok: false, error: "Delete request rejected." });
        return;
      }
      socket.to(room.id).emit("message:deleted", { messageId: input.data.messageId });
      reply(ack, { ok: true });
    });

    socket.on("room:clear", (payload, ack) => {
      const input = roomEventSchema.safeParse(payload);
      const room = input.success && socket.data.roomId === input.data.roomId
        ? getActiveRoom(input.data.roomId)
        : null;
      if (!allowEvent(socket, "mutation") || !room) {
        reply(ack, { ok: false, error: "Clear request rejected." });
        return;
      }
      socket.to(room.id).emit("room:cleared");
      reply(ack, { ok: true });
    });

    socket.on("room:end", (payload, ack) => {
      const input = roomEventSchema.safeParse(payload);
      const room = input.success && socket.data.roomId === input.data.roomId
        ? getActiveRoom(input.data.roomId)
        : null;
      if (!allowEvent(socket, "end") || !room || socket.data.role !== "owner") {
        reply(ack, { ok: false, error: "Only the room creator can end this room." });
        return;
      }
      reply(ack, { ok: true });
      endRoom(room.id, "ended");
    });

    socket.on("disconnect", () => {
      eventTimes.delete(`${socket.id}:join`);
      eventTimes.delete(`${socket.id}:message`);
      eventTimes.delete(`${socket.id}:mutation`);
      eventTimes.delete(`${socket.id}:end`);
      const room = socket.data.roomId && getActiveRoom(socket.data.roomId);
      if (!room || !socket.data.role) return;
      if (room.connections.get(socket.data.role)?.socketId === socket.id) {
        room.connections.delete(socket.data.role);
        socket.to(room.id).emit("room:peer-status", { online: false });
      }
    });
  });

  return { cleanupExpired, endRoom };
}

module.exports = { createSocketHandlers };
