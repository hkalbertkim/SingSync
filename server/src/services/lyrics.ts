import { exec } from "child_process";
import https from "https";
import { promisify } from "util";
import * as fs from "node:fs";
import * as path from "node:path";

const execAsync = promisify(exec);

const SERVER_ROOT = process.cwd();
const CACHE_DIR = path.join(SERVER_ROOT, "cache");
const LRCLIB_HOST = "lrclib.net";

const YT_DLP_PATH =
  process.env.YT_DLP_PATH ||
  (fs.existsSync(path.join(SERVER_ROOT, ".venv", "bin", "yt-dlp"))
    ? path.join(SERVER_ROOT, ".venv", "bin", "yt-dlp")
    : path.join(SERVER_ROOT, "..", ".venv", "bin", "yt-dlp"));

const WHISPER_PATH =
  process.env.WHISPER_PATH ||
  (fs.existsSync(path.join(SERVER_ROOT, ".venv", "bin", "whisper"))
    ? path.join(SERVER_ROOT, ".venv", "bin", "whisper")
    : path.join(SERVER_ROOT, "..", ".venv", "bin", "whisper"));

const WHISPER_MODEL = process.env.WHISPER_MODEL || "base";

export type LyricsLine = { t: number; text: string };
export type LyricsCandidate = {
  id: string;
  label: string;
  source: "captions" | "catalog" | "catalog_aligned" | "stt" | "none";
  mode: "timed" | "plain";
  lines: LyricsLine[];
  plainLyrics?: string;
  syncMethod?: "native" | "ai" | "none";
  score: number;
};
export type LyricsResponse = {
  videoId: string;
  source: "captions" | "catalog" | "catalog_aligned" | "stt" | "none";
  mode: "timed" | "plain";
  lines: LyricsLine[];
  plainLyrics?: string;
  syncMethod?: "native" | "ai" | "none";
  selectedCandidateId?: string;
  candidates?: LyricsCandidate[];
};

type WhisperJson = {
  segments?: Array<{ start?: number; text?: string }>;
};

type LRCLibTrack = {
  id?: number;
  trackName?: string;
  artistName?: string;
  albumName?: string;
  duration?: number;
  plainLyrics?: string;
  syncedLyrics?: string;
};

