// src/lyrics/collectLyricsRaw.ts

export type LyricsRawBundle = {
  videoId: string;

  // YouTube captions (VTT->text) if available
  ytCaptionText?: string;

  // Web lyrics raw candidates (0..N)
  webLyrics: Array<{
    source: string;     // e.g. domain or provider id
    url?: string;
    text: string;
  }>;

  // STT from vocals.wav (optional)
  sttText?: string;

  collectedAt: string;  // ISO timestamp
};

export type CollectLyricsRawOptions = {
  // If true, always try captions first (recommended for SingSync)
  preferYouTubeCaptions: boolean;

  // Max number of web lyrics to collect (recommend 2~3)
  maxWebCandidates: number;

  // When to run STT
  sttMode: "onlyIfNoOther" | "alwaysOff" | "alwaysOn";
};

/**
 * STEP1 Goal:
 * - Define a stable "raw lyrics input contract" that later steps can rely on.
 * - This function should eventually:
 *   1) try YouTube captions (if enabled)
 *   2) fetch web lyrics candidates (0..maxWebCandidates)
 *   3) run STT depending on sttMode
 * - For now, it returns an empty bundle with the contract locked in.
 */
export async function collectLyricsRaw(
  videoId: string,
  opts: CollectLyricsRawOptions,
): Promise<LyricsRawBundle> {
  // Contract is locked here. Implementation will be added in later steps.
  // Keep this minimal and predictable so downstream (selector/formatter/UI) can depend on it.
  void opts;

  return {
    videoId,
    ytCaptionText: undefined,
    webLyrics: [],
    sttText: undefined,
    collectedAt: new Date().toISOString(),
  };
}
