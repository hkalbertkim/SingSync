import { Router, type Request } from "express";

import { applyCorrection, SyncCorrectionError } from "../services/syncCorrections.js";

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
const RATE_WINDOW_MS = 5 * 60_000;
const RATE_LIMIT = 30;

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
    return res.status(400).json({ ok: false, error: "video_id_required" });
  }

  const ip = clientIp(req);
  const rateKey = `${ip}:${videoId}`;
  if (!allowRequest(rateKey)) {
    return res.status(429).json({ ok: false, error: "rate_limited" });
  }

  const body = (req.body || {}) as CorrectionBody;
  const lineId = typeof body.line_id === "string" ? body.line_id.trim() : "";
  const newStartMs = Number(body.new_start_ms);
  const source = typeof body.source === "string" && body.source.trim() ? body.source.trim() : "ui";

  if (!lineId) {
    return res.status(400).json({ ok: false, error: "line_id_required" });
  }
  if (!Number.isFinite(newStartMs) || newStartMs < 0) {
    return res.status(400).json({ ok: false, error: "new_start_ms_invalid" });
  }

  try {
    const result = applyCorrection(videoId, lineId, newStartMs, source, ip);
    return res.json(result);
  } catch (error) {
    if (error instanceof SyncCorrectionError && error.code === "line_id_not_found") {
      return res.status(404).json({ ok: false, error: "line_id_not_found" });
    }
    return res.status(500).json({ ok: false, error: "internal_error" });
  }
});

export default router;
