// src/server.ts

import express from "express";
import bodyParser from "body-parser";
import path from "node:path";

import { collectLyricsRaw } from "./lyrics/collectLyricsRaw";
import { writeLyricsRawBundle } from "./lyrics/lyricsCache";

const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT ? Number(process.env.PORT) : 3001;

// Cache root (can be overridden by env)
const CACHE_ROOT =
  process.env.SINGSYNC_CACHE_ROOT ||
  path.resolve(process.cwd(), "cache");

/**
 * POST /api/prepare
 * Body: { videoId: string }
 *
 * This is a MINIMAL skeleton:
 * - Creates cache dirs
 * - Writes empty lyrics raw bundle (STEP1-2 contract)
 * - Audio pipeline will be added later
 */
app.post("/api/prepare", async (req, res) => {
  try {
    const { videoId } = req.body ?? {};

    if (!videoId || typeof videoId !== "string") {
      return res.status(400).json({ error: "videoId is required" });
    }

    const bundle = await collectLyricsRaw(videoId, {
      preferYouTubeCaptions: true,
      maxWebCandidates: 3,
      sttMode: "onlyIfNoOther",
    });

    const paths = await writeLyricsRawBundle(CACHE_ROOT, bundle);

    return res.json({
      status: "ok",
      videoId,
      lyrics: {
        rawBundlePath: paths.rawBundlePath,
      },
    });
  } catch (err) {
    console.error("prepare failed:", err);
    return res.status(500).json({ error: "prepare failed" });
  }
});

app.listen(PORT, () => {
  console.log(`[SingSync] server listening on http://localhost:${PORT}`);
  console.log(`[SingSync] cache root: ${CACHE_ROOT}`);
});