type WhisperSegment = { start: number; text: string };
type ScriptType = "latin" | "korean" | "japanese" | "cyrillic" | "mixed" | "unknown";
type CatalogCandidate = { track: LRCLibTrack; score: number; label: string };

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function cleanCaptionText(input: string): string {
  return decodeHtmlEntities(input)
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizePlainLyrics(input: string): string {
  return input
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function splitPlainLyrics(input: string): string[] {
  return normalizePlainLyrics(input)
    .split("\n")
    .map((line) => cleanCaptionText(line))
    .filter((line) => line.length > 0 && !/^\[[^\]]+\]$/.test(line));
}

function scriptCharCounts(input: string) {
  let latin = 0;
  let hangul = 0;
  let hiragana = 0;
  let katakana = 0;
  let han = 0;
  let cyrillic = 0;

  for (const ch of input) {
    if (/[A-Za-z]/.test(ch)) latin += 1;
    if (/[\uac00-\ud7af]/.test(ch)) hangul += 1;
    if (/[\u3040-\u309f]/.test(ch)) hiragana += 1;
    if (/[\u30a0-\u30ff]/.test(ch)) katakana += 1;
    if (/[\u3400-\u4dbf\u4e00-\u9fff]/.test(ch)) han += 1;
    if (/[\u0400-\u04ff]/.test(ch)) cyrillic += 1;
  }

  return { latin, hangul, hiragana, katakana, han, cyrillic };
}

function detectScript(text: string): ScriptType {
  const c = scriptCharCounts(text);
  const japanese = c.hiragana + c.katakana + c.han;
  const top = Math.max(c.latin, c.hangul, japanese, c.cyrillic);
  if (top <= 1) return "unknown";

  const kinds = [c.latin > 0, c.hangul > 0, japanese > 0, c.cyrillic > 0].filter(Boolean).length;
  if (kinds >= 3) return "mixed";

  if (top === c.hangul) return "korean";
  if (top === japanese) return "japanese";
  if (top === c.cyrillic) return "cyrillic";
  return "latin";
}

function detectExpectedScriptFromMeta(title: string, channelTitle: string): ScriptType {
  // Title is a stronger signal than channel name for song language.
  const titleScript = detectScript(title);
  if (titleScript !== "unknown" && titleScript !== "mixed") return titleScript;

  const combinedScript = detectScript(`${title} ${channelTitle}`);
  return combinedScript;
}

function isScriptCompatible(text: string, expected: ScriptType): boolean {
  if (expected === "unknown" || expected === "mixed") return true;

  const c = scriptCharCounts(text);
  const japanese = c.hiragana + c.katakana + c.han;
  const total = c.latin + c.hangul + japanese + c.cyrillic;
  if (total === 0) return false;

  // K-pop/J-pop often legitimately mix local script + English.
  if (expected === "korean") {
    if (c.cyrillic > 0) return false;
    return c.hangul >= 2 || c.latin >= 2;
  }
  if (expected === "japanese") {
    if (c.cyrillic > 0) return false;
    return japanese >= 2 || c.latin >= 2;
  }
  if (expected === "cyrillic") return c.cyrillic >= 2;

  // latin expected: reject if other scripts dominate.
  return c.latin >= 2 && (c.hangul + japanese + c.cyrillic) <= Math.max(2, Math.floor(c.latin * 0.6));
}

function hasCompatibleLyricsPayload(payload: LyricsResponse, expectedScript: ScriptType): boolean {
  const timedText = payload.lines.map((x) => x.text).join(" ");
  const plainText = payload.plainLyrics || "";
  const allText = `${timedText} ${plainText}`.trim();
  if (!allText) return true;
  return isScriptCompatible(allText, expectedScript);
}

function normalizedLyricsFingerprint(mode: "timed" | "plain", lines: LyricsLine[], plainLyrics: string): string {
  const timed = lines
    .map((l) => l.text)
    .join("\n")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const plain = plainLyrics
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return mode === "timed" ? timed.slice(0, 2400) : plain.slice(0, 2400);
}

function scoreLyricsCandidate(candidate: Omit<LyricsCandidate, "score">, expectedScript: ScriptType): number {
  let score = 0;
  const lineCount = candidate.lines.length;
  const plainLen = (candidate.plainLyrics || "").length;

  // Source priority: curated internet and captions first, STT last.
  if (candidate.source === "captions") score += 96;
  else if (candidate.source === "catalog") score += candidate.mode === "timed" ? 90 : 84;
  else if (candidate.source === "catalog_aligned") score += 82;
  else if (candidate.source === "stt") score += 48;
  else score += 0;

  if (candidate.syncMethod === "native") score += 7;
  if (candidate.syncMethod === "ai") score += 2;

  if (candidate.mode === "timed") score += Math.min(16, Math.floor(lineCount / 6));
  else score += Math.min(10, Math.floor(plainLen / 120));

  const allText = `${candidate.lines.map((x) => x.text).join(" ")} ${candidate.plainLyrics || ""}`.trim();
  if (allText && isScriptCompatible(allText, expectedScript)) score += 8;

  return score;
}

function pickTopCandidates(candidates: LyricsCandidate[], limit: number): LyricsCandidate[] {
  if (candidates.length <= 1) return candidates.slice(0, limit);

  const seen = new Set<string>();
  const out: LyricsCandidate[] = [];
  for (const c of candidates) {
    const fp = normalizedLyricsFingerprint(c.mode, c.lines, c.plainLyrics || "");
    if (!fp) continue;
    if (seen.has(fp)) continue;
    seen.add(fp);
    out.push(c);
    if (out.length >= limit) break;
  }
  return out;
}

function subtitleLanguageCode(fileName: string): string {
  const m = fileName.match(/captions\.([^.]+)(?:\.|$)/i);
  return (m?.[1] || "").toLowerCase();
}

function isSubtitleLangCompatible(fileName: string, expected: ScriptType): boolean {
  const lang = subtitleLanguageCode(fileName);
  if (!lang) return true;

  if (expected === "unknown" || expected === "mixed") return true;
  // For ko/ja songs, English subtitle tracks are also commonly valid.
  if (expected === "korean") return lang.startsWith("ko") || lang.startsWith("en");
  if (expected === "japanese") return lang.startsWith("ja") || lang.startsWith("en");
  if (expected === "cyrillic") return /^ru|uk|bg|sr|mk|be/.test(lang);
  if (expected === "latin") return /^(en|fr|es|de|it|pt|nl|sv|no|da|fi|ro|tr)/.test(lang);
  return true;
}

function parseVttTime(raw: string): number {
  const s = raw.trim().replace(",", ".");
  const parts = s.split(":");

  if (parts.length === 3) {
    const h = Number(parts[0]);
    const m = Number(parts[1]);
    const sec = Number(parts[2]);
    if (!Number.isFinite(h) || !Number.isFinite(m) || !Number.isFinite(sec)) return Number.NaN;
    return h * 3600 + m * 60 + sec;
  }

  if (parts.length === 2) {
    const m = Number(parts[0]);
    const sec = Number(parts[1]);
    if (!Number.isFinite(m) || !Number.isFinite(sec)) return Number.NaN;
    return m * 60 + sec;
  }

  return Number.NaN;
}

function parseLrcTimestamp(raw: string): number {
  const m = raw.match(/^(\d+):(\d+)(?:\.(\d+))?$/);
  if (!m) return Number.NaN;
  const mm = Number(m[1]);
  const ss = Number(m[2]);
  const ff = Number(m[3] || 0);
  if (!Number.isFinite(mm) || !Number.isFinite(ss) || !Number.isFinite(ff)) return Number.NaN;
  return mm * 60 + ss + ff / 100;
}

function parseLrc(content: string): LyricsLine[] {
  const out: LyricsLine[] = [];
  const lines = content.split(/\r?\n/);

  for (const line of lines) {
    const matches = [...line.matchAll(/\[([^\]]+)\]/g)];
    if (matches.length === 0) continue;

    const text = cleanCaptionText(line.replace(/\[[^\]]+\]/g, " "));
    if (!text) continue;

    for (const m of matches) {
      const ts = parseLrcTimestamp(m[1]);
      if (Number.isFinite(ts)) out.push({ t: ts, text });
    }
  }

  const deduped: LyricsLine[] = [];
  for (const item of out.sort((a, b) => a.t - b.t)) {
    const prev = deduped[deduped.length - 1];
    if (!prev || prev.text !== item.text || Math.abs(prev.t - item.t) > 0.8) {
      deduped.push(item);
    }
  }

  return deduped;
}

