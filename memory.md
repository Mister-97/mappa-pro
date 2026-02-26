# FlowDesk — Detailed Session Notes & Code Changes

> This file tracks specific code changes, debugging notes, and session history.
> For high-level project context, see `FLOWDESK_CONTEXT.md`.

---

## 2026-02-26 — Sean initial setup session

- Cloned repo from `https://github.com/Mister-97/mappa-pro.git`
- Created branch `sean/dev`
- Renamed `env` → `.env` (was missing the dot)
- Added `.env` to `.gitignore`
- Changed `PORT` in `.env` from `8080` → `3001` (8080 was already in use locally)
- Server starts successfully on port 3001
- Set up memory system: `FLOWDESK_CONTEXT.md` (high-level) + `memory.md` (detailed changes)

## 2026-02-26 — Read receipts investigation

- **Goal**: Show "Delivered" / "Seen" status on outbound messages (like Fanvue's grey/purple checkmarks)
- **Finding**: Fanvue API does NOT expose fan-side read receipts
  - Per-message response shape: `{ uuid, text, sentAt, sender, recipient, hasMedia, mediaType, mediaUuids, type, pricing, purchasedAt, sentByUserId }` — no `isRead`, `isSeen`, `status`, or `readAt` field
  - `isRead` on conversation objects is creator-perspective only (has creator read fan's messages)
  - No `message.read` or `message.seen` webhook events exist
  - Fanvue webhook events: `message.received`, `subscriber.new`, `purchase.received`, `tip.received` only
- **Change made**: Updated `routes/conversations.js` message mapping — replaced hardcoded `platform_status: 'sent'` with `'delivered'` (accurate: if API returned it, it was delivered). Updated comment to document full Fanvue message shape.
- **Reverted**: Frontend delivered/seen CSS and rendering changes (no point showing permanent "Delivered" without "Seen" to contrast against)
- **Conclusion**: Read receipts feature blocked by Fanvue API limitations. Vanilla Fanvue UI likely uses internal WebSocket/state not exposed via REST API.
