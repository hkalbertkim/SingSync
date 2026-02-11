"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import LyricsPicker from "../components/LyricsPicker";
import LyricsVotingPanel, { type CommunityCandidate } from "../components/LyricsVotingPanel";
import {
  findActiveLyricIndex,
  parseLrc,
  parseLyricsResponse,
  type LyricLine,
  type LyricsApiResponse,
  type LyricsCandidateApi,
  type LyricsMode,
  type LyricsSource,
} from "../lib/lyrics";

const RAW_API_BASE = (process.env.NEXT_PUBLIC_API_BASE || "").trim().replace(/\/$/, "");
const API_BASE =
  process.env.NODE_ENV === "production"
    ? RAW_API_BASE.startsWith("https://")
      ? RAW_API_BASE
      : ""
    : RAW_API_BASE || "http://127.0.0.1:4000";

function apiUrl(path: string): string {
  if (!path.startsWith("/")) return path;
  return API_BASE ? `${API_BASE}${path}` : path;
}

type Song = {
  id: string;
  title: string;
  videoFile: string;
  channelTitle?: string;
  instrumentalUrl?: string;
  vocalsUrl?: string;
};
type Phase = "browse" | "selecting" | "preparing" | "countdown" | "singing" | "post_song";

interface YouTubeResult {
  videoId: string;
  title: string;
  thumbnail: string;
  duration: string;
  channelTitle: string;
  publishedAt: string;
}

interface JobStatus {
  jobId: string;
  status: "pending" | "downloading" | "separating" | "complete" | "error";
  progress: number;
  stage: string;
  error?: string;
  result?: {
    instrumentalUrl: string;
    vocalsUrl: string;
  };
}

type RecentItem = {
  videoId: string;
  title: string;
  channelTitle: string;
  instrumentalUrl: string;
  vocalsUrl: string;
  preparedAt: string;
};

type LyricsCandidatesPayload = {
  videoId: string;
  bestId: string;
  candidates: CommunityCandidate[];
};

const DEBUG_SEARCH = true;

function decodeHtml(str: string): string {
  if (typeof document === "undefined") return str;
  const txt = document.createElement("textarea");
  txt.innerHTML = str;
  return txt.value;
}

function waitCanPlayThrough(audio: HTMLAudioElement): Promise<void> {
  if (audio.readyState >= 4) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      audio.removeEventListener("canplaythrough", done);
      resolve();
    };
    audio.addEventListener("canplaythrough", done);
  });
}

const offsetEstimateCache = new Map<string, number>();

function toMonoPcm(buffer: AudioBuffer): Float32Array {
  const channels = buffer.numberOfChannels;
  const length = buffer.length;
  const mono = new Float32Array(length);
  for (let ch = 0; ch < channels; ch += 1) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < length; i += 1) {
      mono[i] += data[i] / channels;
    }
  }
  return mono;
}

function buildRmsEnvelope(samples: Float32Array, frameSize = 2048, hop = 1024): Float32Array {
  if (samples.length < frameSize) return new Float32Array(0);
  const frames = Math.floor((samples.length - frameSize) / hop) + 1;
  const env = new Float32Array(frames);
  for (let f = 0; f < frames; f += 1) {
    const start = f * hop;
    let sum = 0;
    for (let i = 0; i < frameSize; i += 1) {
      const v = samples[start + i];
      sum += v * v;
    }
    env[f] = Math.sqrt(sum / frameSize);
  }
  return env;
}

function findOnsetFrame(env: Float32Array): number {
  if (!env.length) return 0;
  let mean = 0;
  for (let i = 0; i < env.length; i += 1) mean += env[i];
  mean /= env.length;
  const threshold = Math.max(mean * 3.0, 0.008);
  for (let i = 0; i < env.length; i += 1) {
    if (env[i] >= threshold) return i;
  }
  return 0;
}

function estimateLagFrames(a: Float32Array, b: Float32Array, maxLag: number): number {
  if (!a.length || !b.length) return 0;
  let bestLag = 0;
  let bestScore = -Infinity;
  for (let lag = -maxLag; lag <= maxLag; lag += 1) {
    let sum = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i += 1) {
      const j = i + lag;
      if (j < 0 || j >= b.length) continue;
      const av = a[i];
      const bv = b[j];
      sum += av * bv;
      normA += av * av;
      normB += bv * bv;
    }
    if (!normA || !normB) continue;
    const score = sum / Math.sqrt(normA * normB);
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }
  return bestLag;
}

async function estimateInitialOffsetSec(instUrl: string, voxUrl: string): Promise<number> {
  const cacheKey = `${instUrl}|${voxUrl}`;
  const cached = offsetEstimateCache.get(cacheKey);
  if (typeof cached === "number") return cached;

  if (typeof window === "undefined") return 0;

  try {
    const [instRes, voxRes] = await Promise.all([
      fetch(instUrl, { cache: "force-cache" }),
      fetch(voxUrl, { cache: "force-cache" }),
    ]);
    const [instBuf, voxBuf] = await Promise.all([instRes.arrayBuffer(), voxRes.arrayBuffer()]);
    const AC: typeof AudioContext | undefined =
      window.AudioContext || ((window as any).webkitAudioContext as typeof AudioContext | undefined);
    if (!AC) return 0;

    const ctx = new AC();
    const [instDecoded, voxDecoded] = await Promise.all([
      ctx.decodeAudioData(instBuf.slice(0)),
      ctx.decodeAudioData(voxBuf.slice(0)),
    ]);
    await ctx.close();

    const monoInst = toMonoPcm(instDecoded);
    const monoVox = toMonoPcm(voxDecoded);
    const frameSize = 2048;
    const hop = 1024;
    const envInst = buildRmsEnvelope(monoInst, frameSize, hop);
    const envVox = buildRmsEnvelope(monoVox, frameSize, hop);

    if (!envInst.length || !envVox.length) return 0;

    const onsetInst = findOnsetFrame(envInst);
    const onsetVox = findOnsetFrame(envVox);
    const onsetDiffFrames = onsetVox - onsetInst;

    const sampleRate = Math.max(1, instDecoded.sampleRate || 48000);
    const lagWindowSec = 2.0;
    const maxLag = Math.round((lagWindowSec * sampleRate) / hop);
    const lag = estimateLagFrames(envInst, envVox, maxLag);

    const onsetSec = (onsetDiffFrames * hop) / sampleRate;
    const lagSec = (lag * hop) / sampleRate;
    const blended = lagSec * 0.7 + onsetSec * 0.3;
    const clamped = Math.max(-1.5, Math.min(1.5, blended));
    offsetEstimateCache.set(cacheKey, clamped);
    return clamped;
  } catch {
    offsetEstimateCache.set(cacheKey, 0);
    return 0;
  }
}

