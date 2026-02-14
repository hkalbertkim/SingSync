import { generateAndPersistRoughLineTimings } from "../services/syncLineTiming.js";
import { syncPath } from "../services/syncStore.js";

function usage(): void {
  console.log("Usage: (cd server && npm exec tsx src/scripts/extractLineTimings.ts <videoId> [--force])");
}

async function main(): Promise<void> {
  const videoId = process.argv[2];
  const force = process.argv.includes("--force");

  if (!videoId) {
    usage();
    process.exit(1);
  }

  const result = generateAndPersistRoughLineTimings(videoId, { force });

  console.log(
    JSON.stringify(
      {
        videoId,
        syncPath: syncPath(videoId),
        mode: result.mode,
        line_timings: result.lineTimings.length,
        segments: result.segmentCount,
        used_lyrics_lines: result.usedLyricsCount,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error("[extractLineTimings] Failed:", error);
  process.exit(1);
});
