# SingSync MVP – Development Report, Roadmap, and User Validation Plan

This document consolidates **everything developed so far**, including detailed technical implementation, product decisions, monetization logic, and the forward roadmap. It is intended to be downloadable later as a Markdown file and used as:
- an internal execution record
- a product/UX validation report
- a future investor / partner briefing document

---

## 1. Project Overview

**Project Name:** SingSync  
**Tagline:** Any song → karaoke instantly

SingSync is a **web‑based karaoke media platform** that removes friction between the intent to sing and the act of singing.

SingSync is deliberately **not**:
- an AI product
- a music streaming service
- a vocal training or scoring app
- a karaoke hardware replacement

SingSync **is**:
> a place where people sing.

The product’s success is **not measured by accuracy**, but by:
- how quickly users start singing
- how many songs they sing per session
- whether they want to sing again

---

## 2. Product Doctrine (Non‑Negotiable)

These rules guided every technical and UX decision:

• Singing flow must never be interrupted  
• Audio playback must never stop for ads  
• Lyrics must never be blocked or obscured  
• No forced login before the first song  
• No setup complexity

If a feature violates any of the above, it is rejected or deferred.

---

## 3. Implemented Core UX Flow (MVP)

The following end‑to‑end flow is fully implemented and stable:

1. Open SingSync
2. Search song (current MVP: local playlist)
3. Select a song
4. **Preparing karaoke…** (≈5 seconds)
   – stream preparation
   – lyrics loading
   – cache checks
   – **ad slot allowed here**
5. **Countdown (3‑2‑1)**
   – ad slot may remain visible
6. **Singing Mode**
   – karaoke‑ready video playback
   – lyrics panel with line highlighting
   – keyboard / click controls
   – **no ads, ever**
7. Exit → next song

This flow defines SingSync v1 and is intentionally locked.

---

## 4. Technical Architecture (Current)

### 4.1 Frontend

• Framework: Next.js (App Router)
• Client‑side state machine:
  – browse → preparing → countdown → singing

### 4.2 Backend

• Node.js + Express
• Current API:
  – `GET /api/songs` → local playlist

### 4.3 Media Handling

• Video: MP4 (karaoke‑ready assets)
• Lyrics: LRC (timestamp‑based)

### 4.4 Input Controls

• Keyboard:
  – Space / Enter → play / pause toggle
• Mouse:
  – click overlay on video → toggle

Native browser controls are fully disabled to avoid interference.

---

## 5. Lyrics System (LRC)

### Current Behavior

• LRC files are loaded from `/public/lyrics/<videoFile>.lrc`
• Lyrics are parsed into `(timestamp, text)` pairs
• Active lyric line is calculated from `video.currentTime`
• Highlighted line updates via `requestAnimationFrame`
• Auto‑scroll keeps the active line centered

### Important Design Choice

Lyrics timing is **independent content**.

If LRC is imperfectly aligned with the video, drift is accepted at MVP stage. Precision is a **later optimization**, not a launch blocker.

---

## 6. Ads & Monetization Doctrine (MVP)

### Allowed Ad Zones

• Preparing karaoke screen (highest value)
• Countdown screen (continuation)
• Post‑song screen (future)

### Forbidden Ads

• Any ads during singing
• Any ad blocking lyrics or video
• Any audio ads
• Any forced interaction mid‑song

### Implemented Behavior

• Preparing: rotating ad slot (dummy)
• Countdown: final ad slot (dummy)
• Singing: zero ads

This establishes a clean **per‑song monetization model** without UX damage.

---

## 7. Major Technical Problems Solved

### 7.1 Browser Autoplay Restrictions

Problem:
• Autoplay with sound is blocked in most browsers

Solution:
• Best‑effort autoplay
• Guaranteed manual start via Space / Enter / Click

---

### 7.2 videoRef Race Conditions

Problem:
• `videoRef` was null when phase switched to singing

Solution:
• All `video.src` assignment moved into `useEffect(phase === "singing")`

---

### 7.3 Space Bar Not Working Reliably

Problem:
• Space triggers browser scroll / button focus

Solution:
• `keydown` → preventDefault
• actual toggle on `keyup`
• click‑capture overlay above video

---

### 7.4 Highlight Performance

Problem:
• setInterval caused jitter

Solution:
• `requestAnimationFrame` loop synced to video time

---

## 8. Current GitHub State

• Repository: `SingSync`
• Branch: `main`
• Status: MVP fully pushed
• Large dev‑only files committed with warnings (acceptable for now)

GitHub now acts as the canonical execution log.

---

## 9. Roadmap (Execution‑Driven)

### Phase 1 — User Validation (Now)

Goal: prove people actually want to sing this way.

Key metrics:
• time to first song
• songs per session
• song completion rate
• repeat usage

---

### Phase 2 — Search + Preview Expansion

Planned behavior:
• Multiple results per song query
• Thumbnail + metadata
• Inline preview playback (10–20s)
• One preview at a time
• Explicit “Sing this version” selection

Backend abstraction:
• `GET /api/search?q=`
• `POST /api/prepare`

Search source can be swapped later without touching UX.

---

### Phase 3 — Preparation Pipeline

• Job‑based processing
• Cache hit → instant playback
• Cache miss → progress UI
• Persistent mapping:
  sourceKey → karaoke asset + lyrics

---

### Phase 4 — Monetization

• Replace dummy ad slots with AdSense
• Optional premium (ad‑free, recording)
• Monetize per song, not per user

---

## 10. GitHub Issues / Backlog (Ready to Copy)

### Epic 1 — Search & Preview

• Implement `/api/search` (stub)
• Search results UI with preview
• Preview auto‑stop logic
• Select‑to‑sing flow

---

### Epic 2 — Preparation Jobs

• `/api/prepare` job creation
• Progress polling
• Cache status indicators

---

### Epic 3 — Lyrics Tooling

• LRC offset slider
• Simple admin lyric editor
• Community corrections

---

### Epic 4 — Ads

• Ad slot componentization
• AdSense integration (loading only)
• Post‑song ad screen

---

### Epic 5 — Metrics

• Event schema definition
• Local logging
• Later analytics integration

---

## 11. First User Test Plan

### Test Group

• 10–20 music‑loving users
• Laptop / desktop
• Speakers + headphones

---

### Session Tasks

Task A:
• Search → select → sing first song

Task B:
• Start second song

Task C:
• Observe lyrics usability

---

### Questions to Ask

• Would you use this again?
• Best part?
• Most frustrating part?
• Would you pay to remove ads?

---

### Metrics to Capture

Primary:
• songs per session
• completion rate
• time to first song

Secondary:
• preview → sing conversion
• abandonment during preparing

---

## 12. Core Philosophy (Final)

SingSync is not a feature showcase.

It is a **place**.

If people leave having sung more than one song, the MVP succeeded.

If not, no amount of licensing, AI, or polish will save it.

---

(End of Document)

