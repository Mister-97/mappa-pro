# FlowDesk — Product Spec

> Revenue-generating MVP for OFM agencies managing Fanvue creators.
> Last updated: 2026-02-26 19:00

---

## Hard Constraints

- **Fanvue API compatibility is non-negotiable.** Every feature must work within the Fanvue REST API (v2025-06-26) and OAuth2 + PKCE flow. No features that assume OnlyFans or other platform APIs.
- **Multi-account by design.** Every feature must work across multiple connected creator accounts within one organization.

---

## Target Customer

Small-to-mid-size OFM agencies (1-15 people) managing multiple Fanvue creators. Both solo managers and established teams with chatters.

## Core Value Proposition

1. **Unified multi-account inbox** — manage conversations across all creators from one place
2. **Revenue attribution** — track which chatter generated what revenue for pay splits and performance

---

## Phase 1: Fix the Foundation

> Must complete before adding new features. Unblocks everything else.

### 1.1 Reliable Messaging
- **Message queue system:** Messages are added to a send queue immediately on submit, displayed optimistically in the UI, and sent to Fanvue API sequentially in order. The chatter can type and send back-to-back-to-back without waiting for each to register as sent.
- Visual states per message: sending (queued) → sent (confirmed) → failed (retry option)
- Real-time or near-real-time inbox updates (polling or webhooks)
- Message ordering guaranteed (sent_at ASC)
- **Chatter attribution on messages:** Each outbound message shows the logged-in chatter's name in small text underneath the message bubble

### 1.2 Data Accuracy
- Ensure analytics numbers (earnings, subscribers, spend) match Fanvue's actual data
- Validate Insights API response parsing — cents-to-dollars conversion, field mapping
- Fan spend data must be trustworthy enough to base pay decisions on

### 1.3 React Migration
- Migrate from `flowdesk-complete.html` (1500-line single file) to a proper React app
- Component-based architecture for maintainability
- Retain existing dark theme with purple/magenta accent (#a855f7)
- All existing functionality must be preserved during migration

---

## Phase 2: Core MVP (What Makes Agencies Pay)

### 2.1 Tabbed Multi-Account Inbox

**Creator tabs (top level):**
- One tab per connected Fanvue creator account
- Click a creator tab to see their inbox
- Visual indicator for unread messages per creator tab

**Conversation tabs (second level):**
- Default view: conversation list (inbox) for the selected creator
- Click a conversation to open it as a sub-tab
- Multiple conversations can be open simultaneously as tabs
- **Max 10-15 open conversation tabs** per creator (oldest auto-closes or user closes manually)
- Close button on each tab
- Unread indicator on conversation tabs

**Within a conversation:**
- Message history with inbound/outbound bubbles
- Send message input with enter-to-send
- Message queue for rapid-fire sending (see 1.1)
- Chatter name shown under each outbound message in small text
- Fan info sidebar (spending, subscription, notes)
- Conversation locking (claim for yourself)
- Follow-up flag

### 2.2 Revenue Attribution
- Track which chatter was active when revenue events occur (tips, PPV, subscriptions)
- Revenue leaderboard by chatter (daily/weekly/monthly)
- Per-chatter earnings breakdown by type (tips, PPV, subscriptions, renewals)
- Export-ready data for pay-split calculations

### 2.3 Analytics Dashboard
- Period selector (7d, 30d, 90d)
- Aggregate stats across all accounts: total earnings, subscribers, new today
- Per-account breakdown table with earnings, subscribers, messages, status
- Top spenders list with pagination
- Earnings over time (chart)
- Subscriber count over time (chart)

### 2.4 Team Management
- Invite team members via email
- Roles: owner, manager, chatter
- Assign chatters to specific creator accounts
- View team member activity and assignments
- Remove team members (owner only)

---

## Phase 3: Competitive Parity

> Match Infloww's feature set to compete head-to-head.

### 3.1 Scripts & Automation
- Create ordered script storylines with branching paths
- Auto-suggest next script step during live chat
- Script analytics (completion rate, revenue generated)
- Already partially built on backend — wire to React frontend

### 3.2 Snippets / Message Templates
- Quick-insert templates with variable resolution (fan name, etc.)
- Category filtering and search
- Already built on backend — wire to React frontend

### 3.3 Fan CRM
- Fan profiles with tags, notes (categorized), general notes
- Spending insights per fan (lifetime, PPV, tips, subscription)
- Subscription status and renewal tracking
- Fan search and filtering (tier, tag, spend)

### 3.4 Media Management
- Bulk upload media across accounts
- Media library per creator
- Attach media to messages

### 3.5 Billing (Stripe)
- Stripe integration for subscription billing
- Tiered plans (pricing model TBD)
- Usage tracking and limits per tier

---

## Phase 4: Differentiation

### 4.1 Mobile-Responsive Frontend
- Full functionality on tablet and mobile

### 4.2 Advanced Reporting
- Scheduled analytics snapshots
- PDF/CSV export for agency reporting
- Custom date range comparisons

_Note: White-label option is not a priority and not planned._

---

## Tech Stack

| Layer | Current | Target |
|---|---|---|
| Backend | Node.js / Express | Node.js / Express (keep) |
| Frontend | Vanilla HTML/CSS/JS (single file) | React |
| Database | Supabase (Postgres) | Supabase (keep) |
| API | Fanvue REST API v2025-06-26 | Same |
| Auth | JWT (7d expiry) | Same |
| Hosting | Render.com | Same |
| Billing | None | Stripe (Phase 3) |

---

## Division of Work

Use feature branches per task:
- `sean/<feature-name>`
- `josh/<feature-name>`

Update `memory.md` after each session with detailed code changes.
Update `FLOWDESK_CONTEXT.md` with high-level status changes.

---

## Success Criteria for MVP (end of Phase 2)

- [ ] An agency can connect multiple Fanvue creators via OAuth
- [ ] Chatters can manage conversations across creators using tabbed inbox
- [ ] Messages send and receive reliably — rapid-fire sending via queue, correct ordering
- [ ] Each outbound message shows which chatter sent it
- [ ] Revenue is attributed to the correct chatter
- [ ] Agency owner can see earnings leaderboard and analytics
- [ ] Team members can be invited, assigned, and managed
- [ ] Frontend is React-based, polished, and usable for daily work
