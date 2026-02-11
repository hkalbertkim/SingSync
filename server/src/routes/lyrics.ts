import { Router } from "express";
import * as fs from "node:fs";
import * as path from "node:path";
import { getLyrics } from "../services/lyrics.js";

const router = Router();

type CommunityCandidate = {
  id: string;
  type: "youtube_captions" | "external_link" | "user_paste";
  label: string;
  url: string | null;
  votes: number;
  pastedLyrics?: string;
};

type CandidatesStore = {
  videoId: string;
  bestId: string;
  candidates: CommunityCandidate[];
};

function safeVideoId(input: string): string {
  return input.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
}

function cacheDir(videoId: string): string {
  return path.join(process.cwd(), "cache", videoId);
}

function candidatesPath(videoId: string): string {
  return path.join(cacheDir(videoId), "lyrics_candidates.json");
}

function ensureCacheDir(videoId: string): void {
  const dir = cacheDir(videoId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readMetaTitle(videoId: string): string {
  const p = path.join(cacheDir(videoId), "meta.json");
  if (!fs.existsSync(p)) return videoId;
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf-8")) as { title?: string };
    const title = (raw.title || "").toString().trim();
    return title || videoId;
  } catch {
    return videoId;
  }
}

function calcBestId(candidates: CommunityCandidate[]): string {
  if (!candidates.length) return "";
  const sorted = [...candidates].sort((a, b) => {
    if (b.votes !== a.votes) return b.votes - a.votes;
    return a.id.localeCompare(b.id);
  });
  return sorted[0].id;
}

function defaultCandidates(videoId: string, title: string, hasCaptions: boolean): CandidatesStore {
  const q = encodeURIComponent(`${title} lyrics`);
  const ddg = `https://duckduckgo.com/?q=${q}`;
  const genius = `https://genius.com/search?q=${q}`;
  const ytSearch = `https://www.youtube.com/results?search_query=${q}`;

  const base: CommunityCandidate[] = [];
  if (hasCaptions) {
    base.push({
      id: "cand_1",
      type: "youtube_captions",
      label: "YouTube Captions",
      url: null,
      votes: 1,
    });
    base.push({
      id: "cand_2",
      type: "external_link",
      label: "Genius (Search)",
      url: genius,
      votes: 0,
    });
    base.push({
      id: "cand_3",
      type: "external_link",
      label: "DuckDuckGo Results",
      url: ddg,
      votes: 0,
    });
  } else {
    base.push({
      id: "cand_1",
      type: "external_link",
      label: "Genius (Search)",
      url: genius,
      votes: 0,
    });
    base.push({
      id: "cand_2",
      type: "external_link",
      label: "DuckDuckGo Results",
      url: ddg,
      votes: 0,
    });
    base.push({
      id: "cand_3",
      type: "external_link",
      label: "YouTube Results",
      url: ytSearch,
      votes: 0,
    });
  }

  return {
    videoId,
    bestId: calcBestId(base),
    candidates: base,
  };
}

function readStore(videoId: string): CandidatesStore | null {
  const p = candidatesPath(videoId);
  if (!fs.existsSync(p)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf-8")) as CandidatesStore;
    if (!raw || raw.videoId !== videoId || !Array.isArray(raw.candidates)) return null;
    const candidates: CommunityCandidate[] = raw.candidates
      .filter((c) => c && typeof c.id === "string" && typeof c.label === "string")
      .map((c) => {
        const type: CommunityCandidate["type"] =
          c.type === "youtube_captions" || c.type === "user_paste" ? c.type : "external_link";
        return {
        id: c.id,
        type,
        label: c.label,
        url: typeof c.url === "string" ? c.url : null,
        votes: Number.isFinite(Number(c.votes)) ? Number(c.votes) : 0,
        pastedLyrics: typeof c.pastedLyrics === "string" ? c.pastedLyrics : undefined,
      };});

    const bestId = candidates.some((c) => c.id === raw.bestId) ? raw.bestId : calcBestId(candidates);
    return { videoId, bestId, candidates };
  } catch {
    return null;
  }
}

function writeStore(videoId: string, store: CandidatesStore): CandidatesStore {
  ensureCacheDir(videoId);
  const next: CandidatesStore = {
    videoId,
    bestId: calcBestId(store.candidates),
    candidates: store.candidates,
  };
  fs.writeFileSync(candidatesPath(videoId), JSON.stringify(next, null, 2), "utf-8");
  return next;
}

async function hasCaptionLyrics(videoId: string): Promise<boolean> {
  try {
    const data = await getLyrics(videoId);
    return Array.isArray(data?.lines) && data.lines.length > 0 && data.source !== "none";
  } catch {
    return false;
  }
}

async function ensureStore(videoId: string): Promise<CandidatesStore> {
  const hasCaptions = await hasCaptionLyrics(videoId);
  const title = readMetaTitle(videoId);

  const existing = readStore(videoId);
  if (!existing) {
    return writeStore(videoId, defaultCandidates(videoId, title, hasCaptions));
  }

  let candidates = [...existing.candidates];

  if (hasCaptions && !candidates.some((c) => c.type === "youtube_captions")) {
    candidates = [
      {
        id: `cand_${Date.now()}`,
        type: "youtube_captions",
        label: "YouTube Captions",
        url: null,
        votes: 0,
      },
      ...candidates,
    ];
  }

  if (candidates.length < 3) {
    const defaults = defaultCandidates(videoId, title, hasCaptions).candidates;
    for (const c of defaults) {
      if (candidates.length >= 3) break;
      if (!candidates.some((x) => x.label === c.label)) {
        candidates.push({ ...c, id: `cand_${Date.now()}_${Math.random().toString(36).slice(2, 6)}` });
      }
    }
  }

  return writeStore(videoId, {
    videoId,
    bestId: existing.bestId,
    candidates,
  });
}

// GET /api/lyrics?videoId=XXXX
router.get("/", async (req, res) => {
  const videoId = String(req.query.videoId || "").trim();
  if (!videoId) {
    return res.status(400).json({ error: "videoId is required" });
  }

  try {
    const data = await getLyrics(videoId);
    return res.json(data);
  } catch (error) {
    console.error("[Lyrics] endpoint failed:", error);
    return res.json({
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
    });
  }
});

// GET /api/lyrics/:videoId/candidates
router.get("/:videoId/candidates", async (req, res) => {
  const videoId = safeVideoId(String(req.params.videoId || "").trim());
  if (!videoId) return res.status(400).json({ error: "videoId is required" });

  try {
    const store = await ensureStore(videoId);
    return res.json(store);
  } catch (error) {
    console.error("[LyricsCandidates] get failed:", error);
    return res.status(500).json({ error: "failed to load lyrics candidates" });
  }
});

// POST /api/lyrics/:videoId/candidates
router.post("/:videoId/candidates", async (req, res) => {
  const videoId = safeVideoId(String(req.params.videoId || "").trim());
  if (!videoId) return res.status(400).json({ error: "videoId is required" });

  const type = String(req.body?.type || "").trim();
  const label = String(req.body?.label || "").trim().slice(0, 80);
  const urlRaw = req.body?.url == null ? null : String(req.body?.url).trim();
  const pastedLyrics = typeof req.body?.pastedLyrics === "string" ? String(req.body.pastedLyrics).slice(0, 20000) : undefined;

  if (!label) return res.status(400).json({ error: "label is required" });
  if (!["external_link", "user_paste"].includes(type)) {
    return res.status(400).json({ error: "type must be external_link or user_paste" });
  }
  if (type === "external_link" && !urlRaw) {
    return res.status(400).json({ error: "url is required for external_link" });
  }

  try {
    const store = await ensureStore(videoId);
    const next: CommunityCandidate = {
      id: `cand_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      type: type as "external_link" | "user_paste",
      label,
      url: type === "external_link" ? urlRaw : null,
      votes: 0,
      pastedLyrics,
    };

    const updated = writeStore(videoId, {
      videoId,
      bestId: store.bestId,
      candidates: [...store.candidates, next],
    });

    return res.json(updated);
  } catch (error) {
    console.error("[LyricsCandidates] add failed:", error);
    return res.status(500).json({ error: "failed to add candidate" });
  }
});

// POST /api/lyrics/:videoId/vote
router.post("/:videoId/vote", async (req, res) => {
  const videoId = safeVideoId(String(req.params.videoId || "").trim());
  const candidateId = String(req.body?.candidateId || "").trim();
  if (!videoId || !candidateId) {
    return res.status(400).json({ error: "videoId and candidateId are required" });
  }

  try {
    const store = await ensureStore(videoId);
    const idx = store.candidates.findIndex((c) => c.id === candidateId);
    if (idx < 0) return res.status(404).json({ error: "candidate not found" });

    const nextCandidates = [...store.candidates];
    nextCandidates[idx] = {
      ...nextCandidates[idx],
      votes: (nextCandidates[idx].votes || 0) + 1,
    };

    const updated = writeStore(videoId, {
      videoId,
      bestId: store.bestId,
      candidates: nextCandidates,
    });

    return res.json(updated);
  } catch (error) {
    console.error("[LyricsCandidates] vote failed:", error);
    return res.status(500).json({ error: "failed to vote" });
  }
});

export default router;
