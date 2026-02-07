import "dotenv/config";
import express from "express";
import http from "http";
import cors from "cors";
import { Server } from "socket.io";
import * as path from "node:path";
import * as fs from "node:fs";

import searchRouter from "./routes/search.js";
import prepareRouter from "./routes/prepare.js";
import lyricsRouter from "./routes/lyrics.js";

const PORT = Number(process.env.PORT || 4000);
const HOST = process.env.HOST || "0.0.0.0";

const app = express();
app.use(cors());
app.use(express.json());

const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: { origin: "*" },
});

/** ---------- In-memory state ---------- */
type Room = {
  roomId: string;
  roomName: string;
  socketId: string;
};

type Match = {
  matchId: string;
  roomA: Room;
  roomB: Room;
  startAt: number;
  videoFile: string;
  title: string;
};

type ScoreState = {
  matchId: string;
  scores: Record<string, number>;
};

const rooms = new Map<string, Room>();
let currentMatch: Match | null = null;
let scoreState: ScoreState | null = null;

const PLAYLIST: Array<{ file: string; title: string }> = [
  { file: "01_cant_take_my_eyes_off_you.mp4", title: "Can't Take My Eyes Off You" },
  { file: "02_dont_you.mp4", title: "Don't You (Forget About Me)" },
  { file: "03_let_it_be.mp4", title: "Let It Be" },
  { file: "04_living_on_a_prayer.mp4", title: "Livin' on a Prayer" },
  { file: "05_mamma_mia.mp4", title: "Mamma Mia" },
  { file: "06_only_yesterday.mp4", title: "Only Yesterday" },
  { file: "07_la_plus_belle_pour_aller_danser.mp4", title: "La plus belle pour aller danser" },
  { file: "08_lamitie.mp4", title: "L'amitié" },
  { file: "09_comment_te_dire_adieu.mp4", title: "Comment te dire adieu" },
  { file: "10_il_jouait_du_piano_debout.mp4", title: "Il jouait du piano debout" },
];

function pickRandomSong() {
  const idx = Math.floor(Math.random() * PLAYLIST.length);
  return PLAYLIST[idx];
}

/** ---------- REST ---------- */

