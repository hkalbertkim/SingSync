import { Router } from "express";
import { searchYouTube, YouTubeVideo } from "../services/youtube.js";

const router = Router();

// GET /api/search?q={query}
router.get("/", async (req, res) => {
  const query = req.query.q as string;

  if (!query || query.trim().length === 0) {
    return res.status(400).json({ error: "Query parameter 'q' is required" });
  }

  try {
    const results = await searchYouTube(query.trim());
    res.json({
      query: query.trim(),
      results: results.map((video: YouTubeVideo) => ({
        videoId: video.videoId,
        title: video.title,
        thumbnail: video.thumbnail,
        duration: video.duration,
        channelTitle: video.channelTitle,
        publishedAt: video.publishedAt,
      })),
    });
  } catch (error) {
    console.error("Search error:", error);
    res.status(500).json({ error: "Failed to search YouTube" });
  }
});

export default router;