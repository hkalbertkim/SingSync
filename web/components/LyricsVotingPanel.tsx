"use client";

export type CommunityCandidate = {
  id: string;
  type: "youtube_captions" | "external_link" | "user_paste";
  label: string;
  url: string | null;
  votes: number;
};

type Props = {
  candidates: CommunityCandidate[];
  selectedId: string;
  onSelect: (candidate: CommunityCandidate) => void;
  onVote: () => void;
  voteBusy: boolean;
  voteHint?: string;
};

export default function LyricsVotingPanel({
  candidates,
  selectedId,
  onSelect,
  onVote,
  voteBusy,
  voteHint,
}: Props) {
  if (candidates.length === 0) return null;

  return (
    <div style={{ width: "100%", display: "grid", gap: 10, marginBottom: 12 }}>
      <div style={{ display: "grid", gap: 8 }}>
        {candidates.map((c, idx) => {
          const active = selectedId === c.id;
          return (
            <button
              key={`community-lyrics-${c.id}`}
              onClick={() => onSelect(c)}
              style={{
                borderRadius: 10,
                border: "1px solid #2a2a35",
                background: active ? "#1a2b5a" : "#101018",
                color: "#f5f5f7",
                textAlign: "left",
                padding: 10,
                cursor: "pointer",
              }}
            >
              <div style={{ fontSize: 13, fontWeight: 800 }}>Lyrics {idx + 1}</div>
              <div style={{ fontSize: 12, opacity: 0.72, marginTop: 2 }}>
                {c.label} · votes {c.votes}
              </div>
            </button>
          );
        })}
      </div>

      <div style={{ display: "flex", justifyContent: "center" }}>
        <button
          onClick={onVote}
          disabled={voteBusy || !selectedId}
          style={{
            height: 34,
            padding: "0 12px",
            borderRadius: 10,
            border: "1px solid #2a2a35",
            background: "#101018",
            color: "#f5f5f7",
            fontSize: 12,
            fontWeight: 800,
            cursor: voteBusy ? "not-allowed" : "pointer",
            opacity: voteBusy ? 0.6 : 1,
          }}
        >
          {voteBusy ? "Voting..." : "Vote this version"}
        </button>
      </div>

      {voteHint ? <div style={{ fontSize: 12, opacity: 0.7, textAlign: "center" }}>{voteHint}</div> : null}
    </div>
  );
}
