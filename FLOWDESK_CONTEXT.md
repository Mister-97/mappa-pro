# FlowDesk Project Context — Claude Handoff File
> Paste this at the start of a new chat to get Claude up to speed instantly.
> Last updated: 2026-02-27 — Analytics fully wired, account status badge fixes

---

## ⚠️ Branch Workflow (IMPORTANT)

**All development happens on the `dev` branch — never commit directly to `main`.**

- Claude and collaborators work on `dev`
- When a feature/fix is ready, open a Pull Request: `dev → main`
- `main` is the production branch (auto-deploys to Render)

---

## What is this project?

**FlowDesk** is a CRM dashboard for OFM (OnlyFans Management) agencies managing Fanvue creators. It provides a unified platform for fan conversations, automated messaging, and revenue analytics.

- **Live URL:** https://mappa-pro.onrender.com
- **GitHub:** https://github.com/Mister-97/mappa-pro
- **Supabase Project ID:** `cafkoounmqnglhqokazr` (project name: flowdesk)
- **Deployment:** Render.com (auto-deploys from `main` branch)

---

## Tech Stack

| Layer | Tech |
|---|---|
| Backend | Node.js / Express |
| Auth | JWT (7d expiry) — `userId` in payload, org fetched fresh from DB on every request |
| Database | Supabase (Postgres) |
| API Integration | Fanvue REST API (version `2025-06-26`) with OAuth2 + PKCE |
| Notifications | ntfy push, Web Notifications API, in-dashboard sound + popup |
| Hosting | Render.com |

---

## Render Environment Variables

| Key | Value |
|---|---|
| `AUTH_BYPASS` | `true` (bypasses JWT — uses DEV_USER injected from env below) |
| `DEFAULT_ORG_ID` | `b9aa529d-7ddf-4f8e-8f83-5ba8b63df235` (Mappa org) |
| `DEFAULT_USER_ID` | `61d04dad-71f8-43cc-8e14-4f671a3fca91` |
| `FANVUE_CLIENT_ID` | (set in Render) |
| `FANVUE_CLIENT_SECRET` | (set in Render) |
| `FANVUE_REDIRECT_URI` | (set in Render) |
| `FRONTEND_URL` | (set in Render — used for OAuth redirects) |
| `JWT_SECRET` | (set in Render) |
| `ENCRYPTION_KEY` | (set in Render) |
| `SUPABASE_URL` | (set in Render) |
| `SUPABASE_SERVICE_KEY` | (set in Render) |

---

## Connected Fanvue Account

- **Creator:** mumu (`mumujunglefever`)
- **Account ID in DB:** `6ba7f235-46e6-4063-83d8-eabf9cf4f824`
- **Organization ID:** `b9aa529d-7ddf-4f8e-8f83-5ba8b63df235`
- OAuth tokens stored AES-encrypted in `connected_accounts` table
- Token auto-refreshes when <5 min from expiry

---

## Key Database Tables

- `organizations` — agency orgs
- `users` — dashboard logins (owner, manager, chatter roles)
- `connected_accounts` — Fanvue OAuth tokens per creator, AES-encrypted
- `conversations` — synced fan chats (linked to `connected_accounts`)
- `messages` — individual messages per conversation
- `fans` — fan profiles
- `fan_notes` — notes on fans with `category` column (added via migration)

---

## Key Source Files

| File | Purpose |
|---|---|
| `services/fanvueApi.js` | All Fanvue API calls — token management, refresh, all endpoints |
| `routes/conversations.js` | Inbox list, single convo, send message, sync, lock/unlock |
| `routes/analytics.js` | Overview stats, earnings, top-spenders, subscribers, spending — fully on Insights API |
| `routes/fans.js` | Fan CRUD, notes, general notes, insights endpoint |
| `routes/oauth.js` | Fanvue OAuth2 PKCE flow — callback stores tokens, sets `needs_reconnect: false`, redirects to `?oauth_success=true` |
| `routes/auth.js` | Signup, login, `/me` |
| `middleware/auth.js` | JWT verify + fresh DB org fetch; AUTH_BYPASS mode injects DEV_USER |
| `flowdesk-complete.html` | Single-file frontend SPA — all UI, no framework |

---

## What's Working

- OAuth2 PKCE login flow for Fanvue creators ✅
- Live inbox fetching (up to 3 pages / 150 messages, cached in Supabase) ✅
- Conversation list with unread/follow-up/mine filters ✅
- Send messages ✅
- Auth middleware fetches fresh `organization_id` from DB on every request ✅
- All documented Fanvue API endpoints implemented ✅
- Analytics overview endpoint wired up ✅
- Analytics rewrite — all 5 endpoints on Insights API ✅
- Analytics fully wired in frontend — overview totals + per-account accordion with earnings breakdown, subscriber activity, top spenders ✅
- Fan detail panel — full CSS + HTML + JS (300px right panel, 6 sections) ✅
- Fan notes with categories ✅
- General notes per fan ✅
- Backend Fanvue Insights API functions in `services/fanvueApi.js` ✅
- Backend `GET /api/fans/:fanId/insights` endpoint (returns normalised $/dollars) ✅
- Fan detail panel spending data now displays correctly (fixes insights envelope unwrap bug) ✅
- Account status badge: `is_active` checked before `needs_reconnect` in Overview, Accounts panel, and Reconnect button ✅
- OAuth callback clears `needs_reconnect` flag on successful reconnect ✅

