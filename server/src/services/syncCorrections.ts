import { loadSync, saveSync, type SyncCorrectionEvent, type SyncLineTiming } from "./syncStore.js";

export type ApplyCorrectionInput = {
  line_id: string;
  new_start_ms: number;
  source?: string;
};

export type ApplyCorrectionResult = {
  videoId: string;
  line_id: string;
  votes: number;
  median_offset_ms: number;
  applied: boolean;
  line_timing: SyncLineTiming;
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

export function applySyncCorrection(videoId: string, input: ApplyCorrectionInput): ApplyCorrectionResult {
  const sync = loadSync(videoId);
  const lineIdx = findLineIndex(sync.alignment.line_timings, input.line_id);

  if (lineIdx < 0) {
    throw new Error(`line_id not found in alignment: ${input.line_id}`);
  }

  const line = sync.alignment.line_timings[lineIdx];
  const targetStartMs = clampMs(input.new_start_ms);
  const offsetMs = targetStartMs - line.start_ms;

  const nextEvent: SyncCorrectionEvent = {
    line_id: input.line_id,
    new_start_ms: targetStartMs,
    offset_ms: offsetMs,
    created_at: new Date().toISOString(),
    source: input.source || "user",
  };
  sync.corrections.events.push(nextEvent);

  const lineEvents = sync.corrections.events.filter(
    (event) => event.line_id === input.line_id && Number.isFinite(event.offset_ms)
  );
  const offsets = lineEvents.map((event) => event.offset_ms as number);
  const votes = lineEvents.length;
  const medianOffset = median(offsets);

  sync.corrections.aggregates[input.line_id] = {
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
  return {
    videoId,
    line_id: input.line_id,
    votes,
    median_offset_ms: medianOffset,
    applied,
    line_timing: saved.alignment.line_timings[lineIdx],
  };
}
