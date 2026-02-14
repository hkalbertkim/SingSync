import fs from "node:fs";
import path from "node:path";

import { loadSync, writeMarkers, type SyncMarkerPoint } from "./syncStore.js";

type WavData = {
  sampleRate: number;
  channelCount: number;
  samples: Float32Array;
};

type MarkerResult = {
  vocal_onsets: SyncMarkerPoint[];
  phrase_gaps: SyncMarkerPoint[];
};

type MarkerOptions = {
  hopMs?: number;
  frameMs?: number;
  smoothFrames?: number;
  minOnsetDistanceMs?: number;
  phraseGapMinMs?: number;
};

function readAscii(buf: Buffer, start: number, len: number): string {
  return buf.toString("ascii", start, start + len);
}

function findChunk(buffer: Buffer, chunkId: string): { offset: number; size: number } | null {
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = readAscii(buffer, offset, 4);
    const size = buffer.readUInt32LE(offset + 4);
    const dataOffset = offset + 8;
    if (id === chunkId) {
      return { offset: dataOffset, size };
    }
    offset = dataOffset + size + (size % 2);
  }
  return null;
}

function decodeWavFile(filePath: string): WavData {
  const buffer = fs.readFileSync(filePath);
  if (readAscii(buffer, 0, 4) !== "RIFF" || readAscii(buffer, 8, 4) !== "WAVE") {
    throw new Error(`Unsupported WAV header: ${filePath}`);
  }

  const fmt = findChunk(buffer, "fmt ");
  const data = findChunk(buffer, "data");

  if (!fmt || !data) {
    throw new Error(`Invalid WAV (missing fmt/data chunk): ${filePath}`);
  }

  const format = buffer.readUInt16LE(fmt.offset);
  const channels = buffer.readUInt16LE(fmt.offset + 2);
  const sampleRate = buffer.readUInt32LE(fmt.offset + 4);
  const bitsPerSample = buffer.readUInt16LE(fmt.offset + 14);

  if (!channels || !sampleRate) {
    throw new Error(`Invalid WAV metadata: ${filePath}`);
  }

  const bytesPerSample = bitsPerSample / 8;
  const frameStride = bytesPerSample * channels;
  if (!frameStride || data.size < frameStride) {
    throw new Error(`Invalid WAV frame stride: ${filePath}`);
  }

  const frameCount = Math.floor(data.size / frameStride);
  const mono = new Float32Array(frameCount);

  for (let frame = 0; frame < frameCount; frame += 1) {
    const frameBase = data.offset + frame * frameStride;
    let mix = 0;

    for (let ch = 0; ch < channels; ch += 1) {
      const sampleBase = frameBase + ch * bytesPerSample;
      let value = 0;

      if (format === 3 && bitsPerSample === 32) {
        value = buffer.readFloatLE(sampleBase);
      } else if (format === 1 && bitsPerSample === 16) {
        value = buffer.readInt16LE(sampleBase) / 32768;
      } else if (format === 1 && bitsPerSample === 24) {
        const b0 = buffer[sampleBase];
        const b1 = buffer[sampleBase + 1];
        const b2 = buffer[sampleBase + 2];
        const int = (b2 << 16) | (b1 << 8) | b0;
        const signed = int & 0x800000 ? int | ~0xffffff : int;
        value = signed / 8388608;
      } else if (format === 1 && bitsPerSample === 32) {
        value = buffer.readInt32LE(sampleBase) / 2147483648;
      } else if (format === 1 && bitsPerSample === 8) {
        value = (buffer.readUInt8(sampleBase) - 128) / 128;
      } else {
        throw new Error(
          `Unsupported WAV encoding format=${format} bits=${bitsPerSample} channels=${channels}`
        );
      }

      mix += value;
    }

    mono[frame] = mix / channels;
  }

  return {
    sampleRate,
    channelCount: channels,
    samples: mono,
  };
}

function movingAverage(values: number[], width: number): number[] {
  if (width <= 1 || values.length === 0) return values.slice();

  const out: number[] = new Array(values.length).fill(0);
  let rolling = 0;

  for (let i = 0; i < values.length; i += 1) {
    rolling += values[i];
    if (i >= width) rolling -= values[i - width];
    const denom = i + 1 < width ? i + 1 : width;
    out[i] = rolling / denom;
  }

  return out;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(0, Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1))));
  return sorted[rank];
}