function parseVtt(content: string): LyricsLine[] {
  const srcLines = content.split(/\r?\n/);
  const out: LyricsLine[] = [];

  for (let i = 0; i < srcLines.length; i++) {
    const line = srcLines[i].trim();
    if (!line || line.startsWith("WEBVTT") || line.startsWith("NOTE") || line.startsWith("STYLE")) {
      continue;
    }

    if (!line.includes("-->")) continue;

    const [startRaw] = line.split("-->");
    const startTs = parseVttTime(startRaw.trim().split(" ")[0] ?? "");
    if (!Number.isFinite(startTs)) continue;

    const textLines: string[] = [];
    for (let j = i + 1; j < srcLines.length; j++) {
      const t = srcLines[j].trim();
      if (!t) {
        i = j;
        break;
      }
      textLines.push(t);
      if (j === srcLines.length - 1) i = j;
    }

    const text = cleanCaptionText(textLines.join(" "));
    if (!text) continue;

    out.push({ t: startTs, text });
  }

  const deduped: LyricsLine[] = [];
  for (const item of out) {
    const prev = deduped[deduped.length - 1];
    if (!prev || prev.text !== item.text || Math.abs(prev.t - item.t) > 0.8) {
      deduped.push(item);
    }
  }

  return deduped.sort((a, b) => a.t - b.t);
}

