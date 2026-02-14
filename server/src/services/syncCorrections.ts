import { loadSync, saveSync, type SyncCorrectionEvent, type SyncLineTiming } from "./syncStore.js";

export class SyncCorrectionError extends Error {
  code: "line_id_not_found";

  constructor(code: "line_id_not_found", message: string) {
    super(message);
    this.code = code;
  }
}

export type ApplyCorrectionResult = {
  ok: true;
  videoId: string;
  line_id: string;
  votes: number;
  median_offset_ms: number;
  applied: boolean;
  updated_start_ms: number;
  updated_end_ms: number;
};

const MIN_VOTES = 2;

function clampMs(ms: number): number {
  return Math.max(0, Math.round(ms));
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function findLineIndex(lineTimings: SyncLineTiming[], lineId: string): number {
  return lineTimings.findIndex((line) => line.line_id === lineId);
}

export function applyCorrection(
  videoId: string,
  lineId: string,
  newStartMs: number,
  source = "ui",
  _ip = ""
): ApplyCorrectionResult {
  const sync = loadSync(videoId);
  const lineIdx = findLineIndex(sync.alignment.line_timings, lineId);

  if (lineIdx < 0) {
    throw new SyncCorrectionError("line_id_not_found", `line_id not found in alignment: ${lineId}`);
  }

  const line = sync.alignment.line_timings[lineIdx];
  const targetStartMs = clampMs(newStartMs);
  const offsetMs = targetStartMs - line.start_ms;

  const nextEvent: SyncCorrectionEvent = {
    line_id: lineId,
    new_start_ms: targetStartMs,
    offset_ms: offsetMs,
    created_at: new Date().toISOString(),
    source,
  };
  sync.corrections.events.push(nextEvent);

  const lineEvents = sync.corrections.events.filter(
    (event) => event.line_id === lineId && Number.isFinite(event.offset_ms)
  );
  const offsets = lineEvents.map((event) => event.offset_ms as number);
  const votes = lineEvents.length;
  const medianOffset = median(offsets);

  sync.corrections.aggregates[lineId] = {
    median_offset_ms: medianOffset,
    votes,
  };

  let applied = false;
  if (votes >= MIN_VOTES) {
    const updatedStart = clampMs(line.start_ms + medianOffset);
    const minEnd = updatedStart + 200;

    sync.alignment.line_timings[lineIdx] = {
      ...line,
      start_ms: updatedStart,
      end_ms: Math.max(line.end_ms, minEnd),
    };

    applied = true;
  }

  const saved = saveSync(videoId, sync);
  const updated = saved.alignment.line_timings[lineIdx];
  return {
    ok: true,
    videoId,
    line_id: lineId,
    votes,
    median_offset_ms: medianOffset,
    applied,
    updated_start_ms: updated.start_ms,
    updated_end_ms: updated.end_ms,
  };
}
