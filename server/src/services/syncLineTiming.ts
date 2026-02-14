import fs from "node:fs";
import path from "node:path";

import { loadSync, writeAlignment, type SyncLineTiming, type SyncMarkerPoint } from "./syncStore.js";

type Segment = {
  startMs: number;
  endMs: number;
  onsets: SyncMarkerPoint[];
};

type TimingResult = {
  lineTimings: SyncLineTiming[];
  mode: "rough" | "none";
  usedLyricsCount: number;
  segmentCount: number;
};

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function roundMs(n: number): number {
  return Math.max(0, Math.round(n));
}

function normalizeLyricLines(lines: string[]): string[] {
  return lines.map((line) => line.trim()).filter((line) => line.length > 0);
}

function splitPlainLyrics(input: string): string[] {
  return input
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^\[[^\]]+\]$/.test(line));
}

export function readCachedLyricLines(videoId: string): string[] {
  const cachePath = path.join(process.cwd(), "cache", videoId, "lyrics.json");
  if (!fs.existsSync(cachePath)) return [];

  try {
    const raw = JSON.parse(fs.readFileSync(cachePath, "utf-8")) as {
      lines?: Array<{ text?: string }>;
      plainLyrics?: string;
      candidates?: Array<{ lines?: Array<{ text?: string }>; plainLyrics?: string }>;
    };

    if (Array.isArray(raw.lines)) {
      const timed = normalizeLyricLines(raw.lines.map((line) => (line?.text || "").toString()));
      if (timed.length > 0) return timed;
    }

    if (typeof raw.plainLyrics === "string") {
      const plain = splitPlainLyrics(raw.plainLyrics);
      if (plain.length > 0) return plain;
    }

    if (Array.isArray(raw.candidates)) {
      for (const candidate of raw.candidates) {
        if (Array.isArray(candidate?.lines)) {
          const lines = normalizeLyricLines(candidate.lines.map((line) => (line?.text || "").toString()));
          if (lines.length > 0) return lines;
        }
        if (typeof candidate?.plainLyrics === "string") {
          const plain = splitPlainLyrics(candidate.plainLyrics);
          if (plain.length > 0) return plain;
        }
      }
    }

    return [];
  } catch {
    return [];
  }
}

function boundariesFromPhraseGaps(
  startMs: number,
  endMs: number,
  phraseGaps: SyncMarkerPoint[]
): number[] {
  const filtered = phraseGaps
    .map((g) => g.ms)
    .filter((ms) => ms > startMs + 200 && ms < endMs - 200)
    .sort((a, b) => a - b);

  return [...new Set(filtered)];
}

function boundariesFromOnsetGaps(onsets: SyncMarkerPoint[], splitGapMs: number): number[] {
  const boundaries: number[] = [];
  for (let i = 1; i < onsets.length; i += 1) {
    const prev = onsets[i - 1].ms;
    const next = onsets[i].ms;
    const gap = next - prev;
    if (gap >= splitGapMs) {
      boundaries.push(Math.round(prev + gap / 2));
    }
  }
  return boundaries;
}

function buildSegments(onsets: SyncMarkerPoint[], phraseGaps: SyncMarkerPoint[]): Segment[] {
  if (onsets.length === 0) return [];

  const sortedOnsets = [...onsets].sort((a, b) => a.ms - b.ms);
  const startMs = Math.max(0, sortedOnsets[0].ms - 200);
  const endMs = sortedOnsets[sortedOnsets.length - 1].ms + 600;

  const boundaries =
    phraseGaps.length > 0
      ? boundariesFromPhraseGaps(startMs, endMs, phraseGaps)
      : boundariesFromOnsetGaps(sortedOnsets, 450);

  const edges = [startMs, ...boundaries, endMs];
  const segments: Segment[] = [];

  for (let i = 0; i < edges.length - 1; i += 1) {
    const segStart = roundMs(edges[i]);
    const segEnd = Math.max(segStart + 200, roundMs(edges[i + 1]));
    const segOnsets = sortedOnsets.filter((o) => o.ms >= segStart && o.ms < segEnd);

    if (segOnsets.length === 0 && i > 0 && i < edges.length - 2) {
      continue;
    }

    segments.push({
      startMs: segStart,
      endMs: segEnd,
      onsets: segOnsets,
    });
  }

  return segments;
}

function spreadLineAssignments(lineCount: number, segmentCount: number): number[] {
  if (lineCount <= 0 || segmentCount <= 0) return [];
  if (lineCount === 1) return [0];

  const indexes: number[] = [];
  for (let i = 0; i < lineCount; i += 1) {
    indexes.push(Math.round((i * (segmentCount - 1)) / (lineCount - 1)));
  }
  return indexes;
}

function proportionalAllocation(lineCount: number, segments: Segment[]): number[] {
  const m = segments.length;
  const alloc = new Array(m).fill(1);
  if (lineCount <= m) return alloc;

  const durations = segments.map((s) => Math.max(1, s.endMs - s.startMs));
  const durationSum = durations.reduce((a, b) => a + b, 0);
  const remain = lineCount - m;
  const targets = durations.map((d) => (d / durationSum) * remain);

  let used = 0;
  for (let i = 0; i < targets.length; i += 1) {
    const extra = Math.floor(targets[i]);
    alloc[i] += extra;
    used += extra;
  }

  let left = remain - used;
  const order = targets
    .map((value, i) => ({ i, frac: value - Math.floor(value) }))
    .sort((a, b) => b.frac - a.frac);

  let cursor = 0;
  while (left > 0 && order.length > 0) {
    alloc[order[cursor % order.length].i] += 1;
    cursor += 1;
    left -= 1;
  }

  return alloc;
}

