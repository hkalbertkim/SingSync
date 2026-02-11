# HKA-70 — Worker stability follow-up

Goal
- Improve worker reliability and reduce stuck/stale jobs.

Planned
- Add lease/lock to job.json (processing_download/processing_separation + leaseUntil)
- Retry policy for transient failures (network/yt-dlp)
- Better logging and health checks

Acceptance
- No duplicate processing for same videoId
- Clear visibility into worker state
2026-02-11T15:03:45Z linear sync test
