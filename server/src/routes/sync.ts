import { Router, type Request } from "express";

import { applySyncCorrection } from "../services/syncCorrections.js";

const router = Router();

type CorrectionBody = {
  line_id?: unknown;
  new_start_ms?: unknown;
  source?: unknown;
};

type Bucket = {
  hits: number[];
};

const rateBuckets = new Map<string, Bucket>();
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 20;

function clientIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  if (Array.isArray(forwarded) && forwarded.length > 0) {
    return forwarded[0].trim();
  }
  return req.ip || "unknown";
}

function allowRequest(key: string): boolean {
  const now = Date.now();
  const bucket = rateBuckets.get(key) || { hits: [] };
  bucket.hits = bucket.hits.filter((ts) => now - ts <= RATE_WINDOW_MS);

  if (bucket.hits.length >= RATE_LIMIT) {
    rateBuckets.set(key, bucket);
    return false;
  }

  bucket.hits.push(now);
  rateBuckets.set(key, bucket);
  return true;
}

router.post("/:videoId/correct", (req, res) => {
  const videoId = String(req.params.videoId || "").trim();
  if (!videoId) {
    return res.status(400).json({ error: "videoId is required" });
  }

  const ip = clientIp(req);
  const rateKey = `${ip}:${videoId}`;
  if (!allowRequest(rateKey)) {
    return res.status(429).json({ error: "Too many correction requests. Please retry shortly." });
  }

  const body = (req.body || {}) as CorrectionBody;
  const lineId = typeof body.line_id === "string" ? body.line_id.trim() : "";
  const newStartMs = Number(body.new_start_ms);
  const source = typeof body.source === "string" && body.source.trim() ? body.source.trim() : "user";

  if (!lineId) {
    return res.status(400).json({ error: "line_id is required" });
  }
  if (!Number.isFinite(newStartMs) || newStartMs < 0) {
    return res.status(400).json({ error: "new_start_ms must be a non-negative number" });
  }

  try {
    const result = applySyncCorrection(videoId, {
      line_id: lineId,
      new_start_ms: newStartMs,
      source,
    });
    return res.json({
      ok: true,
      ...result,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Failed to apply correction";
    if (msg.includes("line_id not found")) {
      return res.status(404).json({ error: msg });
    }
    return res.status(500).json({ error: msg });
  }
});

export default router;
