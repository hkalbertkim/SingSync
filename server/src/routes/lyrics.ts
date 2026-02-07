import { Router } from "express";
import { getLyrics } from "../services/lyrics.js";

const router = Router();

// GET /api/lyrics?videoId=XXXX
router.get("/", async (req, res) => {
  const videoId = String(req.query.videoId || "").trim();
  if (!videoId) {
    return res.status(400).json({ error: "videoId is required" });
  }

  try {
    const data = await getLyrics(videoId);
    return res.json(data);
  } catch (error) {
    console.error("[Lyrics] endpoint failed:", error);
    return res.json({
      videoId,
      source: "none",
      mode: "plain",
      lines: [],
      plainLyrics: "",
      syncMethod: "none",
      selectedCandidateId: "none",
      candidates: [
        {
          id: "none",
          label: "No lyrics",
          source: "none",
          mode: "plain",
          lines: [],
          plainLyrics: "",
          syncMethod: "none",
          score: 0,
        },
      ],
    });
  }
});

export default router;
