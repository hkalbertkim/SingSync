import { applyCorrection } from "../services/syncCorrections.js";
import { loadSync, syncPath } from "../services/syncStore.js";

function usage(): void {
  console.log(
    "Usage: (cd server && npm exec tsx src/scripts/applyCorrection.ts <videoId> <line_id> <new_start_ms>)"
  );
}

async function main(): Promise<void> {
  const videoId = process.argv[2];
  const lineId = process.argv[3];
  const newStartMs = Number(process.argv[4]);

  if (!videoId || !lineId || !Number.isFinite(newStartMs) || newStartMs < 0) {
    usage();
    process.exit(1);
  }

  const before = loadSync(videoId).alignment.line_timings.find((line) => line.line_id === lineId) || null;
  const result = applyCorrection(videoId, lineId, newStartMs, "cli", "127.0.0.1");
  const after = loadSync(videoId).alignment.line_timings.find((line) => line.line_id === lineId) || null;

  console.log(
    JSON.stringify(
      {
        videoId,
        syncPath: syncPath(videoId),
        line_id: lineId,
        before,
        after,
        votes: result.votes,
        median_offset_ms: result.median_offset_ms,
        applied: result.applied,
        updated_start_ms: result.updated_start_ms,
        updated_end_ms: result.updated_end_ms,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error("[applyCorrection] Failed:", error);
  process.exit(1);
});
