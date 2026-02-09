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
  if (candidates.length <= 1) return null;

  return (
    <div
      style={{
        width: "100%",
        display: "flex",
        gap: 8,
        flexWrap: "wrap",
        justifyContent: "center",
        marginBottom: 10,
      }}
    >
      {candidates.map((c, idx) => {
        const isActive = selectedId === c.id;
        const modeLabel = c.mode === "timed" ? "Synced" : "Full";

        return (
          <button
            key={`lyric-candidate-${c.id}`}
            onClick={() => onSelect(c.id)}
            aria-pressed={isActive}
            style={{
              height: 30,
              padding: "0 10px",
              borderRadius: 10,
              border: "1px solid #2a2a35",
              background: isActive ? "#1a2b5a" : "#101018",
              color: "#f5f5f7",
              fontSize: 12,
              fontWeight: 800,
              cursor: "pointer",
            }}
            title={c.label}
          >
            {idx + 1}. {modeLabel} · {c.source}
          </button>
        );
      })}
    </div>
  );
}