function parseWhisperSegments(raw: string): WhisperSegment[] {
  try {
    const parsed = JSON.parse(raw) as WhisperJson;
    const segments = Array.isArray(parsed.segments) ? parsed.segments : [];

    return segments
      .map((s) => ({
        start: Number(s.start),
        text: cleanCaptionText(String(s.text || "")),
      }))
      .filter((s) => Number.isFinite(s.start) && s.start >= 0 && s.text.length > 0)
      .sort((a, b) => a.start - b.start);
  } catch {
    return [];
  }
}

function parseWhisperJson(raw: string): LyricsLine[] {
  const segments = parseWhisperSegments(raw);

  const deduped: LyricsLine[] = [];
  for (const item of segments) {
    const prev = deduped[deduped.length - 1];
    if (!prev || prev.text !== item.text || Math.abs(prev.t - item.start) > 0.6) {
      deduped.push({ t: item.start, text: item.text });
    }
  }

  return deduped;
}

function ensureVideoCacheDir(videoId: string): string {
  const dir = path.join(CACHE_DIR, videoId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readCachedLyrics(videoId: string): LyricsResponse | null {
  const cachePath = path.join(CACHE_DIR, videoId, "lyrics.json");
  if (!fs.existsSync(cachePath)) return null;

  try {
    const raw = fs.readFileSync(cachePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<LyricsResponse>;
    if (!parsed || parsed.videoId !== videoId || !Array.isArray(parsed.lines)) return null;

    const source =
      parsed.source === "captions" ||
      parsed.source === "catalog" ||
      parsed.source === "catalog_aligned" ||
      parsed.source === "stt"
        ? parsed.source
        : "none";

    const mode = parsed.mode === "plain" ? "plain" : "timed";

    const parsedCandidates = Array.isArray(parsed.candidates)
      ? parsed.candidates
          .filter((c) => c && typeof c.id === "string" && typeof c.label === "string" && Array.isArray(c.lines))
          .map((c) => {
            const source =
              c.source === "captions" ||
              c.source === "catalog" ||
              c.source === "catalog_aligned" ||
              c.source === "stt"
                ? c.source
                : "none";
            const mode = c.mode === "plain" ? "plain" : "timed";
            return {
              id: c.id,
              label: c.label,
              source,
              mode,
              lines: c.lines
                .filter((l: any) => l && Number.isFinite(Number(l.t)) && typeof l.text === "string")
                .map((l: any) => ({ t: Number(l.t), text: l.text })),
              plainLyrics: typeof c.plainLyrics === "string" ? c.plainLyrics : undefined,
              syncMethod: c.syncMethod === "native" || c.syncMethod === "ai" ? c.syncMethod : "none",
              score: Number.isFinite(Number(c.score)) ? Number(c.score) : 0,
            } as LyricsCandidate;
          })
      : [];

    return {
      videoId,
      source,
      mode,
      lines: parsed.lines
        .filter((l) => l && Number.isFinite(Number(l.t)) && typeof l.text === "string")
        .map((l) => ({ t: Number(l.t), text: l.text })),
      plainLyrics: typeof parsed.plainLyrics === "string" ? parsed.plainLyrics : undefined,
      syncMethod: parsed.syncMethod === "native" || parsed.syncMethod === "ai" ? parsed.syncMethod : "none",
      selectedCandidateId: typeof parsed.selectedCandidateId === "string" ? parsed.selectedCandidateId : undefined,
      candidates: parsedCandidates,
    };
  } catch {
    return null;
  }
}

function writeCachedLyrics(result: LyricsResponse): void {
  const videoDir = ensureVideoCacheDir(result.videoId);
  const cachePath = path.join(videoDir, "lyrics.json");
  fs.writeFileSync(cachePath, JSON.stringify(result, null, 2), "utf-8");
}

function subtitleLangScore(fileName: string): number {
  const m = fileName.match(/captions\.([^.]+)(?:\.|$)/i);
  const lang = (m?.[1] || "").toLowerCase();
  if (lang.startsWith("en")) return 40;
  if (lang.startsWith("ko")) return 30;
  if (lang.startsWith("ja")) return 20;
  if (lang.startsWith("fr")) return 10;
  return 0;
}

function subtitleManualScore(fileName: string): number {
  return /(auto|asr|orig)/i.test(fileName) ? 0 : 100;
}

function pickBestSubtitleFile(videoDir: string, expectedScript: ScriptType): string | null {
  const files = fs.readdirSync(videoDir).filter((name) => /^captions(\.[^.]+)*\.vtt$/i.test(name));
  if (files.length === 0) return null;

  const compatible = files.filter((f) => isSubtitleLangCompatible(f, expectedScript));
  const pool = compatible.length > 0 ? compatible : files;

  pool.sort((a, b) => {
    const scoreA = subtitleManualScore(a) + subtitleLangScore(a);
    const scoreB = subtitleManualScore(b) + subtitleLangScore(b);
    if (scoreA !== scoreB) return scoreB - scoreA;
    return a.localeCompare(b);
  });

  return path.join(videoDir, pool[0]);
}

function cleanSearchName(input: string): string {
  return input
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\{[^}]*\}/g, " ")
    .replace(/\b(official|mv|music video|video|lyrics|karaoke|live|topic|vevo)\b/gi, " ")
    .replace(/[|•·]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function readMeta(videoDir: string): { title: string; channelTitle: string } {
  const fallback = { title: "", channelTitle: "" };
  const metaPath = path.join(videoDir, "meta.json");
  if (!fs.existsSync(metaPath)) return fallback;

  try {
    const raw = fs.readFileSync(metaPath, "utf-8");
    const meta = JSON.parse(raw) as { title?: string; channelTitle?: string };
    return {
      title: typeof meta.title === "string" ? meta.title : "",
      channelTitle: typeof meta.channelTitle === "string" ? meta.channelTitle : "",
    };
  } catch {
    return fallback;
  }
}

function extractArtistTrackCandidates(title: string, channelTitle: string): Array<{ artist: string; track: string }> {
  const cleanedTitle = cleanSearchName(title);
  const cleanedChannel = cleanSearchName(channelTitle).replace(/\b(topic|channel)\b/gi, "").trim();

  const candidates: Array<{ artist: string; track: string }> = [];

  for (const sep of [" - ", " – ", " — "]) {
    if (cleanedTitle.includes(sep)) {
      const [left, ...rest] = cleanedTitle.split(sep);
      const right = rest.join(sep).trim();
      if (left.trim() && right) candidates.push({ artist: left.trim(), track: right });
    }
  }

  if (cleanedTitle) candidates.push({ artist: cleanedChannel, track: cleanedTitle });

  const seen = new Set<string>();
  return candidates.filter((c) => {
    const key = `${c.artist.toLowerCase()}::${c.track.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function requestJson<T>(pathWithQuery: string): Promise<T | null> {
  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: LRCLIB_HOST,
        path: pathWithQuery,
        method: "GET",
        headers: { Accept: "application/json" },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          if (!res.statusCode || res.statusCode >= 400) return resolve(null);
          try {
            resolve(JSON.parse(body) as T);
          } catch {
            resolve(null);
          }
        });
      }
    );

    req.on("error", () => resolve(null));
    req.setTimeout(10000, () => {
      req.destroy();
      resolve(null);
    });
    req.end();
  });
}

function scoreCatalogCandidate(track: LRCLibTrack, artist: string, song: string): number {
  const t = (track.trackName || "").toLowerCase();
  const a = (track.artistName || "").toLowerCase();
  const targetTrack = song.toLowerCase();
  const targetArtist = artist.toLowerCase();

  let score = 0;
  if (t === targetTrack) score += 12;
  else if (t.includes(targetTrack) || targetTrack.includes(t)) score += 8;

  if (targetArtist && a === targetArtist) score += 10;
  else if (targetArtist && (a.includes(targetArtist) || targetArtist.includes(a))) score += 6;

  if (track.syncedLyrics && track.syncedLyrics.trim()) score += 10;
  if (track.plainLyrics && track.plainLyrics.trim()) score += 3;

  return score;
}

function extractSyncedLines(track: LRCLibTrack): LyricsLine[] {
  const synced = typeof track.syncedLyrics === "string" ? track.syncedLyrics : "";
  if (!synced.trim()) return [];
  return parseLrc(synced);
}

function extractPlainLyrics(track: LRCLibTrack): string {
  return typeof track.plainLyrics === "string" ? normalizePlainLyrics(track.plainLyrics) : "";
}

async function ensureAudioSource(videoId: string, videoDir: string): Promise<string | null> {
  const audioPath = path.join(videoDir, "source.m4a");
  if (fs.existsSync(audioPath)) return audioPath;

  if (!fs.existsSync(YT_DLP_PATH)) {
    console.warn(`[Lyrics] yt-dlp not found at ${YT_DLP_PATH}`);
    return null;
  }

  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const command =
    `"${YT_DLP_PATH}" -f "bestaudio[ext=m4a]/bestaudio" --extract-audio --audio-format m4a ` +
    `--audio-quality 128K -o "${audioPath}" "${videoUrl}"`;

  try {
    await execAsync(command, { timeout: 240000 });
  } catch (error) {
    console.warn("[Lyrics] Failed to fetch audio source:", error);
  }

  return fs.existsSync(audioPath) ? audioPath : null;
}

async function fetchCaptionsViaYtDlp(
  videoId: string,
  videoDir: string,
  expectedScript: ScriptType
): Promise<string | null> {
  if (!fs.existsSync(YT_DLP_PATH)) {
    console.warn(`[Lyrics] yt-dlp not found at ${YT_DLP_PATH}`);
    return null;
  }

  for (const name of fs.readdirSync(videoDir)) {
    if (/^captions(\.[^.]+)*\.vtt$/i.test(name)) {
      try {
        fs.unlinkSync(path.join(videoDir, name));
      } catch {
        // ignore cleanup errors
      }
    }
  }

  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const outPattern = path.join(videoDir, "captions.%(ext)s");

  const command =
    `"${YT_DLP_PATH}" --write-auto-subs --write-subs --sub-langs "all,-live_chat" ` +
    `--skip-download --sub-format vtt --output "${outPattern}" "${videoUrl}"`;

  try {
    await execAsync(command, { timeout: 180000 });
  } catch (error) {
    console.warn("[Lyrics] yt-dlp subtitle fetch failed:", error);
  }

  return pickBestSubtitleFile(videoDir, expectedScript);
}

async function runWhisperAndGetSegments(videoId: string, videoDir: string): Promise<WhisperSegment[]> {
  const audioPath = await ensureAudioSource(videoId, videoDir);
  if (!audioPath) return [];

  if (!fs.existsSync(WHISPER_PATH)) {
    console.warn(`[Lyrics] whisper not found at ${WHISPER_PATH}`);
    return [];
  }

  const whisperOutPath = path.join(videoDir, "source.json");
  if (fs.existsSync(whisperOutPath)) {
    try {
      fs.unlinkSync(whisperOutPath);
    } catch {
      // ignore cleanup errors
    }
  }

  const command =
    `"${WHISPER_PATH}" "${audioPath}" --model "${WHISPER_MODEL}" --task transcribe ` +
    `--output_format json --output_dir "${videoDir}" --fp16 False --verbose False`;

  try {
    await execAsync(command, { timeout: 600000, maxBuffer: 32 * 1024 * 1024 });
  } catch (error) {
    console.warn("[Lyrics] Whisper run failed:", error);
    return [];
  }

  if (!fs.existsSync(whisperOutPath)) return [];

  try {
    const raw = fs.readFileSync(whisperOutPath, "utf-8");
    return parseWhisperSegments(raw);
  } catch {
    return [];
  }
}

function alignPlainLyricsWithSegments(plainLyrics: string, segments: WhisperSegment[]): LyricsLine[] {
  const lines = splitPlainLyrics(plainLyrics);
  if (lines.length < 4 || segments.length < 4) return [];

  // Lightweight alignment: map curated lyric lines to Whisper timeline anchors.
  const timed: LyricsLine[] = lines.map((line, idx) => {
    const ratio = lines.length === 1 ? 0 : idx / (lines.length - 1);
    const segIdx = Math.min(segments.length - 1, Math.max(0, Math.round(ratio * (segments.length - 1))));
    return { t: segments[segIdx].start, text: line };
  });

  const deduped: LyricsLine[] = [];
  for (const row of timed.sort((a, b) => a.t - b.t)) {
    const prev = deduped[deduped.length - 1];
    if (!prev || prev.text !== row.text || Math.abs(prev.t - row.t) > 0.5) {
      deduped.push(row);
    }
  }

  return deduped;
}

async function fetchCatalogLyricsCandidates(videoDir: string, expectedScript: ScriptType): Promise<CatalogCandidate[]> {
  const meta = readMeta(videoDir);
  const queries = extractArtistTrackCandidates(meta.title, meta.channelTitle);
  const collected: CatalogCandidate[] = [];

  for (const q of queries) {
    if (!q.track) continue;

    const getPath = `/api/get?track_name=${encodeURIComponent(q.track)}&artist_name=${encodeURIComponent(q.artist)}`;
    const direct = await requestJson<LRCLibTrack>(getPath);
    if (direct) {
      const directScore = scoreCatalogCandidate(direct, q.artist, q.track) + 15;
      collected.push({
        track: direct,
        score: directScore,
        label: `${direct.trackName || q.track} — ${direct.artistName || q.artist || "Unknown"}`,
      });
    }

    const query = `${q.artist} ${q.track}`.trim() || q.track;
    const searchPath = `/api/search?q=${encodeURIComponent(query)}`;
    const results = (await requestJson<LRCLibTrack[]>(searchPath)) || [];
    if (!Array.isArray(results) || results.length === 0) continue;

    const ranked = results
      .map((item) => ({
        track: item,
        score: scoreCatalogCandidate(item, q.artist, q.track),
        label: `${item.trackName || q.track} — ${item.artistName || q.artist || "Unknown"}`,
      }))
      .sort((a, b) => b.score - a.score);

    for (const row of ranked.slice(0, 6)) {
      collected.push(row);
    }
  }

  const dedup = new Map<string, CatalogCandidate>();
  for (const c of collected.sort((a, b) => b.score - a.score)) {
    const synced = extractSyncedLines(c.track);
    const plain = extractPlainLyrics(c.track);
    const text = `${synced.map((x) => x.text).join(" ")} ${plain}`.trim();
    if (!text || !isScriptCompatible(text, expectedScript)) continue;

    const key = `${(c.track.trackName || "").toLowerCase()}::${(c.track.artistName || "").toLowerCase()}::${normalizedLyricsFingerprint(
      synced.length > 0 ? "timed" : "plain",
      synced,
      plain
    )}`;
    if (!key.trim()) continue;

    if (!dedup.has(key)) dedup.set(key, c);
  }

  return [...dedup.values()].sort((a, b) => b.score - a.score).slice(0, 6);
}

export async function getLyrics(videoId: string): Promise<LyricsResponse> {
  const videoDir = ensureVideoCacheDir(videoId);
  const meta = readMeta(videoDir);
  const expectedScript = detectExpectedScriptFromMeta(meta.title, meta.channelTitle);

  const cached = readCachedLyrics(videoId);
  if (
    cached &&
    hasCompatibleLyricsPayload(cached, expectedScript) &&
    Array.isArray(cached.candidates) &&
    cached.candidates.length > 0
  ) {
    return cached;
  }

  const rawCandidates: Omit<LyricsCandidate, "score">[] = [];

  // 1) Native captions
  const subtitleFile = await fetchCaptionsViaYtDlp(videoId, videoDir, expectedScript);
  if (subtitleFile && fs.existsSync(subtitleFile)) {
    try {
      const raw = fs.readFileSync(subtitleFile, "utf-8");
      const lines = parseVtt(raw);
      if (lines.length > 0) {
        const text = lines.map((x) => x.text).join(" ");
        if (isScriptCompatible(text, expectedScript)) {
          rawCandidates.push({
            id: "captions_vtt",
            label: "YouTube captions",
            source: "captions",
            mode: "timed",
            lines,
            syncMethod: "native",
          });
        }
      }
    } catch (error) {
      console.warn("[Lyrics] Failed to parse subtitle file:", error);
    }
  }

  // 2) Catalog candidates (2~3 인터넷 후보 비교용)
  const catalogCandidates = await fetchCatalogLyricsCandidates(videoDir, expectedScript);
  for (let i = 0; i < catalogCandidates.length; i++) {
    const c = catalogCandidates[i];
    const synced = extractSyncedLines(c.track);
    const plain = extractPlainLyrics(c.track);

    if (synced.length > 0) {
      rawCandidates.push({
        id: `catalog_synced_${i + 1}`,
        label: c.label,
        source: "catalog",
        mode: "timed",
        lines: synced,
        syncMethod: "native",
      });
    } else if (plain) {
      rawCandidates.push({
        id: `catalog_plain_${i + 1}`,
        label: c.label,
        source: "catalog",
        mode: "plain",
        lines: [],
        plainLyrics: plain,
        syncMethod: "none",
      });
    }
  }

  // 3) Catalog plain lyrics AI sync (Whisper timeline only, text는 catalog 유지)
  const plainForAlign = rawCandidates.filter((c) => c.source === "catalog" && c.mode === "plain").slice(0, 2);
  if (plainForAlign.length > 0) {
    const segments = await runWhisperAndGetSegments(videoId, videoDir);
    if (segments.length > 0) {
      for (let i = 0; i < plainForAlign.length; i++) {
        const c = plainForAlign[i];
        const aligned = alignPlainLyricsWithSegments(c.plainLyrics || "", segments);
        if (aligned.length > 0) {
          rawCandidates.push({
            id: `${c.id}_aligned`,
            label: `${c.label} (AI sync)`,
            source: "catalog_aligned",
            mode: "timed",
            lines: aligned,
            plainLyrics: c.plainLyrics,
            syncMethod: "ai",
          });
        }
      }
    }
  }

  // 4) Final fallback only: STT
  if (rawCandidates.length === 0) {
    const sttSegments = await runWhisperAndGetSegments(videoId, videoDir);
    if (sttSegments.length > 0) {
      const lines = parseWhisperJson(JSON.stringify({ segments: sttSegments }));
      if (lines.length > 0) {
        rawCandidates.push({
          id: "stt_fallback",
          label: "Whisper transcription",
          source: "stt",
          mode: "timed",
          lines,
          syncMethod: "ai",
        });
      }
    }
  }

  if (rawCandidates.length === 0) {
    const noneResult: LyricsResponse = {
      videoId,
      source: "none",
      mode: "plain",
      lines: [],
      plainLyrics: "",
      syncMethod: "none",
      selectedCandidateId: "none",
      candidates: [
        {
          id: "none",
          label: "No lyrics",
          source: "none",
          mode: "plain",
          lines: [],
          plainLyrics: "",
          syncMethod: "none",
          score: 0,
        },
      ],
    };
    writeCachedLyrics(noneResult);
    return noneResult;
  }

  const scored = rawCandidates
    .map((c) => ({ ...c, score: scoreLyricsCandidate(c, expectedScript) }))
    .sort((a, b) => b.score - a.score);
  const topCandidates = pickTopCandidates(scored, 3);
  const selected = topCandidates[0];

  const result: LyricsResponse = {
    videoId,
    source: selected.source,
    mode: selected.mode,
    lines: selected.lines,
    plainLyrics: selected.plainLyrics,
    syncMethod: selected.syncMethod || "none",
    selectedCandidateId: selected.id,
    candidates: topCandidates,
  };
  writeCachedLyrics(result);
  return result;
}
