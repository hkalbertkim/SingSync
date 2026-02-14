import path from "node:path";
import fs from "node:fs";

import { ensureMarkersForVideo } from "../services/syncMarkers.js";
import { syncPath } from "../services/syncStore.js";

function usage(): void {
  console.log("Usage: (cd server && npm exec tsx src/scripts/extractSyncMarkers.ts <videoId> [--force])");
}

async function main(): Promise<void> {
  const videoId = process.argv[2];
  const force = process.argv.includes("--force");

  if (!videoId) {
    usage();
    process.exit(1);
  }

  const vocalsPath = path.join(process.cwd(), "cache", videoId, "vocals.wav");
  if (!fs.existsSync(vocalsPath)) {
    throw new Error(`Missing vocals stem: ${vocalsPath}`);
  }

  const markers = ensureMarkersForVideo(videoId, vocalsPath, { force });

  console.log(
    JSON.stringify(
      {
        videoId,
        syncPath: syncPath(videoId),
        vocal_onsets: markers.vocal_onsets.length,
        phrase_gaps: markers.phrase_gaps.length,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error("[extractSyncMarkers] Failed:", error);
  process.exit(1);
});
