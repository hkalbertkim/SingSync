"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type Song = { id: string; title: string; videoFile: string };
type Phase = "browse" | "preparing" | "countdown" | "singing";
type LyricLine = { t: number; text: string };

function parseLrc(text: string): LyricLine[] {
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

function findIdx(lines: LyricLine[], t: number) {
  let i = -1;
  for (let k = 0; k < lines.length; k++) {
    if (lines[k].t <= t) i = k;
    else break;
  }
  return i;
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

export default function Page() {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const [phase, setPhase] = useState<Phase>("browse");
  const [songs, setSongs] = useState<Song[]>([]);
  const [q, setQ] = useState("");
  const [song, setSong] = useState<Song | null>(null);

  const [prep, setPrep] = useState(0);
  const [cd, setCd] = useState(3);

  const [lyrics, setLyrics] = useState<LyricLine[]>([]);
  const [active, setActive] = useState(-1);

  // ✅ ad rotation dummy (replace with AdSense later)
  const [adIndex, setAdIndex] = useState(0);
  const AD_MESSAGES = [
    "Ad #1 (Preparing)",
    "Ad #2 (Preparing)",
    "Ad #3 (Preparing)",
    "Ad #4 (Countdown)",
  ];

  // fetch songs
  useEffect(() => {
    fetch("http://localhost:4000/api/songs", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => setSongs(Array.isArray(d) ? d : []))
      .catch(() => setSongs([]));
  }, []);

  const filtered = useMemo(() => {
    const qq = q.toLowerCase();
    return songs.filter((s) => s.title.toLowerCase().includes(qq));
  }, [songs, q]);

  // preparing (5s) + ad rotate every 2s
  useEffect(() => {
    if (phase !== "preparing") return;

    setPrep(0);
    setAdIndex(0);

    const t0 = Date.now();

    const adTimer = window.setInterval(() => {
      setAdIndex((i) => Math.min(2, i + 1)); // rotate within preparing ads (0..2)
    }, 2000);

    const progTimer = window.setInterval(() => {
      const p = Math.min(100, ((Date.now() - t0) / 5000) * 100);
      setPrep(p);
      if (p >= 100) {
        window.clearInterval(progTimer);
        window.clearInterval(adTimer);
        setPhase("countdown");
      }
    }, 100);

    return () => {
      window.clearInterval(progTimer);
      window.clearInterval(adTimer);
    };
  }, [phase]);

  // countdown (3-2-1) + ad switches once at start to "n+1"
  useEffect(() => {
    if (phase !== "countdown") return;

    setCd(3);
    setAdIndex(3); // Ad #4 (Countdown)

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

  // set video src + load lyrics when singing view mounts
  useEffect(() => {
    if (phase !== "singing" || !song) return;

    const v = videoRef.current;
    if (!v) return;

    v.controls = false;
    v.playsInline = true;
    v.muted = false;

    v.src = `/karaoke/${encodeURIComponent(song.videoFile)}`;
    v.currentTime = 0;

    try {
      v.load();
    } catch {}

    v.play().catch(() => {});

    fetch(`/lyrics/${encodeURIComponent(song.videoFile)}.lrc`, { cache: "no-store" })
      .then((r) => (r.ok ? r.text() : ""))
      .then((t) => setLyrics(parseLrc(t)))
      .catch(() => setLyrics([]));
  }, [phase, song]);

  // highlight loop
  useEffect(() => {
    if (phase !== "singing" || lyrics.length === 0) return;
    const v = videoRef.current;
    if (!v) return;

    let raf = 0;
    const loop = () => {
      setActive(findIdx(lyrics, v.currentTime || 0));
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [phase, lyrics]);

  // play/pause toggle
  const toggle = () => {
    const v = videoRef.current;
    if (!v) return;
    v.paused ? v.play() : v.pause();
  };

  // keyboard toggle
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
    const v = videoRef.current;
    try {
      v?.pause();
      if (v) v.src = "";
    } catch {}
    setLyrics([]);
    setActive(-1);
    setSong(null);
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
            <input
              style={{
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
              placeholder="Search song…"
            />
            <div style={{ display: "grid", gap: 10 }}>
              {filtered.map((s) => (
                <button
                  key={s.id}
                  onClick={() => {
                    setSong(s);
                    setPhase("preparing");
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
                    <div style={{ fontWeight: 900 }}>{s.title}</div>
                    <div style={{ fontSize: 12, opacity: 0.6 }}>{s.videoFile}</div>
                  </div>
                  <div style={{ fontWeight: 800 }}>Sing</div>
                </button>
              ))}
            </div>
          </div>
        )}

        {(phase === "preparing" || phase === "countdown") && (
          <Card>
            <div style={{ fontWeight: 900 }}>Preparing karaoke…</div>
            {/* ✅ ad slot shown in preparing + countdown */}
            <AdSlot />
            <div style={{ marginTop: 14, height: 10, borderRadius: 999, background: "#12121a", overflow: "hidden" }}>
              <div style={{ width: `${prep}%`, height: "100%", background: "#2a5bd7" }} />
            </div>

            {phase === "countdown" && (
              <div style={{ marginTop: 14, textAlign: "center", fontSize: 64, fontWeight: 900 }}>{cd}</div>
            )}
          </Card>
        )}

        {phase === "singing" && song && (
          <div style={{ display: "grid", gridTemplateColumns: "1.4fr 0.6fr", gap: 12 }}>
            <div style={{ borderRadius: 14, border: "1px solid #1f1f28", background: "#101018", padding: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                <div style={{ fontWeight: 900 }}>{song.title}</div>
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
                  Exit
                </button>
              </div>

              <div style={{ position: "relative" }}>
                <video ref={videoRef} style={{ width: "100%", background: "#000", borderRadius: 14 }} playsInline />
                <div onClick={toggle} style={{ position: "absolute", inset: 0, cursor: "pointer", borderRadius: 14 }} />
              </div>

              <div style={{ marginTop: 10, fontSize: 12, opacity: 0.7 }}>Space/Enter/Click: Play/Pause</div>
            </div>

            <div style={{ borderRadius: 14, border: "1px solid #1f1f28", background: "#101018", padding: 12 }}>
              <div style={{ fontWeight: 900, marginBottom: 10 }}>Lyrics</div>
              {lyrics.length === 0 ? (
                <div style={{ opacity: 0.7 }}>Lyrics not available.</div>
              ) : (
                <div style={{ display: "grid", gap: 8 }}>
                  {lyrics.map((l, i) => (
                    <div key={i} style={{ fontWeight: i === active ? 900 : 600, color: i === active ? "#6ea8ff" : "#aaa" }}>
                      {l.text || "(…)"}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
