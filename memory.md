# FlowDesk — Detailed Session Notes & Code Changes

> This file tracks specific code changes, debugging notes, and session history.
> For high-level project context, see `FLOWDESK_CONTEXT.md`.

---

## Existing Codebase — Features Already Built (pre-session baseline)

### Frontend (`flowdesk-complete.html`)
- **Message queue system**: `msgQueue` array with sequential `processQueue()` loop, optimistic UI with temp IDs, visual states (queued → sent → failed with retry), back-to-back sending without blocking
- **Chatter attribution**: Outbound messages display the logged-in chatter's name under the message bubble
- **Conversation list**: Unread/follow-up/mine filters, conversation locking
- **Fan detail panel**: 300px right sidebar with 6 sections — spending, subscription, notes (categorized), general notes, loaded via two-phase (DB instant + Insights async)
- **Dark theme**: Purple/magenta accent (#a855f7)

### Backend
- **OAuth2 PKCE flow** (`routes/oauth.js`): Full Fanvue OAuth login, token storage (AES-encrypted), auto-refresh
- **Conversations** (`routes/conversations.js`): Inbox list (up to 3 pages/150 msgs cached in Supabase), single convo fetch, send message, sync, lock/unlock, message ordering (sent_at ASC)
- **Analytics** (`routes/analytics.js`): All 5 endpoints on Insights API — overview stats, earnings, top-spenders, subscribers, spending
- **Fans** (`routes/fans.js`): Fan CRUD, notes with categories, general notes, `/api/fans/:fanId/insights` endpoint (cents→dollars conversion)
- **Fanvue API service** (`services/fanvueApi.js`): All documented Fanvue endpoints implemented, token management/refresh, Insights API functions
- **Auth** (`routes/auth.js`, `middleware/auth.js`): JWT with 7d expiry, AUTH_BYPASS dev mode, fresh org fetch per request

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

## 2026-02-26 — Conversation loading performance overhaul (~8s → <1s)

### Problem
Opening a conversation made 3 live Fanvue API calls (150 messages) every time, blocking the response for ~8 seconds.

### Changes Made

**`routes/conversations.js` — DB-first with pagination**
- Removed all live Fanvue API calls from `GET /api/conversations/:conversationId`
- Replaced with single paginated Supabase query: `ORDER BY sent_at DESC LIMIT :limit`
- Accepts `?limit=20&before=<ISO_timestamp>` for cursor pagination
- Returns `has_more` flag when rows === limit
- All 3 queries (conversation, messages, script_runs) run in parallel via `Promise.all`
- Mark-as-read fires as fire-and-forget (non-blocking), only on initial load (not pagination)
- Removed `account:connected_accounts` from the select (no longer needed, was exposing tokens)

**`services/inboxPoller.js` — Full message sync**
- Replaced single-message caching with full 50-message fetch via `getChatMessages` for conversations with new activity
- Maps all messages to app schema and upserts with `onConflict: 'fanvue_message_id'`
- Wrapped in try/catch so failures don't break the poller loop
- Added token refresh retry on auth errors before marking account as `needs_reconnect`

**`services/fanvueApi.js` — Less aggressive token failure handling**
- `refreshToken()` now only marks account as `needs_reconnect` on definitive 401/403 responses
- Transient errors (network issues, 404s, 500s) no longer deactivate the account

**`flowdesk-complete.html` — Frontend improvements**
- Extracted `renderMsgHtml(m)` helper with `data-msg-id` and `data-sent-at` attributes
- **Scroll-up pagination**: Scroll listener on `#msgs-box`, loads 20 older messages when `scrollTop < 100`, maintains scroll position
- **Live polling**: 7-second interval fetches latest 5 messages, deduplicates by `data-msg-id`, replaces optimistic messages instead of duplicating
- **Conversation caching**: `convoCache` Map stores rendered HTML + scroll position + state per conversation. Switching back restores instantly without re-fetching.
- **Sidebar preview update**: After sending a message, `last_message_preview` and `last_message_at` update in the conversation list immediately
- Fixed `connectAccount()` and `reconnectAccount()` — now fetch auth URL via `api()` then redirect, instead of navigating directly to the JSON endpoint

**`routes/oauth.js` — Reconnect fix**
- Added `needs_reconnect: false` to the account update in the OAuth callback

**`server.js` — Rate limit**
- Raised from `max: 100` to `max: 500` per 15min window to accommodate frontend polling

### Performance Result
- **Before:** 3 Fanvue API calls + upsert + attribution = ~8 seconds
- **After:** 3 parallel Supabase queries (conversation + 20 messages + script_run) = ~500ms

## 2026-03-01 — Unread badges fix + faster polling + auto-refresh

### Problem
1. Creator tab unread badges always showed 0 — `connected_accounts` has no `unread_count` column, so `a.unread_count` from the dashboard API was always `undefined`.
2. Inbox poller ran every 60s — too slow for responsive feel.
3. After initial load, unread counts and conversation lists never refreshed automatically.
4. Clicking an unread conversation didn't clear the unread dot in the conversation list (only decremented the badge).

### Changes Made

**`services/inboxPoller.js` — 15s polling**
- Changed cron from `*/60` to `*/15` seconds

**`routes/dashboard.js` — Unread count per account**
- Added 4th parallel query to `Promise.all`: selects all `conversations` where `is_unread = true` for the org
- Builds `Map<accountId, count>` from results and merges `unread_count` onto each account object before returning

**`flowdesk-complete.html` — Frontend fixes**
- `loadInbox()`: After setting `st.loaded = true`, recalculates `st.unreadCount` from `inboxConvos.filter(c => c.is_unread).length` and calls `renderCreatorTabs()`
- Added `inboxListPollInterval` state variable
- `startInboxListPolling()`: 20-second `setInterval` that silently re-fetches conversations for `activeAcctId`, updates `inboxConvos`, `st.convos`, `st.unreadCount`, re-renders list + tabs (no loading spinner)
- `stopInboxListPolling()`: clears the interval
- `showPanel()`: starts polling on `'inbox'`, stops on any other panel
- `logout()`: calls `stopInboxListPolling()`
- `openConvoFromList()`: added `renderConvoList(inboxConvos)` after marking convo as read so the unread dot clears immediately

## 2026-03-02 — Disconnect button, stateless OAuth, templates, tabbed convos

### Disconnect/Reconnect Button
- Added `disconnectAccount(id)` function to frontend — calls `DELETE /api/oauth/disconnect/:id` with confirmation dialog
- Accounts table now shows "Disconnect" for active accounts, "Reconnect" for disconnected/needs_reconnect accounts
- Backend disconnect endpoint (`routes/oauth.js`) now also sets `needs_reconnect: true` alongside clearing tokens

### Stateless OAuth PKCE (fixed `invalid_state` on Render)
- **Problem:** `pkceStore` was an in-memory `Map` — wiped on every Render server restart/deploy, causing `invalid_state` errors on OAuth callback
- **Fix:** Replaced in-memory Map with a signed JWT as the `state` parameter itself. The JWT contains `codeVerifier`, `userId`, `organizationId`, `label`, `accountId` and is signed with `JWT_SECRET` (10min expiry)
- No server-side storage needed — fully stateless, survives any restart
- Also added `accountId` passthrough from `reconnectAccount()` for future use
- Fixed `reconnectAccount()` — was calling `api()` expecting JSON, now does direct `window.location.href` redirect to `/api/oauth/connect`
- Added `read:media` to OAuth scope

### Templates Browsing & Sending (from earlier commits on this branch)
- Templates modal with folder filtering, paginated loading
- `templateMediaCache` Map persists media across folder switches
- `selectTemplate()` now uses UUID lookup instead of array index (survives re-renders)
- PPV pricing: priced templates sent as raw PPV with media (Fanvue ignores price when templateUuid present), free templates sent with templateUuid
- Template preview bar always visible when template selected

### Tabbed Conversations Improvements
- Click on conversation list replaces active tab (instead of always opening new tab)
- "+" button on hover opens conversation in new tab
- `replaceActiveTab()` and `openConvoInNewTab()` functions added
- `decrementUnreadIfNeeded()` extracted as shared helper
