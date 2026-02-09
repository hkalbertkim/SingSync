// src/lyrics/lyricsCache.ts

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { LyricsRawBundle } from "./collectLyricsRaw";

export type LyricsCachePaths = {
  baseDir: string;          // cache/<videoId>/lyrics
  rawDir: string;           // cache/<videoId>/lyrics/raw
  rawBundlePath: string;    // cache/<videoId>/lyrics/raw/bundle.json
};

/**
 * Contract (LOCKED):
 * - All lyrics artifacts live under: cache/<videoId>/lyrics/
 * - Raw collection output is stored at: cache/<videoId>/lyrics/raw/bundle.json
 *
 * This file only handles raw bundle persistence.
 * Later steps will add:
 * - candidates/, votes.json, selected.json, final.json
 */
export function getLyricsCachePaths(
  cacheRoot: string,
  videoId: string,
): LyricsCachePaths {
  const baseDir = path.join(cacheRoot, videoId, "lyrics");
  const rawDir = path.join(baseDir, "raw");
  const rawBundlePath = path.join(rawDir, "bundle.json");

  return { baseDir, rawDir, rawBundlePath };
}

export async function ensureLyricsRawDirs(
  cacheRoot: string,
  videoId: string,
): Promise<LyricsCachePaths> {
  const p = getLyricsCachePaths(cacheRoot, videoId);
  await fs.mkdir(p.rawDir, { recursive: true });
  return p;
}

export async function writeLyricsRawBundle(
  cacheRoot: string,
  bundle: LyricsRawBundle,
): Promise<LyricsCachePaths> {
  const p = await ensureLyricsRawDirs(cacheRoot, bundle.videoId);
  const json = JSON.stringify(bundle, null, 2);
  await fs.writeFile(p.rawBundlePath, json, "utf-8");
  return p;
}

export async function readLyricsRawBundle(
  cacheRoot: string,
  videoId: string,
): Promise<LyricsRawBundle | null> {
  const p = getLyricsCachePaths(cacheRoot, videoId);

  try {
    const raw = await fs.readFile(p.rawBundlePath, "utf-8");
    const parsed = JSON.parse(raw) as LyricsRawBundle;

    // Minimal validation to protect downstream assumptions
    if (!parsed || parsed.videoId !== videoId || !Array.isArray(parsed.webLyrics)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
