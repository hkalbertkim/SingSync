import fs from "node:fs";
import path from "node:path";

export type SyncMarkerPoint = {
  ms: number;
  strength: number;
};

export type SyncLineTiming = {
  line_id: string;
  start_ms: number;
  end_ms: number;
  confidence: number;
  derived_from: "markers" | "uniform";
};

export type SyncCorrectionEvent = {
  line_id: string;
  new_start_ms: number;
  created_at: string;
  source?: string;
};

export type SyncCorrectionAggregate = {
  median_offset_ms: number;
  votes: number;
};

export type SyncMetadataV1 = {
  schema_version: "1";
  video_id: string;
  created_at: string;
  updated_at: string;
  markers: {
    vocal_onsets: SyncMarkerPoint[];
    phrase_gaps: SyncMarkerPoint[];
    source?: string;
    extracted_at?: string;
  };
  alignment: {
    mode: "rough" | "none";
    line_timings: SyncLineTiming[];
  };
  corrections: {
    events: SyncCorrectionEvent[];
    aggregates: Record<string, SyncCorrectionAggregate>;
  };
};

function cacheRoot(): string {
  return path.join(process.cwd(), "cache");
}

function videoCacheDir(videoId: string): string {
  return path.join(cacheRoot(), videoId);
}

function nowIso(): string {
  return new Date().toISOString();
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function normalizePoint(raw: unknown): SyncMarkerPoint | null {
  if (!raw || typeof raw !== "object") return null;
  const point = raw as { ms?: unknown; strength?: unknown };
  if (!isFiniteNumber(point.ms) || point.ms < 0) return null;
  if (!isFiniteNumber(point.strength)) return null;
  const strength = Math.max(0, Math.min(1, point.strength));
  return { ms: Math.round(point.ms), strength };
}

function emptySync(videoId: string): SyncMetadataV1 {
  const now = nowIso();
  return {
    schema_version: "1",
    video_id: videoId,
    created_at: now,
    updated_at: now,
    markers: {
      vocal_onsets: [],
      phrase_gaps: [],
    },
    alignment: {
      mode: "none",
      line_timings: [],
    },
    corrections: {
      events: [],
      aggregates: {},
    },
  };
}

function normalizeSync(raw: unknown, videoId: string): SyncMetadataV1 {
  const fallback = emptySync(videoId);
  if (!raw || typeof raw !== "object") return fallback;

  const obj = raw as Record<string, unknown>;
  const createdAt = typeof obj.created_at === "string" ? obj.created_at : fallback.created_at;
  const updatedAt = typeof obj.updated_at === "string" ? obj.updated_at : fallback.updated_at;

  const rawMarkers = (obj.markers as Record<string, unknown> | undefined) || {};
  const vocalOnsets = Array.isArray(rawMarkers.vocal_onsets)
    ? rawMarkers.vocal_onsets.map(normalizePoint).filter((p): p is SyncMarkerPoint => p !== null)
    : [];
  const phraseGaps = Array.isArray(rawMarkers.phrase_gaps)
    ? rawMarkers.phrase_gaps.map(normalizePoint).filter((p): p is SyncMarkerPoint => p !== null)
    : [];

  const markers: SyncMetadataV1["markers"] = {
    vocal_onsets: vocalOnsets,
    phrase_gaps: phraseGaps,
  };
  if (typeof rawMarkers.source === "string") markers.source = rawMarkers.source;
  if (typeof rawMarkers.extracted_at === "string") markers.extracted_at = rawMarkers.extracted_at;

  const rawAlignment = (obj.alignment as Record<string, unknown> | undefined) || {};
  const alignmentMode =
    rawAlignment.mode === "rough" || rawAlignment.mode === "none" ? rawAlignment.mode : "none";
  const lineTimings: SyncLineTiming[] = Array.isArray(rawAlignment.line_timings)
    ? rawAlignment.line_timings
        .map((item) => {
          if (!item || typeof item !== "object") return null;
          const line = item as Record<string, unknown>;
          if (typeof line.line_id !== "string") return null;
          if (!isFiniteNumber(line.start_ms) || line.start_ms < 0) return null;
          if (!isFiniteNumber(line.end_ms) || line.end_ms < 0) return null;
          if (!isFiniteNumber(line.confidence)) return null;
          const derived_from =
            line.derived_from === "markers" || line.derived_from === "uniform"
              ? line.derived_from
              : "uniform";
          return {
            line_id: line.line_id,
            start_ms: Math.round(line.start_ms),
            end_ms: Math.round(line.end_ms),
            confidence: Math.max(0, Math.min(1, line.confidence)),
            derived_from,
          };
        })
        .filter((x): x is SyncLineTiming => x !== null)
    : [];

  const rawCorrections = (obj.corrections as Record<string, unknown> | undefined) || {};
  const correctionEvents: SyncCorrectionEvent[] = Array.isArray(rawCorrections.events)
    ? rawCorrections.events
        .map((item) => {
          if (!item || typeof item !== "object") return null;
          const event = item as Record<string, unknown>;
          if (typeof event.line_id !== "string") return null;
          if (!isFiniteNumber(event.new_start_ms) || event.new_start_ms < 0) return null;
          if (typeof event.created_at !== "string") return null;
          const normalized: SyncCorrectionEvent = {
            line_id: event.line_id,
            new_start_ms: Math.round(event.new_start_ms),
            created_at: event.created_at,
          };
          if (typeof event.source === "string") normalized.source = event.source;
          return normalized;
        })
        .filter((x): x is SyncCorrectionEvent => x !== null)
    : [];

  const rawAggregates = (rawCorrections.aggregates as Record<string, unknown> | undefined) || {};
  const correctionAggregates: Record<string, SyncCorrectionAggregate> = {};
  for (const [key, value] of Object.entries(rawAggregates)) {
    if (!value || typeof value !== "object") continue;
    const agg = value as Record<string, unknown>;
    if (!isFiniteNumber(agg.median_offset_ms)) continue;
    if (!isFiniteNumber(agg.votes) || agg.votes < 0) continue;
    correctionAggregates[key] = {
      median_offset_ms: agg.median_offset_ms,
      votes: Math.round(agg.votes),
    };
  }

  return {
    schema_version: "1",
    video_id: typeof obj.video_id === "string" && obj.video_id ? obj.video_id : videoId,
    created_at: createdAt,
    updated_at: updatedAt,
    markers,
    alignment: {
      mode: alignmentMode,
      line_timings: lineTimings,
    },
    corrections: {
      events: correctionEvents,
      aggregates: correctionAggregates,
    },
  };
}

export function syncPath(videoId: string): string {
  return path.join(videoCacheDir(videoId), "sync.json");
}

export function ensureVideoCacheDir(videoId: string): void {
  const dir = videoCacheDir(videoId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export function loadSync(videoId: string): SyncMetadataV1 {
  const filePath = syncPath(videoId);
  if (!fs.existsSync(filePath)) {
    const initial = emptySync(videoId);
    saveSync(videoId, initial);
    return initial;
  }

  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown;
    return normalizeSync(raw, videoId);
  } catch {
    const reset = emptySync(videoId);
    saveSync(videoId, reset);
    return reset;
  }
}

export function saveSync(videoId: string, sync: SyncMetadataV1): SyncMetadataV1 {
  ensureVideoCacheDir(videoId);
  const next: SyncMetadataV1 = {
    ...sync,
    schema_version: "1",
    video_id: videoId,
    updated_at: nowIso(),
  };

  const filePath = syncPath(videoId);
  fs.writeFileSync(filePath, JSON.stringify(next, null, 2), "utf-8");
  return next;
}

export function ensureSync(videoId: string): SyncMetadataV1 {
  return loadSync(videoId);
}

export function writeMarkers(
  videoId: string,
  payload: {
    vocal_onsets: SyncMarkerPoint[];
    phrase_gaps: SyncMarkerPoint[];
    source?: string;
    extracted_at?: string;
  }
): SyncMetadataV1 {
  const current = loadSync(videoId);
  current.markers = {
    vocal_onsets: payload.vocal_onsets,
    phrase_gaps: payload.phrase_gaps,
    source: payload.source ?? current.markers.source,
    extracted_at: payload.extracted_at ?? nowIso(),
  };
  return saveSync(videoId, current);
}

export function writeAlignment(
  videoId: string,
  payload: {
    mode: "rough" | "none";
    line_timings: SyncLineTiming[];
  }
): SyncMetadataV1 {
  const current = loadSync(videoId);
  current.alignment = {
    mode: payload.mode,
    line_timings: payload.line_timings.map((line) => ({
      line_id: line.line_id,
      start_ms: Math.max(0, Math.round(line.start_ms)),
      end_ms: Math.max(0, Math.round(line.end_ms)),
      confidence: Math.max(0, Math.min(1, line.confidence)),
      derived_from: line.derived_from === "markers" ? "markers" : "uniform",
    })),
  };
  return saveSync(videoId, current);
}
