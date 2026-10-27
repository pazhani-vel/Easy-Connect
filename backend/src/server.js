require("dotenv").config();

const cors = require("cors");
const express = require("express");
const rateLimit = require("express-rate-limit");
const helmet = require("helmet");
const fs = require("node:fs");
const path = require("node:path");
const { createServer } = require("node:http");
const { Server } = require("socket.io");
const { z } = require("zod");
const { RoomService } = require("./roomService");
const { createSocketHandlers } = require("./socketHandlers");
const {
  capabilityBodySchema,
  createRoomSchema,
  roomIdSchema,
} = require("./validation");

const DEFAULT_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"];

function makeRateLimiter({ windowMs, limit, message }) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({ error: message }),
  });
}

function createSecureCodeServer({
  frontendOrigins = (process.env.FRONTEND_ORIGINS || DEFAULT_ORIGINS.join(","))
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
  maxRooms = Number(process.env.MAX_ACTIVE_ROOMS || 10_000),
  roomLifetimeMs = Number(process.env.ROOM_LIFETIME_MS || 30 * 60 * 1000),
} = {}) {
  const roomService = new RoomService({ maxRooms, roomLifetimeMs });
  const app = express();
  const httpServer = createServer(app);
  const allowAllOrigins = frontendOrigins.includes("*");
  const originAllowed = (origin) => !origin || allowAllOrigins || frontendOrigins.includes(origin);
  const io = new Server(httpServer, {
    cors: {
      origin: (origin, callback) => callback(null, originAllowed(origin)),
      methods: ["GET", "POST"],
    },
    transports: ["websocket", "polling"],
    maxHttpBufferSize: 64 * 1024,
    pingTimeout: 20_000,
    pingInterval: 25_000,
  });
  io.use((socket, next) => {
    const origin = socket.handshake.headers.origin;
    if (!originAllowed(origin)) {
      next(new Error("Origin not allowed."));
      return;
    }
    if (io.engine.clientsCount >= 20_000) {
      next(new Error("Server connection capacity reached."));
      return;
    }
    next();
  });
  const { cleanupExpired, endRoom } = createSocketHandlers(io, roomService);
  const getActiveRoom = (roomId) => {
    const room = roomService.getRoom(roomId);
    if (!room && roomService.rooms.has(roomId)) endRoom(roomId, "expired");
    return room;
  };

  app.disable("x-powered-by");
  app.set("trust proxy", process.env.TRUST_PROXY === "true" ? 1 : false);
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        connectSrc: ["'self'", "http://localhost:5000", "ws://localhost:5000", "https:", "wss:"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        imgSrc: ["'self'", "data:"],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        upgradeInsecureRequests: process.env.NODE_ENV === "production" ? [] : null,
      },
    },
    referrerPolicy: { policy: "no-referrer" },
  }));
  app.use(cors({
    origin: (origin, callback) => {
      if (originAllowed(origin)) callback(null, true);
      else callback(new Error("Origin not allowed"));
    },
    methods: ["GET", "POST", "DELETE"],
    allowedHeaders: ["Content-Type"],
  }));
  app.use(express.json({ limit: "1kb", strict: true }));

  app.get("/api/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  app.post(
    "/api/rooms",
    makeRateLimiter({ windowMs: 60_000, limit: 5, message: "Too many room creation requests." }),
    (req, res) => {
      const input = createRoomSchema.safeParse(req.body);
      if (!input.success) {
        res.status(400).json({ error: "Invalid room request." });
        return;
      }
      cleanupExpired();
      const result = roomService.createRoom();
      if (result.error === "capacity") {
        res.status(503).json({ error: "Room capacity is temporarily full." });
        return;
      }
      res.status(201).json({
        roomId: result.room.id,
        ownerCapability: result.ownerCapability,
        joinCapability: result.joinCapability,
        expiresAt: result.room.expiresAt,
      });
    },
  );

  app.get(
    "/api/rooms/:roomId",
    makeRateLimiter({ windowMs: 60_000, limit: 60, message: "Too many room verification requests." }),
    (req, res) => {
      const parsedRoomId = roomIdSchema.safeParse(req.params.roomId);
      if (!parsedRoomId.success) {
        res.status(400).json({ error: "Invalid room code." });
        return;
      }
      const room = getActiveRoom(parsedRoomId.data);
      if (!room) {
        res.status(404).json({ error: "Room unavailable or expired." });
        return;
      }
      res.status(200).json({ available: true, expiresAt: room.expiresAt });
    },
  );

  app.post(
    "/api/rooms/:roomId/join",
    makeRateLimiter({ windowMs: 60_000, limit: 20, message: "Too many join attempts." }),
    (req, res) => {
      const parsedRoomId = roomIdSchema.safeParse(req.params.roomId);
      const parsedBody = capabilityBodySchema.safeParse(req.body);
      if (!parsedRoomId.success || !parsedBody.success) {
        res.status(400).json({ error: "Invalid room credentials." });
        return;
      }
      const room = getActiveRoom(parsedRoomId.data);
      const role = room && roomService.getRole(room, parsedBody.data.capability);
      if (!room || !role) {
        res.status(404).json({ error: "Room unavailable or access code is invalid." });
        return;
      }
      res.status(200).json({ role, expiresAt: room.expiresAt });
    },
  );

  app.delete(
    "/api/rooms/:roomId",
    makeRateLimiter({ windowMs: 60_000, limit: 5, message: "Too many room termination requests." }),
    (req, res) => {
      const parsedRoomId = roomIdSchema.safeParse(req.params.roomId);
      const parsedBody = capabilityBodySchema.safeParse(req.body);
      if (!parsedRoomId.success || !parsedBody.success) {
        res.status(400).json({ error: "Invalid room credentials." });
        return;
      }
      const room = getActiveRoom(parsedRoomId.data);
      if (!room || roomService.getRole(room, parsedBody.data.capability) !== "owner") {
        res.status(403).json({ error: "Room termination was not authorized." });
        return;
      }
      endRoom(room.id, "ended");
      res.status(200).json({ ended: true });
    },
  );

  // Serve static frontend build if present
  const staticPath = [
    path.resolve(__dirname, "../../frontend/dist"),
    path.resolve(__dirname, "../public"),
  ].find((p) => fs.existsSync(p));

  if (staticPath) {
    app.use(express.static(staticPath));
    app.get(/^(?!\/api).*/, (_req, res) => {
      res.sendFile(path.join(staticPath, "index.html"));
    });
  }

  app.use((err, _req, res, _next) => {
    if (err.type === "entity.too.large") {
      res.status(413).json({ error: "Request body is too large." });
      return;
    }
    if (err instanceof SyntaxError && "body" in err) {
      res.status(400).json({ error: "Invalid JSON request." });
      return;
    }
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: "Invalid request." });
      return;
    }
    if (err.message === "Origin not allowed") {
      res.status(403).json({ error: "Origin not allowed." });
      return;
    }
    res.status(500).json({ error: "Internal server error." });
  });

  const cleanupTimer = setInterval(cleanupExpired, 60_000);
  cleanupTimer.unref();

  return {
    app,
    httpServer,
    io,
    roomService,
    close: async () => {
      clearInterval(cleanupTimer);
      await new Promise((resolve) => io.close(resolve));
    },
  };
}

if (require.main === module) {
  const port = Number(process.env.PORT || 5000);
  const secureCodeServer = createSecureCodeServer();
  secureCodeServer.httpServer.listen(port, () => {
    process.stdout.write(`SecureCode API listening on port ${port}\n`);
  });
}

module.exports = { createSecureCodeServer };
