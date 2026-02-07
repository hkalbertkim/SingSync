# SingSync Development Report

## 1. Executive Summary

This report documents the end-to-end implementation progress completed so far for SingSync, including:

- YouTube search ranking improvements for singing-ready results
- Post-song flow UX with replay and recommendations
- Lyrics pipeline with multi-source retrieval and fallback logic
- Language/script filtering for lyric quality control
- Candidate-based lyric selection in the UI
- Public testing readiness changes (network and API routing)

The system is now functionally usable for external testing (via tunnel/proxy), with a significantly improved karaoke flow and lyric reliability compared to the initial state.

## 2. Scope Completed

### 2.1 Search Ranking (Server-side)

Implemented lightweight scoring/re-ranking to prioritize karaoke-like results while preserving result schema and not discarding non-matches.

**Implemented in:**
- `server/src/services/youtube.ts`

**Behavior:**
- Boosts titles containing karaoke/lyrics/instrumental related terms
- Boosts channels with karaoke/lyrics-oriented naming
- Keeps original ordering as tie-breaker to preserve baseline relevance

### 2.2 Post-Song Flow

Added a dedicated post-song phase triggered strictly by the instrumental track end event.

**Implemented in:**
- `web/app/page.tsx`

**Behavior:**
- New phase: `post_song`
- Trigger source of truth: instrumental `<audio>` `ended`
- Actions:
  - `Sing another` -> browse
  - `Replay` -> countdown -> singing
- Includes:
  - “Up next” recommendations (from recent prepared songs)
  - Post-song ad placeholder
- No interruptions during active singing playback

### 2.3 Lyrics Endpoint and Frontend Integration

Added YouTube lyrics retrieval endpoint and synchronized lyric rendering in singing mode.

**Implemented in:**
- `server/src/routes/lyrics.ts`
- `server/src/services/lyrics.ts`
- `server/src/index.ts`
- `web/app/page.tsx`

**Endpoint:**
- `GET /api/lyrics?videoId=<id>`

**Response model (current):**
- `videoId`
- `source` (`captions | catalog | catalog_aligned | stt | none`)
- `mode` (`timed | plain`)
- `lines` (timed lines)
- `plainLyrics` (optional)
- `syncMethod` (`native | ai | none`)
- `selectedCandidateId` (optional)
- `candidates` (optional top candidates)

### 2.4 Multi-Source Lyrics Strategy

Implemented a reliability-first pipeline (internet lyrics preferred, STT last):

1. YouTube captions (yt-dlp)
2. Catalog/internet lyrics retrieval (LRCLIB)
3. Catalog plain lyrics + AI timing alignment (Whisper segments)
4. Full Whisper STT fallback only when needed
5. None

**Key points:**
- Caching under `server/cache/<videoId>/lyrics.json`
- Candidate scoring and top-N selection (typically 2–3 candidates)
- Deduplication across near-identical lyric payloads
- Automatic best candidate selection while preserving alternatives

### 2.5 Lyric Candidate Selection (UI)

Added UI controls for users to switch among lyric candidates during singing without restarting audio.

**Implemented in:**
- `web/app/page.tsx`

**Behavior:**
- If multiple candidates exist, candidate buttons are shown
- User selection swaps lyric source/rendering in-place
- Playback remains uninterrupted

### 2.6 Language/Script Quality Filtering

Implemented script compatibility filtering to reduce wrong-language lyrics attached to songs.

**Implemented in:**
- `server/src/services/lyrics.ts`

**Behavior:**
- Detects expected script from title/channel metadata
- Filters incompatible subtitle tracks and catalog results
- Allows realistic mixed-language cases (e.g., KO/JA songs with English lines)
- Blocks obviously mismatched script outcomes (e.g., Cyrillic for JP/KR expectation)

## 3. Public Testing Readiness

### 3.1 API Hardcoding Removal

Replaced frontend hardcoded `http://localhost:4000` calls with configurable base URL logic.

**Implemented in:**
- `web/app/page.tsx`

### 3.2 Reverse Proxy Rewrites in Next.js

Added Next rewrites to route same-origin frontend requests to backend:

- `/api/*` -> backend `/api/*`
- `/cache/*` -> backend `/cache/*`

**Implemented in:**
- `web/next.config.ts`

### 3.3 External Host Binding

Enabled external access binding for both services.

**Implemented in:**
- `web/package.json`
  - `next dev -H 0.0.0.0 -p 3000`
  - `next start -H 0.0.0.0 -p 3000`
- `server/src/index.ts`
  - server listens on `HOST` env (default `0.0.0.0`)

### 3.4 Tunnel-based Public Test

A temporary external test URL was successfully created using localtunnel.

Note: This URL is ephemeral and changes when the tunnel process restarts.

## 4. Files Added/Changed (High-Level)

### Server
- `server/src/index.ts`
- `server/src/routes/search.ts`
- `server/src/routes/prepare.ts`
- `server/src/routes/lyrics.ts`
- `server/src/services/youtube.ts`
- `server/src/services/downloader.ts`
- `server/src/services/separator.ts`
- `server/src/services/lyrics.ts`
- `server/package.json`
- `server/package-lock.json`

### Web
- `web/app/page.tsx`
- `web/next.config.ts`
- `web/package.json`

### Root / Tooling
- `.gitignore` (safety exclusions)
- `scripts/dev-up.sh`
- `scripts/dev-down.sh`
- `scripts/dev-status.sh`
- `package.json` (workspace helper scripts)
- `DEVELOPMENT_REPORT.md` (this file)

## 5. Build/Validation Status

Validation was run repeatedly during implementation:

- `server`: `npx tsc --noEmit` -> pass
- `web`: `npm run build` -> pass

Runtime checks performed:

- Local API availability on port 4000
- Local web availability on port 3000
- Lyrics endpoint behavior tested for multiple video IDs
- Public access tested through tunnel URL

## 6. Security and Repository Hygiene

To avoid accidental leakage or oversized commits, the following are excluded via `.gitignore`:

- `server/cache/`
- `server/.en`
- `.logs/`
- `.run/`
- transient/generated local artifacts

Important note:

- API keys must remain in local env files and never be committed.

## 7. Known Limitations

1. Lyric source quality can still vary per song/video metadata quality.
2. External tunnel URLs are temporary unless a stable deployment is used.
3. Current lyric catalog integration is centered on available free sources; absolute coverage cannot be guaranteed for all songs.
4. The current frontend remains a single large page component and would benefit from modularization.

## 8. Recommended Next Steps

1. Introduce production deployment (single fixed domain + reverse proxy + TLS).
2. Add optional per-song lyric source persistence (remember selected candidate by `videoId`).
3. Add basic telemetry/logging around lyric source success rates.
4. Refactor `web/app/page.tsx` into smaller components/hooks for maintainability.
5. Add automated tests for ranking score behavior and lyrics pipeline selection logic.

## 9. Operational Quick Start

### Run locally

```bash
cd /Users/albertkim/singsync
npm run dev:up
npm run dev:status
```

### Expose for external testers (temporary)

```bash
npx --yes localtunnel --port 3000
```

Share the printed `https://*.loca.lt` URL.

## 10. Current Outcome

SingSync now supports:

- Better karaoke-oriented YouTube search ranking
- Stable end-of-song transition with replay/next-song flow
- Multi-source lyrics retrieval with reliability-first prioritization
- User-selectable lyric candidates during singing
- Public test readiness through network/proxy updates

