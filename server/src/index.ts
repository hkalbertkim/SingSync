import express from "express";
import http from "http";
import cors from "cors";
import { Server } from "socket.io";

const PORT = Number(process.env.PORT || 4000);

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
  videoFile: string; // ✅ local file under /public/karaoke/
  title: string; // ✅ display name
};

type ScoreState = {
  matchId: string;
  scores: Record<string, number>; // roomId -> score
};

const rooms = new Map<string, Room>();
let currentMatch: Match | null = null;
let scoreState: ScoreState | null = null;

// ✅ Local karaoke playlist (must match filenames under web/public/karaoke/)
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

// ✅ SingSync MVP: list songs for search/browse
app.get("/api/songs", (_req, res) => {
  res.json(
    PLAYLIST.map((s) => ({
      id: s.file,
      title: s.title,
      videoFile: s.file,
    }))
  );
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

  // MVP: first two rooms
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

httpServer.listen(PORT, () => {
  console.log(`server listening on http://localhost:${PORT}`);
});