export function extractMarkersFromWav(filePath: string, options: MarkerOptions = {}): MarkerResult {
  const wav = decodeWavFile(filePath);

  const hopMs = options.hopMs ?? 10;
  const frameMs = options.frameMs ?? 30;
  const smoothFrames = options.smoothFrames ?? 5;
  const minOnsetDistanceMs = options.minOnsetDistanceMs ?? 90;
  const phraseGapMinMs = options.phraseGapMinMs ?? 450;

  const hopSize = Math.max(1, Math.round((wav.sampleRate * hopMs) / 1000));
  const frameSize = Math.max(hopSize, Math.round((wav.sampleRate * frameMs) / 1000));

  const energy: number[] = [];
  for (let start = 0; start + frameSize <= wav.samples.length; start += hopSize) {
    let sum = 0;
    for (let i = 0; i < frameSize; i += 1) {
      const sample = wav.samples[start + i];
      sum += sample * sample;
    }
    energy.push(Math.sqrt(sum / frameSize));
  }

  if (energy.length === 0) {
    return { vocal_onsets: [], phrase_gaps: [] };
  }

  const smooth = movingAverage(energy, smoothFrames);
  const diff: number[] = [0];
  for (let i = 1; i < smooth.length; i += 1) {
    diff.push(Math.max(0, smooth[i] - smooth[i - 1]));
  }

  const nonZero = diff.filter((v) => v > 0);
  const dynThreshold = Math.max(1e-6, percentile(nonZero, 0.7) * 1.1);
  const maxPeak = Math.max(...diff, 1e-6);

  const minFramesBetweenOnsets = Math.max(1, Math.round(minOnsetDistanceMs / hopMs));
  let lastPeakFrame = -minFramesBetweenOnsets;

  const onsets: SyncMarkerPoint[] = [];
  for (let i = 1; i < diff.length - 1; i += 1) {
    const value = diff[i];
    if (value < dynThreshold) continue;
    if (value < diff[i - 1] || value < diff[i + 1]) continue;
    if (i - lastPeakFrame < minFramesBetweenOnsets) continue;

    lastPeakFrame = i;
    onsets.push({
      ms: Math.round(i * hopMs),
      strength: Math.max(0, Math.min(1, value / maxPeak)),
    });
  }

  const phraseGaps: SyncMarkerPoint[] = [];
  for (let i = 1; i < onsets.length; i += 1) {
    const gapMs = onsets[i].ms - onsets[i - 1].ms;
    if (gapMs < phraseGapMinMs) continue;
    phraseGaps.push({
      ms: Math.round(onsets[i - 1].ms + gapMs / 2),
      strength: Math.max(0, Math.min(1, gapMs / 3000)),
    });
  }

  return {
    vocal_onsets: onsets,
    phrase_gaps: phraseGaps,
  };
}

export function persistMarkersFromVocals(videoId: string, vocalsPath: string): MarkerResult {
  if (!fs.existsSync(vocalsPath)) {
    throw new Error(`vocals stem not found: ${vocalsPath}`);
  }

  const markers = extractMarkersFromWav(vocalsPath);
  writeMarkers(videoId, {
    vocal_onsets: markers.vocal_onsets,
    phrase_gaps: markers.phrase_gaps,
    source: path.basename(vocalsPath),
    extracted_at: new Date().toISOString(),
  });

  return markers;
}

export function ensureMarkersForVideo(
  videoId: string,
  vocalsPath: string,
  options: { force?: boolean } = {}
): MarkerResult {
  const current = loadSync(videoId);
  const hasMarkers =
    current.markers.vocal_onsets.length > 0 || current.markers.phrase_gaps.length > 0;

  if (hasMarkers && !options.force) {
    return {
      vocal_onsets: current.markers.vocal_onsets,
      phrase_gaps: current.markers.phrase_gaps,
    };
  }

  return persistMarkersFromVocals(videoId, vocalsPath);
}
