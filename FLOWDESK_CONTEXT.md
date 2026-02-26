# FlowDesk Project Context — Claude Handoff File
> Paste this at the start of a new chat to get Claude up to speed instantly.
> Last updated: 2026-02-26 — Analytics rewrite complete, all Insights API endpoints wired up

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
| `routes/oauth.js` | Fanvue OAuth2 PKCE flow — callback stores tokens, redirects to `?oauth_success=true` |
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
- Fan detail panel — full CSS + HTML + JS (300px right panel, 6 sections) ✅
- Fan notes with categories ✅
- General notes per fan ✅
- Backend Fanvue Insights API functions in `services/fanvueApi.js` ✅
- Backend `GET /api/fans/:fanId/insights` endpoint (returns normalised $/dollars) ✅

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
```json
{
  "fan_type": "subscriber|fan|blocked",
  "lifetime_spend": 42.50,
  "last_purchase_at": "2026-01-10T...",
  "max_single_payment": 15.00,
  "ppv_total": 10.00,
  "tip_total": 5.00,
  "subscription_total": 20.00,
  "renewal_total": 7.50,
  "post_total": 0.00,
  "subscription_status": "active|expired|...",
  "subscription_started_at": "...",
  "subscription_renews_at": "...",
  "auto_renew": true
}
```

---

## Fan Detail Panel — Element IDs

| Section | Element ID | Data source |
|---|---|---|
| Spending | `fdp-total-spent` | `lifetime_spend` |
| Spending | `fdp-since` | `subscription_started_at` |
| Spending | `fdp-last-spend` | `last_purchase_at` |
| Spending | `fdp-ppv-total` | `ppv_total` |
| Spending | `fdp-ppv-avg` | calculated |
| Spending | `fdp-tip-total` | `tip_total` |
| Spending | `fdp-tip-avg` | calculated |
| Subscription | `fdp-fan-type` | `fan_type` |
| Subscription | `fdp-sub-cost` | `subscription_total` |
| Subscription | `fdp-sub-duration` | calculated from dates |
| Subscription | `fdp-sub-renew` | `subscription_renews_at` |

---

## Recent Commits

| Commit | Description |
|---|---|
| `e5232b5` | Rewrite analytics.js — replace legacy endpoints with Insights API |
| `ccaf40c` | Fix getStats() fanCounts field paths |
| `41db054` | Fixed PostgREST foreign key constraint 404 |
| `b7a4406` | Fixed message send response, added PATCH nickname endpoint |
| `f3f4019` | Fan detail panel — full CSS, HTML, JS |
| `1e7fb12` | DB migration: add category to fan_notes; PATCH general-notes; notes now return category |
| `ee1f04c` | Insights API functions in fanvueApi.js |
| `5b5f095` | Added GET /api/fans/:fanId/insights endpoint |

---

## Pending Work

### ✅ All previously pending tasks are complete

1. ✅ `showFanDetailPanel()` — two-phase load: DB instant, Insights overlay async (commit 8432285)
2. ✅ `routes/analytics.js` rewrite — all 5 endpoints on Insights API (commit e5232b5)
3. ✅ Message ordering — fixed (sort by sent_at ASC in routes/conversations.js)

### Next potential work
- Wire analytics endpoints to frontend charts/tables in `flowdesk-complete.html`
- Add pagination controls for top-spenders and earnings tables
- Consider caching Insights API responses (rate limits)

---

## How to Resume Work

Tell Claude:
> "I'm continuing work on FlowDesk. Here's the context file: [paste this doc]"

Claude can access the codebase via GitHub MCP (`Mister-97/mappa-pro`) and the DB via Supabase MCP (project ID `cafkoounmqnglhqokazr`).