---

## Account Status Display Logic

**Status priority order (most important first):**
1. `is_active === true` → show "Active" (green)
2. `needs_reconnect === true` → show "Needs reconnect" (red)
3. Otherwise → show "Inactive" (gray)

**Reconnect button:** shows only when `!is_active` (not just `needs_reconnect`).

This logic is in `flowdesk-complete.html` in both `loadDashboard()` (Overview table) and `loadAccountsPanel()` (Accounts table).

---

## Fanvue Insights API (all in `services/fanvueApi.js`)

All require `Authorization: Bearer token`, `X-Fanvue-API-Version: 2025-06-26`, scope `read:insights`.
All monetary values in **cents** from Fanvue — converted to **dollars** in the backend endpoint.

| Function | Fanvue Endpoint | Purpose |
|---|---|---|
| `getFanInsights(account, fanvueUuid)` | `GET /insights/fans/{uuid}` | Per-fan spending & subscription status |
| `getInsightsEarnings(account, params)` | `GET /insights/earnings` | Cursor-paginated earnings/transactions |
| `getTopSpenders(account, params)` | `GET /insights/top-spenders` | Top fans by total spend + message counts |
| `getInsightsSubscribers(account, params)` | `GET /insights/subscribers` | Daily subscriber count history |
| `getInsightsSpending(account, params)` | `GET /insights/spending` | Reversal/refund/chargeback data |

### `GET /api/fans/:fanId/insights` response shape
The backend wraps the normalised data in an `insights` key:
```json
{
  "insights": {
    "fan_type": "subscriber|fan|follower|blocked",
    "lifetime_spend": 42.50,
    "last_purchase_at": "2026-01-10T...",
    "max_single_payment": 15.00,
    "ppv_total": 10.00,
    "tip_total": 5.00,
    "subscription_total": 20.00,
    "renewal_total": 7.50,
    "post_total": 0.00,
    "subscription_status": "active|expired|follower|...",
    "subscription_started_at": "...",
    "subscription_renews_at": "...",
    "auto_renew": true
  }
}
```

> ⚠️ **Important:** The frontend must unwrap `d.insights` before passing to `populatePanelFromInsights()`.
> The fix is `.then(d => populatePanelFromInsights(d.insights))` — NOT `.then(d => populatePanelFromInsights(d))`.

---

## Fan Detail Panel — Element IDs

| Section | Element ID | Data source |
|---|---|---|
| Spending | `fdp-total-spent` | `lifetime_spend` |
| Spending | `fdp-since` | `subscription_started_at` |
| Spending | `fdp-last-spend` | `last_purchase_at` |
| Spending | `fdp-ppv-total` | `ppv_total` |
| Spending | `fdp-ppv-avg` | calculated (not returned by API, shown blank) |
| Spending | `fdp-tip-total` | `tip_total` |
| Spending | `fdp-tip-avg` | calculated (not returned by API, shown blank) |
| Subscription | `fdp-fan-type` | `fan_type` (badge colour: purple=subscriber, blue=fan, gray=follower, red=blocked) |
| Subscription | `fdp-sub-cost` | `subscription_total` |
| Subscription | `fdp-sub-duration` | calculated from `subscription_started_at` → `subscription_renews_at` |
| Subscription | `fdp-sub-renew` | `auto_renew` + `subscription_renews_at` |

---

## Analytics Frontend (loadAnalytics + toggleAcctAnalytics)

- **Period selector:** 7d / 30d / 90d / All time
- **Overview totals:** Total Earnings, Subscribers, New Subscribers
- **Per-account accordion:** click to expand each creator account
  - Earnings Breakdown (by subscription/ppv/tips/messages/other)
  - Subscriber Activity (new, cancelled, net change)
  - Top Spenders table (rank, fan, gross, net)
- Accordion lazy-loads details on first open, cached in `body.dataset.loaded`

---

## Recent Commits

| Commit | Description |
|---|---|
| `1a9dafe` | fix: prioritise is_active over needs_reconnect in status badges |
| `7ae128b` | fix: clear needs_reconnect flag on successful OAuth callback |
| `ba9a7e3` | feat: analytics - add All Time period, fix display bugs, add breakdown & top spenders |
| `7dbd433` | fix: unwrap insights response before populating fan detail panel |
| `f3a90fb` | fix: use ISO 8601 datetime for Fanvue Insights API date params |
| `e5232b5` | Rewrite analytics.js — replace legacy endpoints with Insights API |
| `b7a4406` | Fixed message send response, added PATCH nickname endpoint |
| `f3f4019` | Fan detail panel — full CSS, HTML, JS |

---

## Pending / Next Work

- Add pagination controls for top-spenders (currently shows top 5)
- Consider caching Insights API responses to avoid rate limits
- Push `dev` → `main` when ready to go live with all recent fixes

---

## How to Resume Work

Tell Claude:
> "I'm continuing work on FlowDesk. The context file is in the GitHub repo at `FLOWDESK_CONTEXT.md`."

Claude can access the codebase via GitHub MCP (`Mister-97/mappa-pro`) and the DB via Supabase MCP (project ID `cafkoounmqnglhqokazr`).

**Reminder for Claude:** Always work on the `dev` branch. Never commit directly to `main`.
