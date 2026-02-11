"use client";

import type { LyricsCandidateApi } from "../lib/lyrics";

interface LyricsPickerProps {
  /** Available lyric candidates (only rendered when length > 1). */
  candidates: LyricsCandidateApi[];
  /** Currently selected candidate id. */
  selectedId: string;
  /** Called when the user picks a different candidate. */
  onSelect: (id: string) => void;
}

/**
 * Horizontal row of lyric-source buttons shown during singing when the
 * backend returns more than one candidate set of lyrics.
 *
 * Hidden automatically when there is 0 or 1 candidate so callers don't
 * need to conditionally render.
 */
export default function LyricsPicker({ candidates, selectedId, onSelect }: LyricsPickerProps) {
  if (candidates.length === 0) return null;
  const top = candidates.slice(0, 3);

  return (
    <div
      style={{
        width: "100%",
        display: "grid",
        gridTemplateColumns: "1fr",
        gap: 10,
        marginBottom: 10,
      }}
    >
      <div style={{ fontSize: 12, opacity: 0.7 }}>Lyrics candidates (pick best sync)</div>
      <div style={{ display: "flex", gap: 8, width: "100%" }}>
      {top.map((c, idx) => {
        const isActive = selectedId === c.id;
        const modeLabel = c.mode === "timed" ? "Synced" : "Full";
        const preview =
          c.mode === "timed"
            ? c.lines.slice(0, 2).map((line) => line.text).join(" / ")
            : (c.plainLyrics || "").slice(0, 72);

        return (
          <button
            key={`lyric-candidate-${c.id}`}
            onClick={() => onSelect(c.id)}
            aria-pressed={isActive}
            style={{
              flex: isActive ? 5 : 2,
              minWidth: 0,
              minHeight: 88,
              padding: "10px 12px",
              borderRadius: 10,
              border: "1px solid #2a2a35",
              background: isActive ? "#1a2b5a" : "#101018",
              color: "#f5f5f7",
              fontSize: isActive ? 14 : 12,
              fontWeight: isActive ? 900 : 700,
              textAlign: "left",
              cursor: "pointer",
              opacity: isActive ? 1 : 0.45,
              transition: "all 120ms ease",
            }}
            title={c.label}
          >
            <div>{idx + 1}. {modeLabel} · {c.source}</div>
            <div style={{ fontSize: 11, opacity: 0.78, marginTop: 6, whiteSpace: "normal", lineHeight: 1.25 }}>
              {c.label}
            </div>
            <div
              style={{
                fontSize: isActive ? 12 : 11,
                opacity: 0.72,
                marginTop: 6,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {preview || "(no preview)"}
            </div>
          </button>
        );
      })}
      </div>
    </div>
  );
}