app.get("/api/songs", (_req, res) => {
  const cacheRoot = path.join(process.cwd(), "cache");
  const items: Array<{
    id: string;
    title: string;
    videoFile: string;
    channelTitle: string;
    instrumentalUrl: string;
    vocalsUrl: string;
    preparedAt: string;
  }> = [];

  if (fs.existsSync(cacheRoot)) {
    const dirs = fs
      .readdirSync(cacheRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    for (const videoId of dirs) {
      const videoDir = path.join(cacheRoot, videoId);
      const instPath = path.join(videoDir, "instrumental.wav");
      const voxPath = path.join(videoDir, "vocals.wav");
      if (!fs.existsSync(instPath) || !fs.existsSync(voxPath)) continue;

      let title = videoId;
      let channelTitle = "Unknown";
      const metaPath = path.join(videoDir, "meta.json");
      if (fs.existsSync(metaPath)) {
        try {
          const raw = fs.readFileSync(metaPath, "utf-8");
          const meta = JSON.parse(raw) as { title?: string; channelTitle?: string };
          if (typeof meta.title === "string" && meta.title.trim()) title = meta.title;
          if (typeof meta.channelTitle === "string" && meta.channelTitle.trim()) channelTitle = meta.channelTitle;
        } catch {
          // ignore malformed meta
        }
      }

      const stat = fs.statSync(instPath);
      items.push({
        id: videoId,
        title,
        videoFile: `${videoId}.mp4`,
        channelTitle,
        instrumentalUrl: `/cache/${videoId}/instrumental.wav`,
        vocalsUrl: `/cache/${videoId}/vocals.wav`,
        preparedAt: stat.mtime.toISOString(),
      });
    }
  }

  items.sort((a, b) => (a.preparedAt < b.preparedAt ? 1 : -1));

  // Backward compatible fallback when cache is empty
  if (items.length === 0) {
    return res.json(
      PLAYLIST.map((s) => ({
        id: s.file,
        title: s.title,
        videoFile: s.file,
      }))
    );
  }

  return res.json(items);
});

// YouTube search endpoint
app.use("/api/search", searchRouter);

// Prepare endpoint (download + separate)
app.use("/api/prepare", prepareRouter);

// Lyrics endpoint (captions if available)
app.use("/api/lyrics", lyricsRouter);

// Serve cache files statically
app.use("/cache", express.static("cache"));

/**
 * What People Are Singing (Option A):
 * list recently prepared songs by scanning ./cache
 *
 * GET /api/activity/recent?limit=12
 * returns: [{ videoId, title, channelTitle, instrumentalUrl, vocalsUrl, preparedAt }]
 *
 * title/channelTitle are read from cache/<videoId>/meta.json if present.
 */
app.get("/api/activity/recent", (req, res) => {
  const limitRaw = req.query.limit as string | undefined;
  const limit = Math.max(1, Math.min(Number(limitRaw || 12), 50));

  const cacheRoot = path.join(process.cwd(), "cache");
  if (!fs.existsSync(cacheRoot)) {
    return res.json({ items: [] });
  }

  const dirs = fs
    .readdirSync(cacheRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  const items: Array<{
    videoId: string;
    title: string;
    channelTitle: string;
    instrumentalUrl: string;
    vocalsUrl: string;
    preparedAt: string;
  }> = [];

  for (const videoId of dirs) {
    const videoDir = path.join(cacheRoot, videoId);
    const instPath = path.join(videoDir, "instrumental.wav");
    const voxPath = path.join(videoDir, "vocals.wav");

    if (!fs.existsSync(instPath) || !fs.existsSync(voxPath)) continue;

    // Read meta if exists
    let title = videoId;
    let channelTitle = "Unknown";
    const metaPath = path.join(videoDir, "meta.json");
    if (fs.existsSync(metaPath)) {
      try {
        const metaRaw = fs.readFileSync(metaPath, "utf-8");
        const meta = JSON.parse(metaRaw) as { title?: string; channelTitle?: string };
        if (meta.title && typeof meta.title === "string") title = meta.title;
        if (meta.channelTitle && typeof meta.channelTitle === "string") channelTitle = meta.channelTitle;
      } catch {
        // ignore meta parse errors
      }
    }

    const stat = fs.statSync(instPath);
    items.push({
      videoId,
      title,
      channelTitle,
      instrumentalUrl: `/cache/${videoId}/instrumental.wav`,
      vocalsUrl: `/cache/${videoId}/vocals.wav`,
      preparedAt: stat.mtime.toISOString(),
    });
  }

  items.sort((a, b) => (a.preparedAt < b.preparedAt ? 1 : -1));

  return res.json({ items: items.slice(0, limit) });
});

app.post("/api/rooms/join", (req, res) => {
  const { roomName, socketId } = req.body as { roomName: string; socketId: string };

  if (!roomName || !socketId) {
    return res.status(400).json({ error: "roomName and socketId required" });
  }

  const roomId = `room_${Math.random().toString(36).slice(2, 8)}`;
  rooms.set(roomId, { roomId, roomName, socketId });

  broadcastRooms();
  res.json({ roomId });
});

app.post("/api/match/start", (_req, res) => {
  const roomList = Array.from(rooms.values());
  if (roomList.length < 2) {
    return res.status(400).json({ error: "Need at least 2 rooms" });
  }

  const [roomA, roomB] = roomList.slice(0, 2);
  const song = pickRandomSong();

  const matchId = `match_${Date.now()}`;
  const startAt = Date.now() + 5000;

  currentMatch = {
    matchId,
    roomA,
    roomB,
    startAt,
    videoFile: song.file,
    title: song.title,
  };

  scoreState = {
    matchId,
    scores: {
      [roomA.roomId]: 0,
      [roomB.roomId]: 0,
    },
  };

  io.emit("MATCH_CREATED", {
    matchId,
    startAt,
    videoFile: currentMatch.videoFile,
    title: currentMatch.title,
    roomA: { roomId: roomA.roomId, roomName: roomA.roomName },
    roomB: { roomId: roomB.roomId, roomName: roomB.roomName },
  });

  broadcastScores();
  res.json(currentMatch);
});

/** ---------- Socket.IO ---------- */
io.on("connection", (socket) => {
  socket.emit("hello", { socketId: socket.id });

  socket.on("SCORE_PUSH", (payload: { matchId: string; roomId: string; score: number }) => {
    if (!scoreState) return;
    if (payload.matchId !== scoreState.matchId) return;
    if (!(payload.roomId in scoreState.scores)) return;

    const safeScore = Number.isFinite(payload.score) ? Math.max(0, Math.min(payload.score, 1000000)) : 0;
    scoreState.scores[payload.roomId] = safeScore;

    broadcastScores();
  });

  socket.on("disconnect", () => {
    for (const [roomId, room] of rooms.entries()) {
      if (room.socketId === socket.id) rooms.delete(roomId);
    }
    broadcastRooms();
  });
});

function broadcastRooms() {
  io.emit(
    "ROOMS_UPDATE",
    Array.from(rooms.values()).map((r) => ({ roomId: r.roomId, roomName: r.roomName }))
  );
}

function broadcastScores() {
  if (!currentMatch || !scoreState) return;

  const aId = currentMatch.roomA.roomId;
  const bId = currentMatch.roomB.roomId;

  io.emit("SCORE_UPDATE", {
    matchId: scoreState.matchId,
    roomA: { roomId: aId, roomName: currentMatch.roomA.roomName, score: scoreState.scores[aId] ?? 0 },
    roomB: { roomId: bId, roomName: currentMatch.roomB.roomName, score: scoreState.scores[bId] ?? 0 },
  });
}

httpServer.listen(PORT, HOST, () => {
  console.log(`server listening on http://${HOST}:${PORT}`);
});