function Card(props: { children: React.ReactNode }) {
  return (
    <div
      style={{
        borderRadius: 14,
        border: "1px solid #1f1f28",
        background: "#101018",
        padding: 14,
      }}
    >
      {props.children}
    </div>
  );
}

function formatTimeAgo(iso: string) {
  const t = new Date(iso).getTime();
  const diff = Date.now() - t;
  if (!Number.isFinite(diff) || diff < 0) return "just now";
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export default function Page() {
  // 2-track audio mixing
  const instrumentalRef = useRef<HTMLAudioElement | null>(null);
  const vocalsRef = useRef<HTMLAudioElement | null>(null);
  const playbackInitKeyRef = useRef("");

  const [phase, setPhase] = useState<Phase>("browse");
  const [songs, setSongs] = useState<Song[]>([]);
  const [q, setQ] = useState("");
  const [song, setSong] = useState<Song | null>(null);

  const [prep, setPrep] = useState(0);
  const [cd, setCd] = useState(3);

  const [lyrics, setLyrics] = useState<LyricLine[]>([]);
  const [active, setActive] = useState(-1);

  // YouTube caption lyrics
  const [ytLyrics, setYtLyrics] = useState<LyricLine[]>([]);
  const [ytLyricsSource, setYtLyricsSource] = useState<LyricsSource>("idle");
  const [ytLyricsLoading, setYtLyricsLoading] = useState(false);
  const [ytLyricsMode, setYtLyricsMode] = useState<LyricsMode>("timed");
  const [ytPlainLyrics, setYtPlainLyrics] = useState("");
  const [ytLyricCandidates, setYtLyricCandidates] = useState<LyricsCandidateApi[]>([]);
  const [selectedLyricCandidateId, setSelectedLyricCandidateId] = useState("");
  const [lyricsEnabled, setLyricsEnabled] = useState(true);

  // YouTube search state
  const [youtubeResults, setYoutubeResults] = useState<YouTubeResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [selectedVideo, setSelectedVideo] = useState<YouTubeResult | null>(null);
  const [searchDebugRaw, setSearchDebugRaw] = useState("");

  // Current YouTube video for overlay (muted)
  const [youtubeOverlayId, setYoutubeOverlayId] = useState<string | null>(null);
  const youtubePlayerRef = useRef<any>(null);
  const youtubeHostRef = useRef<HTMLDivElement | null>(null);

  // Job processing state
  const [jobId, setJobId] = useState<string | null>(null);
  const [jobStatus, setJobStatus] = useState<JobStatus | null>(null);

  // Vocal guide volume 0.0 ~ 1.0
  const [vocalGain, setVocalGain] = useState(0.0);

  // What People Are Singing
  const [recent, setRecent] = useState<RecentItem[]>([]);
  const [recentLoading, setRecentLoading] = useState(false);

  // Community lyrics candidates
  const [communityCandidates, setCommunityCandidates] = useState<CommunityCandidate[]>([]);
  const [communityBestId, setCommunityBestId] = useState("");
  const [communitySelectedId, setCommunitySelectedId] = useState("");
  const [communityVoteBusy, setCommunityVoteBusy] = useState(false);
  const [communityVoteHint, setCommunityVoteHint] = useState("");

  // ad rotation dummy
  const [adIndex, setAdIndex] = useState(0);
  const AD_MESSAGES = ["Ad #1 (Preparing)", "Ad #2 (Preparing)", "Ad #3 (Preparing)", "Ad #4 (Countdown)"];

  // fetch songs (local playlist)
  useEffect(() => {
    fetch(apiUrl("/api/songs"), { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => setSongs(Array.isArray(d) ? d : []))
      .catch(() => setSongs([]));
  }, []);

  // fetch recent prepared songs
  const refreshRecent = async () => {
    setRecentLoading(true);
    try {
      const r = await fetch(apiUrl("/api/activity/recent?limit=12"), { cache: "no-store" });
      const data = await r.json();
      setRecent(Array.isArray(data.items) ? data.items : []);
    } catch {
      setRecent([]);
    } finally {
      setRecentLoading(false);
    }
  };

  useEffect(() => {
    refreshRecent();
  }, []);

  const playYouTube = () => {
    const player = youtubePlayerRef.current;
    if (player && typeof player.playVideo === "function") {
      try {
        player.playVideo();
      } catch {
        // ignore player errors
      }
    }
  };

  const pauseYouTube = () => {
    const player = youtubePlayerRef.current;
    if (player && typeof player.pauseVideo === "function") {
      try {
        player.pauseVideo();
      } catch {
        // ignore player errors
      }
    }
  };

  useEffect(() => {
    if (phase !== "singing" || !youtubeOverlayId) {
      if (youtubePlayerRef.current && typeof youtubePlayerRef.current.destroy === "function") {
        try {
          youtubePlayerRef.current.destroy();
        } catch {
          // ignore destroy errors
        }
      }
      youtubePlayerRef.current = null;
      return;
    }

    let cancelled = false;
    const playerHost = youtubeHostRef.current;
    if (!playerHost) return;

    const initPlayer = () => {
      if (cancelled) return;
      const YTGlobal = (window as any).YT;
      if (!YTGlobal || !YTGlobal.Player || !youtubeHostRef.current) return;

      if (youtubePlayerRef.current && typeof youtubePlayerRef.current.loadVideoById === "function") {
        youtubePlayerRef.current.loadVideoById(youtubeOverlayId);
        youtubePlayerRef.current.mute?.();
        return;
      }

      youtubePlayerRef.current = new YTGlobal.Player(youtubeHostRef.current, {
        videoId: youtubeOverlayId,
        playerVars: {
          autoplay: 0,
          controls: 0,
          rel: 0,
          playsinline: 1,
          modestbranding: 1,
        },
        events: {
          onReady: (evt: any) => {
            try {
              evt.target.mute();
            } catch {
              // ignore
            }
          },
        },
      });
    };

    if ((window as any).YT?.Player) {
      initPlayer();
      return () => {
        cancelled = true;
      };
    }

    const scriptId = "youtube-iframe-api";
    if (!document.getElementById(scriptId)) {
      const script = document.createElement("script");
      script.id = scriptId;
      script.src = "https://www.youtube.com/iframe_api";
      document.body.appendChild(script);
    }

    const prevReady = (window as any).onYouTubeIframeAPIReady;
    (window as any).onYouTubeIframeAPIReady = () => {
      if (typeof prevReady === "function") prevReady();
      initPlayer();
    };

    return () => {
      cancelled = true;
    };
  }, [youtubeOverlayId, phase]);

  const filtered = useMemo(() => {
    const qq = q.toLowerCase();
    return songs.filter((s) => s.title.toLowerCase().includes(qq));
  }, [songs, q]);

  const upNext = useMemo(() => {
    const currentId = song?.id || youtubeOverlayId || "";
    return recent.filter((it) => it.videoId !== currentId).slice(0, 3);
  }, [recent, song?.id, youtubeOverlayId]);

  const selectedLyricCandidate = useMemo(() => {
    if (!youtubeOverlayId) return null;
    if (!ytLyricCandidates.length) return null;
    return (
      ytLyricCandidates.find((c) => c.id === selectedLyricCandidateId) ||
      ytLyricCandidates[0] ||
      null
    );
  }, [youtubeOverlayId, ytLyricCandidates, selectedLyricCandidateId]);

  useEffect(() => {
    if (!selectedLyricCandidate) return;
    const lines = Array.isArray(selectedLyricCandidate.lines)
      ? selectedLyricCandidate.lines
          .filter((l) => l && Number.isFinite(Number(l.t)) && typeof l.text === "string")
          .map((l) => ({ t: Number(l.t), text: l.text }))
      : [];
    setYtLyrics(lines);
    setYtLyricsSource(selectedLyricCandidate.source);
    setYtLyricsMode(selectedLyricCandidate.mode === "plain" ? "plain" : "timed");
    setYtPlainLyrics(typeof selectedLyricCandidate.plainLyrics === "string" ? selectedLyricCandidate.plainLyrics : "");
  }, [selectedLyricCandidate]);

  const activeLyrics = useMemo(() => {
    return youtubeOverlayId ? ytLyrics : lyrics;
  }, [youtubeOverlayId, ytLyrics, lyrics]);

  const prevLine = active > 0 ? activeLyrics[active - 1]?.text || "" : "";
  const currentLine = active >= 0 ? activeLyrics[active]?.text || "" : "";
  const nextLine = active >= 0 && active + 1 < activeLyrics.length ? activeLyrics[active + 1]?.text || "" : "";
  const firstLyricAt = activeLyrics.length > 0 ? activeLyrics[0].t : 0;
  const nowTime = instrumentalRef.current?.currentTime || 0;
  const secondsUntilFirstLyric = Math.max(0, Math.ceil(firstLyricAt - nowTime));

  // Search YouTube
  const handleSearch = async () => {
    if (!q.trim()) return;

    setIsSearching(true);
    setPhase("selecting");
    setSearchDebugRaw("");

    try {
      const res = await fetch(apiUrl(`/api/search?q=${encodeURIComponent(q.trim())}`));
      const data = await res.json();
      const results = Array.isArray(data?.results)
        ? data.results
        : Array.isArray(data?.items)
          ? data.items
          : [];
      setYoutubeResults(results);
      if (DEBUG_SEARCH) {
        setSearchDebugRaw(JSON.stringify(data).slice(0, 200));
      }
    } catch (error) {
      console.error("Search failed:", error);
      setYoutubeResults([]);
      if (DEBUG_SEARCH) {
        setSearchDebugRaw(String(error));
      }
    } finally {
      setIsSearching(false);
    }
  };

  // Handle video selection - start processing
  const handleSelectVideo = async (video: YouTubeResult) => {
    setSelectedVideo(video);
    setYoutubeOverlayId(video.videoId);

    setSong({
      id: video.videoId,
      title: `${decodeHtml(video.title)} — ${decodeHtml(video.channelTitle)}`,
      videoFile: `${video.videoId}.mp4`,
    });

    setPhase("preparing");
    setPrep(0);

    try {
      const res = await fetch(apiUrl("/api/prepare"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          videoId: video.videoId,
          title: video.title,
          channelTitle: video.channelTitle,
        }),
      });
      const data = await res.json();
      setJobId(data.jobId);
    } catch (error) {
      console.error("Failed to start processing:", error);
    }
  };

  // Start singing instantly from a recent prepared item (no prepare job)
  const singRecent = (item: RecentItem) => {
    setSelectedVideo(null);
    setYoutubeOverlayId(item.videoId);

    setSong({
      id: item.videoId,
      title: `${decodeHtml(item.title || item.videoId)} — ${decodeHtml(item.channelTitle || "Unknown")}`,
      videoFile: `${item.videoId}.mp4`,
    });

    setJobId("recent");
    setJobStatus({
      jobId: "recent",
      status: "complete",
      progress: 100,
      stage: "Ready",
      result: {
        instrumentalUrl: item.instrumentalUrl,
        vocalsUrl: item.vocalsUrl,
      },
    });

    setPhase("countdown");
  };

  // Poll job status
  useEffect(() => {
    if (!jobId || phase !== "preparing") return;

    const pollInterval = setInterval(async () => {
      try {
        const res = await fetch(apiUrl(`/api/prepare/${jobId}/status`));
        const status: JobStatus = await res.json();
        setJobStatus(status);

        if (status.status === "downloading") {
          setPrep(10 + status.progress * 0.4);
        } else if (status.status === "separating") {
          setPrep(50 + status.progress * 0.4);
        } else if (status.status === "complete") {
          setPrep(100);
          clearInterval(pollInterval);
          refreshRecent();
          setTimeout(() => setPhase("countdown"), 500);
        } else if (status.status === "error") {
          clearInterval(pollInterval);
          alert("Processing failed: " + status.error);
          resetToBrowse();
        }
      } catch (error) {
        console.error("Failed to poll status:", error);
      }
    }, 1000);

    return () => clearInterval(pollInterval);
  }, [jobId, phase]);

  // countdown
  useEffect(() => {
    if (phase !== "countdown") return;

    setCd(3);
    setAdIndex(3);

    const id = window.setInterval(() => {
      setCd((c) => {
        if (c <= 1) {
          window.clearInterval(id);
          setPhase("singing");
          return 0;
        }
        return c - 1;
      });
    }, 1000);

    return () => window.clearInterval(id);
  }, [phase]);

  // set audio src when singing (2-track: instrumental + vocals)
  useEffect(() => {
    if (phase !== "singing" || !song) return;

    const inst = instrumentalRef.current;
    const vox = vocalsRef.current;
    if (!inst || !vox) return;

    const instUrl = jobStatus?.result?.instrumentalUrl ? apiUrl(jobStatus.result.instrumentalUrl) : null;

    const voxUrl = jobStatus?.result?.vocalsUrl ? apiUrl(jobStatus.result.vocalsUrl) : null;
    const playbackKey = `${song.id}|${instUrl || song.videoFile}|${voxUrl || ""}|${youtubeOverlayId || ""}`;

    if (playbackInitKeyRef.current === playbackKey) {
      return;
    }

    playbackInitKeyRef.current = playbackKey;

    let cancelled = false;
    let driftTimer: number | null = null;
    let longDriftTimer: number | null = null;
    let rateResetTimer: number | null = null;

    // fallback for local playlist (mp4 has audio)
    if (!instUrl) {
      inst.src = `/karaoke/${encodeURIComponent(song.videoFile)}`;
      vox.src = "";
      inst.currentTime = 0;
      inst.volume = 1.0;
      inst.load();
      Promise.resolve().then(() => {
        if (cancelled) return;
        inst.play().catch(() => {});
        pauseYouTube();
      });
      setVocalGain(0.0);

      fetch(`/lyrics/${encodeURIComponent(song.videoFile)}.lrc`, { cache: "no-store" })
        .then((r) => (r.ok ? r.text() : ""))
        .then((t) => setLyrics(parseLrc(t)))
        .catch(() => setLyrics([]));
      return () => {
        cancelled = true;
      };
    }

    inst.src = instUrl;
    vox.src = voxUrl || "";
    inst.currentTime = 0;
    vox.currentTime = 0;

    inst.volume = 1.0;
    vox.volume = vocalGain;
    vox.playbackRate = 1.0;

    inst.load();
    vox.load();

    (async () => {
      await Promise.all([waitCanPlayThrough(inst), voxUrl ? waitCanPlayThrough(vox) : Promise.resolve()]);
      if (cancelled) return;

      const offsetSec = voxUrl ? await estimateInitialOffsetSec(instUrl, voxUrl) : 0;
      if (cancelled) return;
      const instStart = offsetSec < 0 ? Math.min(-offsetSec, 2) : 0;
      const voxStart = offsetSec > 0 ? Math.min(offsetSec, 2) : 0;

      inst.currentTime = instStart;
      vox.currentTime = voxStart;

      Promise.resolve().then(() => {
        if (cancelled) return;
        inst.play().catch(() => {});
        if (voxUrl) vox.play().catch(() => {});
        playYouTube();
      });

      const driftStart = performance.now();
      driftTimer = window.setInterval(() => {
        if (cancelled) return;
        if (performance.now() - driftStart > 5000) {
          if (driftTimer) window.clearInterval(driftTimer);
          driftTimer = null;
          return;
        }
        if (!voxUrl) return;
        const expected = (inst.currentTime || 0) + offsetSec;
        const delta = expected - (vox.currentTime || 0);
        if (Math.abs(delta) > 0.03) {
          vox.currentTime = Math.max(0, expected);
        }
      }, 50);

      if (voxUrl) {
        longDriftTimer = window.setInterval(() => {
          if (cancelled) return;
          const expected = (inst.currentTime || 0) + offsetSec;
          const delta = expected - (vox.currentTime || 0);
          const abs = Math.abs(delta);
          if (abs > 0.04) {
            vox.playbackRate = 1.0;
            vox.currentTime = Math.max(0, expected);
            return;
          }
          if (abs > 0.008) {
            const nextRate = Math.max(0.995, Math.min(1.005, 1 + delta * 0.04));
            vox.playbackRate = nextRate;
            if (rateResetTimer) {
              window.clearTimeout(rateResetTimer);
            }
            rateResetTimer = window.setTimeout(() => {
              vox.playbackRate = 1.0;
              rateResetTimer = null;
            }, 450);
          } else if (vox.playbackRate !== 1.0) {
            vox.playbackRate = 1.0;
          }
        }, 2000);
      }
    })().catch(() => {
      // ignore sync startup errors
    });

    // YouTube songs use /api/lyrics captions path instead of local lrc.
    if (youtubeOverlayId) {
      setLyrics([]);
    } else {
      fetch(`/lyrics/${encodeURIComponent(song.videoFile)}.lrc`, { cache: "no-store" })
        .then((r) => (r.ok ? r.text() : ""))
        .then((t) => setLyrics(parseLrc(t)))
        .catch(() => setLyrics([]));
    }

    return () => {
      cancelled = true;
      if (driftTimer) window.clearInterval(driftTimer);
      if (longDriftTimer) window.clearInterval(longDriftTimer);
      if (rateResetTimer) window.clearTimeout(rateResetTimer);
      vox.playbackRate = 1.0;
    };
  }, [phase, song, jobStatus, youtubeOverlayId]);

  useEffect(() => {
    if (phase !== "singing") {
      playbackInitKeyRef.current = "";
    }
  }, [phase]);

  // Fetch YouTube captions for lyrics when singing starts.
  useEffect(() => {
    if (phase !== "singing") return;

    if (!youtubeOverlayId) {
      setYtLyrics([]);
      setYtLyricsSource("idle");
      setYtLyricsLoading(false);
      setYtLyricsMode("timed");
      setYtPlainLyrics("");
      setYtLyricCandidates([]);
      setSelectedLyricCandidateId("");
      setCommunityCandidates([]);
      setCommunityBestId("");
      setCommunitySelectedId("");
      setCommunityVoteHint("");
      return;
    }

    let cancelled = false;
    setYtLyricsLoading(true);
    setYtLyricsSource("idle");
    setYtLyricCandidates([]);
    setSelectedLyricCandidateId("");
    setCommunityVoteHint("");

    fetch(apiUrl(`/api/lyrics?videoId=${encodeURIComponent(youtubeOverlayId)}`), {
      cache: "no-store",
    })
      .then((r) => r.json())
      .then((data: LyricsApiResponse) => {
        if (cancelled) return;
        const { candidates: finalCandidates, selectedId } = parseLyricsResponse(data);
        setYtLyricCandidates(finalCandidates);
        setSelectedLyricCandidateId(selectedId);
      })
      .catch(() => {
        if (cancelled) return;
        setYtLyrics([]);
        setYtLyricsSource("none");
        setYtLyricsMode("timed");
        setYtPlainLyrics("");
        setYtLyricCandidates([]);
        setSelectedLyricCandidateId("");
      })
      .finally(() => {
        if (!cancelled) setYtLyricsLoading(false);
      });

    fetch(apiUrl(`/api/lyrics/${encodeURIComponent(youtubeOverlayId)}/candidates`), {
      cache: "no-store",
    })
      .then((r) => r.json())
      .then((data: LyricsCandidatesPayload) => {
        if (cancelled) return;
        const candidates = Array.isArray(data?.candidates) ? data.candidates : [];
        setCommunityCandidates(candidates);
        setCommunityBestId(data?.bestId || "");
        setCommunitySelectedId(data?.bestId || candidates[0]?.id || "");
      })
      .catch(() => {
        if (cancelled) return;
        setCommunityCandidates([]);
        setCommunityBestId("");
        setCommunitySelectedId("");
      });

    return () => {
      cancelled = true;
    };
  }, [phase, youtubeOverlayId]);

  // Apply vocal volume live
  useEffect(() => {
    const vox = vocalsRef.current;
    if (!vox) return;
    vox.volume = vocalGain;
  }, [vocalGain]);

  // Highlight loop (lyrics clock source: instrumental audio currentTime)
  useEffect(() => {
    if (phase !== "singing") return;
    const inst = instrumentalRef.current;
    if (!inst) return;

    if (activeLyrics.length === 0) {
      setActive(-1);
      return;
    }

    let raf = 0;
    const loop = () => {
      setActive(findActiveLyricIndex(activeLyrics, inst.currentTime || 0));
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [phase, activeLyrics]);

  // song end detection (source of truth: instrumental track)
  useEffect(() => {
    if (phase !== "singing") return;
    const inst = instrumentalRef.current;
    if (!inst) return;

    const onEnded = () => {
      inst.pause();
      inst.currentTime = 0;
      const vox = vocalsRef.current;
      if (vox) {
        vox.pause();
        vox.currentTime = 0;
      }
      pauseYouTube();
      setPhase("post_song");
    };

    inst.addEventListener("ended", onEnded);
    return () => inst.removeEventListener("ended", onEnded);
  }, [phase, song, jobStatus]);

  const hasSyncedLyrics = youtubeOverlayId && ytLyricsMode === "timed" && ytLyrics.length > 0;

  const handleCommunitySelect = (candidate: CommunityCandidate) => {
    setCommunitySelectedId(candidate.id);
    if (candidate.type === "external_link" && candidate.url) {
      window.open(candidate.url, "_blank", "noopener,noreferrer");
      setCommunityVoteHint(`Opened: ${candidate.label}`);
      return;
    }
    if (candidate.type === "youtube_captions") {
      setCommunityVoteHint("Using YouTube captions in sync mode.");
    } else {
      setCommunityVoteHint(`Selected: ${candidate.label}`);
    }
  };

  const handleCommunityVote = async () => {
    if (!youtubeOverlayId || !communitySelectedId) return;
    setCommunityVoteBusy(true);
    setCommunityVoteHint("");
    try {
      const r = await fetch(apiUrl(`/api/lyrics/${encodeURIComponent(youtubeOverlayId)}/vote`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidateId: communitySelectedId }),
      });
      const payload: LyricsCandidatesPayload = await r.json();
      const candidates = Array.isArray(payload?.candidates) ? payload.candidates : [];
      setCommunityCandidates(candidates);
      setCommunityBestId(payload?.bestId || "");
      setCommunitySelectedId(payload?.bestId || communitySelectedId);
      setCommunityVoteHint("Thanks. Vote saved.");
    } catch {
      setCommunityVoteHint("Vote failed. Try again.");
    } finally {
      setCommunityVoteBusy(false);
    }
  };

  const toggle = () => {
    const inst = instrumentalRef.current;
    const vox = vocalsRef.current;
    if (!inst || !vox) return;

    if (inst.paused) {
      Promise.resolve().then(() => {
        inst.play().catch(() => {});
        if (vox.src) vox.play().catch(() => {});
        playYouTube();
      });
    } else {
      inst.pause();
      vox.pause();
      pauseYouTube();
    }
  };

  useEffect(() => {
    if (phase !== "singing") return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === "Space") e.preventDefault();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space" || e.code === "Enter") {
        e.preventDefault();
        toggle();
      }
    };

    window.addEventListener("keydown", onKeyDown, { passive: false } as any);
    window.addEventListener("keyup", onKeyUp, { passive: false } as any);
    return () => {
      window.removeEventListener("keydown", onKeyDown as any);
      window.removeEventListener("keyup", onKeyUp as any);
    };
  }, [phase]);

  const resetToBrowse = () => {
    const inst = instrumentalRef.current;
    const vox = vocalsRef.current;

    try {
      inst?.pause();
      if (inst) inst.currentTime = 0;
      if (inst) inst.src = "";
      vox?.pause();
      if (vox) vox.currentTime = 0;
      if (vox) vox.src = "";
      pauseYouTube();
      if (youtubePlayerRef.current && typeof youtubePlayerRef.current.seekTo === "function") {
        youtubePlayerRef.current.seekTo(0, true);
      }
    } catch {}

    setLyrics([]);
    setYtLyrics([]);
    setYtLyricsSource("idle");
    setYtLyricsLoading(false);
    setYtLyricsMode("timed");
    setYtPlainLyrics("");
    setYtLyricCandidates([]);
    setSelectedLyricCandidateId("");
    setActive(-1);
    setSong(null);
    setSelectedVideo(null);
    setYoutubeResults([]);
    setJobId(null);
    setJobStatus(null);
    setPrep(0);
    setQ("");
    setVocalGain(0.0);
    setYoutubeOverlayId(null);
    setLyricsEnabled(true);
    playbackInitKeyRef.current = "";
    setPhase("browse");
  };

  const AdSlot = () => (
    <div
      style={{
        marginTop: 12,
        borderRadius: 10,
        border: "1px dashed #2a2a35",
        padding: 16,
        textAlign: "center",
        fontSize: 13,
        opacity: 0.8,
      }}
    >
      {AD_MESSAGES[adIndex]}
    </div>
  );

  return (
    <main style={{ minHeight: "100vh", padding: 24, background: "#0b0b0f", color: "#f5f5f7" }}>
      <div style={{ maxWidth: 980, margin: "0 auto" }}>
        <div style={{ fontSize: 28, fontWeight: 800 }}>SingSync</div>
        <div style={{ opacity: 0.7, marginBottom: 16 }}>Any song → karaoke instantly (MVP)</div>

        {phase === "browse" && (
          <div style={{ display: "grid", gap: 12 }}>
            <div style={{ display: "flex", gap: 10 }}>
              <input
                style={{
                  flex: 1,
                  height: 44,
                  padding: "0 12px",
                  borderRadius: 12,
                  border: "1px solid #2a2a35",
                  background: "#0f0f15",
                  color: "#f5f5f7",
                  fontSize: 16,
                  outline: "none",
                }}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleSearch()}
                placeholder="Search song on YouTube…"
              />
              <button
                onClick={handleSearch}
                disabled={!q.trim() || isSearching}
                style={{
                  height: 44,
                  padding: "0 20px",
                  borderRadius: 12,
                  border: "none",
                  background: "#2a5bd7",
                  color: "#fff",
                  fontSize: 16,
                  fontWeight: 700,
                  cursor: q.trim() && !isSearching ? "pointer" : "not-allowed",
                  opacity: q.trim() && !isSearching ? 1 : 0.5,
                }}
              >
                {isSearching ? "Searching…" : "Search"}
              </button>
            </div>

            {/* What People Are Singing */}
            <Card>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <div style={{ fontSize: 16, fontWeight: 900 }}>What People Are Singing</div>
                <button
                  onClick={refreshRecent}
                  style={{
                    height: 28,
                    padding: "0 10px",
                    borderRadius: 10,
                    border: "1px solid #2a2a35",
                    background: "#101018",
                    color: "#f5f5f7",
                    fontWeight: 800,
                    cursor: "pointer",
                    opacity: 0.9,
                  }}
                >
                  Refresh
                </button>
              </div>

              <div style={{ fontSize: 12, opacity: 0.65, marginTop: 6 }}>
                A live signal of what people searched and prepared recently.
              </div>

              <div style={{ marginTop: 12, display: "grid", gap: 10 }}>
                {recentLoading ? (
                  <div style={{ opacity: 0.7 }}>Loading…</div>
                ) : recent.length === 0 ? (
                  <div style={{ opacity: 0.7 }}>No recent songs yet. Search something to seed the list.</div>
                ) : (
                  recent.map((it) => (
                    <button
                      key={it.videoId}
                      onClick={() => singRecent(it)}
                      style={{
                        borderRadius: 14,
                        border: "1px solid #1f1f28",
                        background: "#0f0f15",
                        padding: 14,
                        display: "flex",
                        justifyContent: "space-between",
                        cursor: "pointer",
                        color: "#f5f5f7",
                        textAlign: "left",
                      }}
                    >
                      <div style={{ display: "grid", gap: 4 }}>
                        <div style={{ fontWeight: 900 }}>{decodeHtml(it.title || it.videoId)}</div>
                        <div style={{ fontSize: 12, opacity: 0.7 }}>
                          {it.channelTitle && it.channelTitle !== "Unknown" ? it.channelTitle : "Unknown artist"} ·{" "}
                          prepared {formatTimeAgo(it.preparedAt)}
                        </div>
                      </div>
                      <div style={{ fontWeight: 800 }}>Sing</div>
                    </button>
                  ))
                )}
              </div>
            </Card>

            <div style={{ marginTop: 6 }}>
              <div style={{ fontSize: 14, opacity: 0.6, marginBottom: 10 }}>Or choose from local playlist:</div>
              <div style={{ display: "grid", gap: 10 }}>
                {filtered.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => {
                      setSong(s);
                      setYoutubeOverlayId(null);
                      if (s.instrumentalUrl) {
                        setSelectedVideo(null);
                        setJobId("local");
                        setJobStatus({
                          jobId: "local",
                          status: "complete",
                          progress: 100,
                          stage: "Ready",
                          result: {
                            instrumentalUrl: s.instrumentalUrl,
                            vocalsUrl: s.vocalsUrl || "",
                          },
                        });
                        setPhase("countdown");
                        return;
                      }

                      alert("No local karaoke audio found for this track.");
                    }}
                    style={{
                      borderRadius: 14,
                      border: "1px solid #1f1f28",
                      background: "#101018",
                      padding: 14,
                      display: "flex",
                      justifyContent: "space-between",
                      cursor: "pointer",
                      color: "#f5f5f7",
                      textAlign: "left",
                    }}
                  >
                    <div style={{ display: "grid", gap: 4 }}>
                      <div style={{ fontWeight: 900 }}>{decodeHtml(s.title)}</div>
                      <div style={{ fontSize: 12, opacity: 0.6 }}>
                        {s.channelTitle ? `${s.channelTitle} · ` : ""}
                        {s.videoFile}
                      </div>
                    </div>
                    <div style={{ fontWeight: 800 }}>Sing</div>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {phase === "selecting" && (
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
              <button
                onClick={() => setPhase("browse")}
                style={{
                  height: 36,
                  padding: "0 12px",
                  borderRadius: 12,
                  border: "1px solid #2a2a35",
                  background: "#101018",
                  color: "#f5f5f7",
                  fontWeight: 800,
                  cursor: "pointer",
                }}
              >
                ← Back
              </button>
              <div style={{ fontWeight: 900 }}>Search results for "{q}"</div>
            </div>

            {isSearching ? (
              <Card>
                <div style={{ textAlign: "center", padding: 40 }}>
                  <div style={{ fontSize: 18, marginBottom: 10 }}>Searching YouTube…</div>
                  <div style={{ opacity: 0.6 }}>Finding the best karaoke versions</div>
                </div>
              </Card>
            ) : youtubeResults.length === 0 ? (
              <div style={{ display: "grid", gap: 10 }}>
                {DEBUG_SEARCH && (
                  <Card>
                    <div style={{ fontSize: 12, opacity: 0.85 }}>debug: results.length = {youtubeResults.length}</div>
                    {youtubeResults.length === 0 && (
                      <div style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>
                        debug raw: {searchDebugRaw || "(empty)"}
                      </div>
                    )}
                  </Card>
                )}
                <Card>
                  <div style={{ textAlign: "center", padding: 40 }}>
                    <div style={{ fontSize: 18, marginBottom: 10 }}>No results found</div>
                    <div style={{ opacity: 0.6 }}>Try a different search term</div>
                  </div>
                </Card>
              </div>
            ) : (
              <div style={{ display: "grid", gap: 12 }}>
                {DEBUG_SEARCH && (
                  <Card>
                    <div style={{ fontSize: 12, opacity: 0.85 }}>debug: results.length = {youtubeResults.length}</div>
                  </Card>
                )}
                {youtubeResults.map((video) => (
                  <button
                    key={video.videoId}
                    onClick={() => handleSelectVideo(video)}
                    style={{
                      borderRadius: 14,
                      border: "1px solid #1f1f28",
                      background: "#101018",
                      padding: 14,
                      display: "flex",
                      gap: 12,
                      alignItems: "center",
                      cursor: "pointer",
                      color: "#f5f5f7",
                      textAlign: "left",
                    }}
                  >
                    <img
                      src={video.thumbnail}
                      alt={video.title}
                      style={{ width: 96, height: 54, borderRadius: 10, objectFit: "cover" }}
                    />
                    <div style={{ flex: 1, display: "grid", gap: 4 }}>
                      <div style={{ fontWeight: 900, lineHeight: 1.2 }}>{decodeHtml(video.title)}</div>
                      <div style={{ fontSize: 12, opacity: 0.7 }}>
                        {decodeHtml(video.channelTitle)} · {video.duration}
                      </div>
                    </div>
                    <div style={{ fontWeight: 900, opacity: 0.9 }}>Select</div>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {phase === "preparing" && (
          <Card>
            <div style={{ display: "grid", gap: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <div style={{ fontSize: 18, fontWeight: 900 }}>
                  Preparing karaoke{selectedVideo ? `: ${decodeHtml(selectedVideo.title)}` : ""}…
                </div>
                <div style={{ fontSize: 12, opacity: 0.7 }}>{Math.round(prep)}%</div>
              </div>

              <div
                style={{
                  height: 10,
                  borderRadius: 999,
                  background: "#181824",
                  overflow: "hidden",
                }}
              >
                <div style={{ height: "100%", width: `${prep}%`, background: "#2a5bd7" }} />
              </div>

              <div style={{ fontSize: 13, opacity: 0.75 }}>{jobStatus?.stage ?? "Preparing…"}</div>

              <AdSlot />
            </div>
          </Card>
        )}

        {phase === "countdown" && (
          <Card>
            <div style={{ textAlign: "center", padding: 40 }}>
              <div style={{ fontSize: 54, fontWeight: 900 }}>{cd}</div>
              <div style={{ opacity: 0.7, marginTop: 8 }}>Get ready…</div>
              <AdSlot />
            </div>
          </Card>
        )}

        {phase === "singing" && (
          <div style={{ display: "grid", gap: 12 }}>
            <Card>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div style={{ fontWeight: 900 }}>{song ? decodeHtml(song.title) : ""}</div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    onClick={() => setLyricsEnabled((v) => !v)}
                    style={{
                      height: 36,
                      padding: "0 12px",
                      borderRadius: 12,
                      border: "1px solid #2a2a35",
                      background: lyricsEnabled ? "#1a2b5a" : "#101018",
                      color: "#f5f5f7",
                      fontWeight: 800,
                      cursor: "pointer",
                    }}
                  >
                    Lyrics {lyricsEnabled ? "ON" : "OFF"}
                  </button>

                  <button
                    onClick={toggle}
                    style={{
                      height: 36,
                      padding: "0 12px",
                      borderRadius: 12,
                      border: "1px solid #2a2a35",
                      background: "#101018",
                      color: "#f5f5f7",
                      fontWeight: 800,
                      cursor: "pointer",
                    }}
                  >
                    Play/Pause (Space)
                  </button>
                  <button
                    onClick={resetToBrowse}
                    style={{
                      height: 36,
                      padding: "0 12px",
                      borderRadius: 12,
                      border: "1px solid #2a2a35",
                      background: "#101018",
                      color: "#f5f5f7",
                      fontWeight: 800,
                      cursor: "pointer",
                    }}
                  >
                    End
                  </button>
                </div>
              </div>

              {/* YouTube Video Overlay (muted, IFrame API controlled) */}
              <div style={{ marginTop: 12, borderRadius: 12, overflow: "hidden", background: "#000" }}>
                <div style={{ position: "relative", width: "100%", paddingTop: "56.25%" }}>
                  {youtubeOverlayId ? (
                    <div
                      ref={youtubeHostRef}
                      style={{
                        position: "absolute",
                        top: 0,
                        left: 0,
                        width: "100%",
                        height: "100%",
                      }}
                    />
                  ) : (
                    <div
                      style={{
                        position: "absolute",
                        top: 0,
                        left: 0,
                        width: "100%",
                        height: "100%",
                        display: "grid",
                        placeItems: "center",
                        opacity: 0.7,
                        fontSize: 13,
                      }}
                    >
                      No video overlay (local file mode)
                    </div>
                  )}
                </div>
              </div>

              {/* Audio mixing */}
              <div style={{ marginTop: 12, borderRadius: 12, background: "#000", padding: 12 }}>
                <audio ref={instrumentalRef} />
                <audio ref={vocalsRef} />

                <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 8 }}>
                  <div style={{ fontSize: 12, opacity: 0.7, width: 120 }}>Vocal guide</div>

                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={Math.round(vocalGain * 100)}
                    onChange={(e) => setVocalGain(Number(e.target.value) / 100)}
                    style={{ flex: 1 }}
                  />

                  <div style={{ fontSize: 12, opacity: 0.7, width: 50, textAlign: "right" }}>
                    {Math.round(vocalGain * 100)}%
                  </div>
                </div>

                <div style={{ fontSize: 12, opacity: 0.55, marginTop: 8 }}>
                  Tip: video is muted; audio comes from the karaoke mix.
                </div>
              </div>

              <div style={{ marginTop: 10, fontSize: 12, opacity: 0.65 }}>
                Tip: Space/Enter toggles play/pause (audio).
              </div>

              <div
                style={{
                  marginTop: 14,
                  borderRadius: 12,
                  border: "1px solid #1f1f28",
                  background: "#0c0c12",
                  minHeight: 170,
                  padding: 16,
                  display: "grid",
                  placeItems: "center",
                  textAlign: "center",
                }}
              >
                {youtubeOverlayId && (
                  <LyricsPicker
                    candidates={ytLyricCandidates}
                    selectedId={selectedLyricCandidateId}
                    onSelect={setSelectedLyricCandidateId}
                  />
                )}

                {youtubeOverlayId && !hasSyncedLyrics && (
                  <LyricsVotingPanel
                    candidates={communityCandidates}
                    selectedId={communitySelectedId || communityBestId}
                    onSelect={handleCommunitySelect}
                    onVote={handleCommunityVote}
                    voteBusy={communityVoteBusy}
                    voteHint={communityVoteHint}
                  />
                )}

                {!lyricsEnabled ? (
                  <div style={{ fontSize: 14, opacity: 0.7 }}>Lyrics are off.</div>
                ) : ytLyricsLoading && youtubeOverlayId ? (
                  <div style={{ fontSize: 14, opacity: 0.7 }}>Loading lyrics…</div>
                ) : ytLyricsMode === "plain" && ytPlainLyrics.trim().length > 0 ? (
                  <div
                    style={{
                      width: "100%",
                      maxHeight: 260,
                      overflow: "auto",
                      textAlign: "left",
                      whiteSpace: "pre-wrap",
                      lineHeight: 1.5,
                      fontSize: 20,
                      fontWeight: 700,
                    }}
                  >
                    {ytPlainLyrics}
                  </div>
                ) : activeLyrics.length === 0 ? (
                  <div style={{ fontSize: 14, opacity: 0.75 }}>
                    {youtubeOverlayId && ytLyricsSource === "none"
                      ? "No synced captions available. Try Lyrics 1/2/3 sources above."
                      : "No lyrics available."}
                  </div>
                ) : active < 0 ? (
                  <div style={{ width: "100%", display: "grid", gap: 10 }}>
                    <div style={{ fontSize: 14, opacity: 0.7 }}>
                      Lyrics start in about {secondsUntilFirstLyric}s
                    </div>
                    <div style={{ fontSize: 26, fontWeight: 800, lineHeight: 1.3, opacity: 0.85 }}>
                      {activeLyrics[0]?.text || "..."}
                    </div>
                  </div>
                ) : (
                  <div style={{ width: "100%", display: "grid", gap: 10 }}>
                    <div style={{ fontSize: 20, opacity: 0.45, minHeight: 28 }}>{prevLine || " "}</div>
                    <div style={{ fontSize: 42, fontWeight: 900, lineHeight: 1.2, minHeight: 52 }}>
                      {currentLine || "..."}
                    </div>
                    <div style={{ fontSize: 20, opacity: 0.45, minHeight: 28 }}>{nextLine || " "}</div>
                  </div>
                )}
              </div>
            </Card>
          </div>
        )}

        {phase === "post_song" && (
          <Card>
            <div style={{ textAlign: "center", padding: 40, display: "grid", gap: 12 }}>
              <div style={{ fontSize: 28, fontWeight: 900 }}>Song finished</div>
              <div style={{ opacity: 0.7, fontSize: 14 }}>Ready for the next one?</div>

              <div style={{ display: "flex", gap: 10, justifyContent: "center", marginTop: 8 }}>
                <button
                  onClick={resetToBrowse}
                  style={{
                    height: 44,
                    padding: "0 20px",
                    borderRadius: 12,
                    border: "none",
                    background: "#2a5bd7",
                    color: "#fff",
                    fontSize: 16,
                    fontWeight: 800,
                    cursor: "pointer",
                  }}
                >
                  Sing another
                </button>

                <button
                  onClick={() => {
                    const inst = instrumentalRef.current;
                    const vox = vocalsRef.current;
                    if (inst) {
                      inst.pause();
                      inst.currentTime = 0;
                    }
                    if (vox) {
                      vox.pause();
                      vox.currentTime = 0;
                    }
                    setPhase("countdown");
                  }}
                  style={{
                    height: 44,
                    padding: "0 20px",
                    borderRadius: 12,
                    border: "1px solid #2a2a35",
                    background: "#101018",
                    color: "#f5f5f7",
                    fontSize: 16,
                    fontWeight: 800,
                    cursor: "pointer",
                  }}
                >
                  Replay
                </button>
              </div>

              <div
                style={{
                  marginTop: 12,
                  textAlign: "left",
                  borderRadius: 12,
                  border: "1px solid #1f1f28",
                  background: "#0f0f15",
                  padding: 12,
                }}
              >
                <div style={{ fontWeight: 900, fontSize: 16, marginBottom: 10 }}>Up next</div>
                <div style={{ display: "grid", gap: 8 }}>
                  {upNext.length === 0 ? (
                    <div style={{ opacity: 0.7, fontSize: 13 }}>No recommendations yet.</div>
                  ) : (
                    upNext.map((it) => (
                      <button
                        key={`post-${it.videoId}`}
                        onClick={() => singRecent(it)}
                        style={{
                          borderRadius: 12,
                          border: "1px solid #1f1f28",
                          background: "#101018",
                          padding: 12,
                          display: "flex",
                          justifyContent: "space-between",
                          cursor: "pointer",
                          color: "#f5f5f7",
                          textAlign: "left",
                        }}
                      >
                        <div style={{ display: "grid", gap: 4 }}>
                          <div style={{ fontWeight: 900 }}>{decodeHtml(it.title || it.videoId)}</div>
                          <div style={{ fontSize: 12, opacity: 0.7 }}>
                            {it.channelTitle && it.channelTitle !== "Unknown" ? it.channelTitle : "Unknown artist"} ·{" "}
                            prepared {formatTimeAgo(it.preparedAt)}
                          </div>
                        </div>
                        <div style={{ fontWeight: 800 }}>Sing</div>
                      </button>
                    ))
                  )}
                </div>
              </div>

              <div
                style={{
                  marginTop: 8,
                  borderRadius: 10,
                  border: "1px dashed #2a2a35",
                  padding: 16,
                  textAlign: "center",
                  fontSize: 13,
                  opacity: 0.85,
                }}
              >
                <div style={{ fontWeight: 800 }}>Ad (Post-song)</div>
                <div style={{ marginTop: 6, opacity: 0.8 }}>This is where a post-song ad will appear.</div>
              </div>
            </div>
          </Card>
        )}
      </div>
    </main>
  );
}