function segmentConfidence(segment: Segment, linesInSegment: number): number {
  if (segment.onsets.length === 0) return 0.15;

  const density = Math.min(1, segment.onsets.length / Math.max(1, linesInSegment));
  const avgStrength =
    segment.onsets.reduce((sum, onset) => sum + clamp01(onset.strength), 0) / segment.onsets.length;

  return clamp01(0.1 + 0.55 * density + 0.35 * avgStrength);
}

function createUniformLineTimings(lines: string[], durationMs: number): SyncLineTiming[] {
  const safeDuration = Math.max(200 * lines.length, durationMs);
  const step = safeDuration / lines.length;

  return lines.map((_line, idx) => {
    const startMs = roundMs(step * idx);
    const endMs = Math.max(startMs + 200, roundMs(step * (idx + 1)));

    return {
      line_id: `line_${idx + 1}`,
      start_ms: startMs,
      baseline_start_ms: startMs,
      end_ms: endMs,
      confidence: 0.15,
      derived_from: "uniform",
    };
  });
}

export function generateRoughLineTimings(
  markers: { vocal_onsets: SyncMarkerPoint[]; phrase_gaps: SyncMarkerPoint[] },
  lyricLinesInput: string[],
  opts: { trackDurationMs?: number } = {}
): TimingResult {
  const lyricLines = normalizeLyricLines(lyricLinesInput);
  if (lyricLines.length === 0) {
    return { lineTimings: [], mode: "none", usedLyricsCount: 0, segmentCount: 0 };
  }

  const segments = buildSegments(markers.vocal_onsets, markers.phrase_gaps);

  if (segments.length === 0) {
    if (opts.trackDurationMs && opts.trackDurationMs > 0) {
      return {
        lineTimings: createUniformLineTimings(lyricLines, opts.trackDurationMs),
        mode: "rough",
        usedLyricsCount: lyricLines.length,
        segmentCount: 0,
      };
    }

    return { lineTimings: [], mode: "none", usedLyricsCount: lyricLines.length, segmentCount: 0 };
  }

  const timings: SyncLineTiming[] = [];

  if (segments.length >= lyricLines.length) {
    const segIdxByLine = spreadLineAssignments(lyricLines.length, segments.length);

    for (let i = 0; i < lyricLines.length; i += 1) {
      const seg = segments[segIdxByLine[i]];
      timings.push({
        line_id: `line_${i + 1}`,
        start_ms: seg.startMs,
        baseline_start_ms: seg.startMs,
        end_ms: Math.max(seg.startMs + 200, seg.endMs),
        confidence: segmentConfidence(seg, 1),
        derived_from: "markers",
      });
    }

    return {
      lineTimings: timings,
      mode: "rough",
      usedLyricsCount: lyricLines.length,
      segmentCount: segments.length,
    };
  }

  const allocation = proportionalAllocation(lyricLines.length, segments);

  let lineCursor = 0;
  for (let segIdx = 0; segIdx < segments.length; segIdx += 1) {
    const seg = segments[segIdx];
    const count = allocation[segIdx];
    const span = Math.max(200, seg.endMs - seg.startMs);
    const chunk = span / count;
    const conf = segmentConfidence(seg, count);

    for (let local = 0; local < count && lineCursor < lyricLines.length; local += 1) {
      const rawStart = seg.startMs + chunk * local;
      const rawEnd = seg.startMs + chunk * (local + 1);
      const startMs = roundMs(rawStart);
      const endMs = Math.max(startMs + 200, roundMs(rawEnd));

      timings.push({
        line_id: `line_${lineCursor + 1}`,
        start_ms: startMs,
        baseline_start_ms: startMs,
        end_ms: endMs,
        confidence: conf,
        derived_from: "markers",
      });

      lineCursor += 1;
    }
  }

  while (lineCursor < lyricLines.length) {
    const lastEnd = timings.length > 0 ? timings[timings.length - 1].end_ms : 0;
    timings.push({
      line_id: `line_${lineCursor + 1}`,
      start_ms: lastEnd,
      baseline_start_ms: lastEnd,
      end_ms: lastEnd + 500,
      confidence: 0.1,
      derived_from: "uniform",
    });
    lineCursor += 1;
  }

  return {
    lineTimings: timings,
    mode: "rough",
    usedLyricsCount: lyricLines.length,
    segmentCount: segments.length,
  };
}

export function generateAndPersistRoughLineTimings(
  videoId: string,
  options: { force?: boolean; lyricLines?: string[]; trackDurationMs?: number } = {}
): TimingResult {
  const sync = loadSync(videoId);

  if (!options.force && sync.alignment.mode === "rough" && sync.alignment.line_timings.length > 0) {
    return {
      lineTimings: sync.alignment.line_timings,
      mode: sync.alignment.mode,
      usedLyricsCount: sync.alignment.line_timings.length,
      segmentCount: 0,
    };
  }

  const lyricLines = options.lyricLines ?? readCachedLyricLines(videoId);
  const result = generateRoughLineTimings(sync.markers, lyricLines, {
    trackDurationMs: options.trackDurationMs,
  });

  writeAlignment(videoId, {
    mode: result.mode,
    line_timings: result.lineTimings,
  });

  return result;
}
