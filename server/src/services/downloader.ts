import { exec } from "child_process";
import { promisify } from "util";
import path from "path";
import fs from "fs";

const execAsync = promisify(exec);

// We want all cache to live under the server folder consistently
const SERVER_ROOT = process.cwd(); // when running from ~/singsync/server
const CACHE_DIR = path.join(SERVER_ROOT, "cache");

// Prefer explicitly configured tool paths, otherwise try common locations.
// 1) server/.venv/bin
// 2) repo-root/.venv/bin (one level up from server)
const YT_DLP_PATH =
  process.env.YT_DLP_PATH ||
  (fs.existsSync(path.join(SERVER_ROOT, ".venv", "bin", "yt-dlp"))
    ? path.join(SERVER_ROOT, ".venv", "bin", "yt-dlp")
    : path.join(SERVER_ROOT, "..", ".venv", "bin", "yt-dlp"));

if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

export interface DownloadResult {
  videoId: string;
  audioPath: string;
  title: string;
  duration: string;
}

/**
 * Download audio from YouTube using yt-dlp
 */
export async function downloadAudio(videoId: string, title: string): Promise<DownloadResult> {
  const videoDir = path.join(CACHE_DIR, videoId);

  if (!fs.existsSync(videoDir)) {
    fs.mkdirSync(videoDir, { recursive: true });
  }

  const outputPath = path.join(videoDir, "source.m4a");

  // Check cache
  if (fs.existsSync(outputPath)) {
    console.log(`[Cache Hit] ${videoId} already downloaded`);
    return {
      videoId,
      audioPath: outputPath,
      title,
      duration: "0:00",
    };
  }

  // Validate yt-dlp path early
  if (!fs.existsSync(YT_DLP_PATH)) {
    throw new Error(
      `yt-dlp not found. Expected at: ${YT_DLP_PATH}. ` +
        `Fix by creating venv at server/.venv or set YT_DLP_PATH in server/.env`
    );
  }

  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
  console.log(`[Download] Starting: ${videoUrl}`);

  try {
    const command = `"${YT_DLP_PATH}" -f "bestaudio[ext=m4a]/bestaudio" --extract-audio --audio-format m4a --audio-quality 128K -o "${outputPath}" "${videoUrl}"`;
    await execAsync(command, { timeout: 120000 });
    console.log(`[Download] Complete: ${outputPath}`);

    return {
      videoId,
      audioPath: outputPath,
      title,
      duration: "0:00",
    };
  } catch (error) {
    console.error("[Download] Failed:", error);
    throw new Error(`Failed to download audio: ${error}`);
  }
}

export function isCached(videoId: string): boolean {
  const videoDir = path.join(CACHE_DIR, videoId);
  const instrumentalPath = path.join(videoDir, "instrumental.wav");
  const vocalPath = path.join(videoDir, "vocals.wav");
  return fs.existsSync(instrumentalPath) && fs.existsSync(vocalPath);
}

export function getCachedPaths(videoId: string): { instrumental: string; vocals: string } | null {
  const videoDir = path.join(CACHE_DIR, videoId);
  const instrumental = path.join(videoDir, "instrumental.wav");
  const vocals = path.join(videoDir, "vocals.wav");
  if (fs.existsSync(instrumental) && fs.existsSync(vocals)) return { instrumental, vocals };
  return null;
}
