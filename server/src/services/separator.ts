import { exec } from "child_process";
import { promisify } from "util";
import path from "path";
import fs from "fs";

const execAsync = promisify(exec);

const SERVER_ROOT = process.cwd(); // when running from ~/singsync/server
const CACHE_DIR = path.join(SERVER_ROOT, "cache");

// Prefer explicitly configured tool paths, otherwise try common locations.
// 1) server/.venv/bin
// 2) repo-root/.venv/bin (one level up from server)
const DEMUCS_PATH =
  process.env.DEMUCS_PATH ||
  (fs.existsSync(path.join(SERVER_ROOT, ".venv", "bin", "demucs"))
    ? path.join(SERVER_ROOT, ".venv", "bin", "demucs")
    : path.join(SERVER_ROOT, "..", ".venv", "bin", "demucs"));

export interface SeparationResult {
  videoId: string;
  instrumentalPath: string;
  vocalsPath: string;
}

/**
 * Separate vocals from audio using Demucs (two stems: vocals)
 */
export async function separateVocals(videoId: string, audioPath: string): Promise<SeparationResult> {
  const videoDir = path.join(CACHE_DIR, videoId);
  const instrumentalPath = path.join(videoDir, "instrumental.wav");
  const vocalsPath = path.join(videoDir, "vocals.wav");

  // Check cache
  if (fs.existsSync(instrumentalPath) && fs.existsSync(vocalsPath)) {
    console.log(`[Cache Hit] ${videoId} already separated`);
    return { videoId, instrumentalPath, vocalsPath };
  }

  if (!fs.existsSync(videoDir)) {
    fs.mkdirSync(videoDir, { recursive: true });
  }

  // Validate demucs path early
  const demucsExists = fs.existsSync(DEMUCS_PATH);
  const demucsCmd = demucsExists ? `"${DEMUCS_PATH}"` : "demucs";

  if (!demucsExists) {
    console.warn(
      `[Separation] demucs not found at ${DEMUCS_PATH}. ` +
        `Trying global "demucs" from PATH. If it fails, install demucs or set DEMUCS_PATH in server/.env`
    );
  }

  console.log(`[Separation] Starting Demucs for: ${videoId}`);

  try {
    const outputDir = path.join(videoDir, "htdemucs");
    const command = `${demucsCmd} --two-stems=vocals -o "${videoDir}" "${audioPath}"`;

    console.log(`[Separation] Running: ${command}`);
    await execAsync(command, { timeout: 600000 }); // 10min

    // demucs creates: {outputDir}/source/vocals.wav and no_vocals.wav
    const demucsOutputDir = path.join(outputDir, "source");
    const demucsVocals = path.join(demucsOutputDir, "vocals.wav");
    const demucsNoVocals = path.join(demucsOutputDir, "no_vocals.wav");

    if (!fs.existsSync(demucsVocals) || !fs.existsSync(demucsNoVocals)) {
      throw new Error(
        `Demucs output missing. Expected: ${demucsVocals} and ${demucsNoVocals}. ` +
          `Check demucs logs above.`
      );
    }

    fs.renameSync(demucsVocals, vocalsPath);
    fs.renameSync(demucsNoVocals, instrumentalPath);

    // Cleanup
    if (fs.existsSync(outputDir)) fs.rmSync(outputDir, { recursive: true, force: true });

    console.log(`[Separation] Complete: ${videoId}`);
    return { videoId, instrumentalPath, vocalsPath };
  } catch (error) {
    console.error("[Separation] Failed:", error);
    throw new Error(`Failed to separate vocals: ${error}`);
  }
}

export function isSeparated(videoId: string): boolean {
  const videoDir = path.join(CACHE_DIR, videoId);
  return (
    fs.existsSync(path.join(videoDir, "instrumental.wav")) &&
    fs.existsSync(path.join(videoDir, "vocals.wav"))
  );
}
