import { Router } from "express";
import * as path from "node:path";
import * as fs from "node:fs";

import { downloadAudio } from "../services/downloader.js";
import { separateVocals } from "../services/separator.js";

const router = Router();

// In-memory job store (replace with Redis in production)
const jobs = new Map<
  string,
  {
    jobId: string;
    videoId: string;
    title: string;
    channelTitle: string;
    status: "pending" | "downloading" | "separating" | "complete" | "error";
    progress: number;
    stage: string;
    error?: string;
    result?: {
      instrumentalPath: string;
      vocalsPath: string;
    };
  }
>();

function writeMeta(videoId: string, meta: { title: string; channelTitle: string }) {
  const cacheDir = path.join(process.cwd(), "cache", videoId);
  if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });

  const metaPath = path.join(cacheDir, "meta.json");
  const payload = {
    videoId,
    title: meta.title,
    channelTitle: meta.channelTitle,
    preparedAt: new Date().toISOString(),
  };

  fs.writeFileSync(metaPath, JSON.stringify(payload, null, 2), "utf-8");
}

// POST /api/prepare - Start processing a YouTube video
router.post("/", async (req, res) => {
  const { videoId, title, channelTitle } = req.body as {
    videoId: string;
    title?: string;
    channelTitle?: string;
  };

  if (!videoId) {
    return res.status(400).json({ error: "videoId is required" });
  }

  const safeTitle = (title || "Unknown").toString();
  const safeChannelTitle = (channelTitle || "Unknown").toString();

  const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  // Create job
  jobs.set(jobId, {
    jobId,
    videoId,
    title: safeTitle,
    channelTitle: safeChannelTitle,
    status: "pending",
    progress: 0,
    stage: "initializing",
  });

  // Start processing in background
  processVideo(jobId, videoId, safeTitle, safeChannelTitle);

  res.json({
    jobId,
    status: "pending",
    message: "Processing started",
  });
});

// GET /api/prepare/:jobId/status - Check processing status
router.get("/:jobId/status", (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);

  if (!job) {
    return res.status(404).json({ error: "Job not found" });
  }

  res.json({
    jobId: job.jobId,
    status: job.status,
    progress: job.progress,
    stage: job.stage,
    error: job.error,
    result:
      job.status === "complete"
        ? {
            instrumentalUrl: `/cache/${job.videoId}/instrumental.wav`,
            vocalsUrl: `/cache/${job.videoId}/vocals.wav`,
          }
        : undefined,
  });
});

// Background processing function
async function processVideo(jobId: string, videoId: string, title: string, channelTitle: string) {
  const job = jobs.get(jobId);
  if (!job) return;

  try {
    // Step 1: Download
    job.status = "downloading";
    job.progress = 10;
    job.stage = "Downloading audio from YouTube";
    jobs.set(jobId, { ...job });

    const downloadResult = await downloadAudio(videoId, title);

    // Step 2: Separate vocals
    job.status = "separating";
    job.progress = 50;
    job.stage = "Separating vocals (this may take a few minutes)";
    jobs.set(jobId, { ...job });

    const separationResult = await separateVocals(videoId, downloadResult.audioPath);

    // Save meta for activity list
    try {
      writeMeta(videoId, { title, channelTitle });
    } catch (e) {
      console.warn("[Meta] Failed to write meta.json:", e);
    }

    // Complete
    job.status = "complete";
    job.progress = 100;
    job.stage = "Ready to sing!";
    job.result = {
      instrumentalPath: separationResult.instrumentalPath,
      vocalsPath: separationResult.vocalsPath,
    };
    jobs.set(jobId, { ...job });

    console.log(`[Job ${jobId}] Complete!`);
  } catch (error) {
    console.error(`[Job ${jobId}] Failed:`, error);
    job.status = "error";
    job.progress = 0;
    job.stage = "Failed";
    job.error = error instanceof Error ? error.message : "Unknown error";
    jobs.set(jobId, { ...job });
  }
}

export default router;
