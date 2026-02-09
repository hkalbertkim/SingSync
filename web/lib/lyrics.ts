/** Shared lyrics types and utilities used across the SingSync frontend. */

export type LyricLine = { t: number; text: string };

export type LyricsSource = "idle" | "captions" | "catalog" | "catalog_aligned" | "stt" | "none";
export type LyricsMode = "timed" | "plain";

export interface LyricsCandidateApi {
  id: string;
  label: string;
  source: "captions" | "catalog" | "catalog_aligned" | "stt" | "none";
  mode: LyricsMode;
  lines: LyricLine[];
  plainLyrics?: string;
  syncMethod?: "native" | "ai" | "none";
  score?: number;
}

export interface LyricsApiResponse {
  videoId: string;
  source: "captions" | "catalog" | "catalog_aligned" | "stt" | "none";
  mode?: LyricsMode;
  lines: LyricLine[];
  plainLyrics?: string;
  syncMethod?: "native" | "ai" | "none";
  selectedCandidateId?: string;
  candidates?: LyricsCandidateApi[];
}

/** Parse an LRC-format string into sorted timed lyric lines. */
export function parseLrc(text: string): LyricLine[] {
  const out: LyricLine[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = [...line.matchAll(/\[(\d+):(\d+)(?:\.(\d+))?\](.*)/g)];
    for (const x of m) {
      const t = Number(x[1]) * 60 + Number(x[2]) + (x[3] ? Number(x[3]) / 100 : 0);
      out.push({ t, text: (x[4] ?? "").trim() });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

/** Find the index of the active lyric line for the given playback time. */
export function findActiveLyricIndex(lines: LyricLine[], t: number): number {
  let i = -1;
  for (let k = 0; k < lines.length; k++) {
    if (lines[k].t <= t) i = k;
    else break;
  }
  return i;
}

/**
 * Normalise a raw API candidate into a safe LyricsCandidateApi object.
 * Filters invalid lines and coerces fields to expected types.
 */
export function normaliseCandidate(raw: Record<string, unknown>): LyricsCandidateApi | null {
  if (!raw || typeof raw.id !== "string" || typeof raw.label !== "string") return null;

  const rawLines = Array.isArray(raw.lines) ? raw.lines : [];
  const lines: LyricLine[] = rawLines
    .filter(
      (l: unknown): l is { t: unknown; text: unknown } =>
        !!l && typeof l === "object" && "t" in l && "text" in l,
    )
    .filter((l) => Number.isFinite(Number(l.t)) && typeof l.text === "string")
    .map((l) => ({ t: Number(l.t), text: l.text as string }));

  const validSources = ["captions", "catalog", "catalog_aligned", "stt", "none"] as const;
  const source = validSources.includes(raw.source as (typeof validSources)[number])
    ? (raw.source as LyricsCandidateApi["source"])
    : "none";

  const validSync = ["native", "ai", "none"] as const;
  const syncMethod = validSync.includes(raw.syncMethod as (typeof validSync)[number])
    ? (raw.syncMethod as "native" | "ai" | "none")
    : "none";

  return {
    id: raw.id,
    label: raw.label,
    source,
    mode: raw.mode === "plain" ? "plain" : "timed",
    lines,
    plainLyrics: typeof raw.plainLyrics === "string" ? raw.plainLyrics : "",
    syncMethod,
    score: Number.isFinite(Number(raw.score)) ? Number(raw.score) : 0,
  };
}

/**
 * Parse a full LyricsApiResponse into a normalised candidate list and a
 * preferred selected candidate id.
 */
export function parseLyricsResponse(data: LyricsApiResponse): {
  candidates: LyricsCandidateApi[];
  selectedId: string;
} {
  const rawCandidates = Array.isArray(data?.candidates) ? data.candidates : [];
  const parsed = rawCandidates
    .map((c) => normaliseCandidate(c as unknown as Record<string, unknown>))
    .filter((c): c is LyricsCandidateApi => c !== null);

  // Build a fallback from the top-level response fields.
  const fallback: LyricsCandidateApi = {
    id: "default",
    label: "Default",
    source:
      (["captions", "catalog", "catalog_aligned", "stt"] as const).find((s) => s === data?.source) ??
      "none",
    mode: data?.mode === "plain" ? "plain" : "timed",
    lines: Array.isArray(data?.lines)
      ? data.lines
          .filter((l) => l && Number.isFinite(Number(l.t)) && typeof l.text === "string")
          .map((l) => ({ t: Number(l.t), text: l.text }))
      : [],
    plainLyrics: typeof data?.plainLyrics === "string" ? data.plainLyrics : "",
    syncMethod:
      data?.syncMethod === "native" || data?.syncMethod === "ai" ? data.syncMethod : "none",
    score: 0,
  };

  const candidates = parsed.length > 0 ? parsed : [fallback];
  const preferred = data?.selectedCandidateId || candidates[0].id;
  const selectedId = candidates.some((c) => c.id === preferred) ? preferred : candidates[0].id;

  return { candidates, selectedId };
}
