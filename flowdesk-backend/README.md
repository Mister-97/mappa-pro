# Fanvue CRM — Multi-Creator Agency Dashboard

A SaaS platform for OFM agencies to manage multiple Fanvue creator accounts from one dashboard. No code required for end users — just connect a Fanvue account via OAuth and the dashboard handles everything.

---

## 🏗️ Architecture

```
Agency Owner
  └── Connects Model Accounts (OAuth)
  └── Invites Chatters (email invite)
  └── Assigns Chatters to Accounts
  └── Views Aggregate Analytics
```

**Stack:** Node/Express · Supabase (Postgres) · Render hosting

---

## 🚀 Setup

### 1. Clone & Install
```bash
git clone https://github.com/YOUR_USERNAME/fanvue-crm
cd fanvue-crm
npm install
```

### 2. Supabase Setup
1. Create a free project at [supabase.com](https://supabase.com)
2. Go to SQL Editor → paste and run `schema.sql`
3. Copy your **Project URL** and **Service Role Key** (Settings → API)

### 3. Generate Encryption Key
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```
Save this 64-character hex string as `ENCRYPTION_KEY` in your .env

### 4. Environment Variables
```bash
cp .env.example .env
# Fill in all values in .env
```

### 5. Fanvue OAuth App
- Register your app with Fanvue's developer portal
- Set redirect URI to: `https://your-app.onrender.com/api/oauth/callback`
- Copy Client ID and Client Secret to .env

### 6. Run Locally
```bash
npm run dev
```

---

## 📡 API Reference

### Auth
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/signup` | Create agency account |
| POST | `/api/auth/login` | Login |
| GET | `/api/auth/me` | Get current user |

### OAuth / Account Connect
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/oauth/connect?label=ModelName` | Get Fanvue OAuth URL |
| GET | `/api/oauth/callback` | OAuth callback (Fanvue redirects here) |
| DELETE | `/api/oauth/disconnect/:accountId` | Remove account |

### Accounts
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/accounts` | List all connected accounts |
| GET | `/api/accounts/:accountId` | Single account + live stats |
| PATCH | `/api/accounts/:accountId` | Update account label |

### Analytics
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/analytics/overview?period=30d` | Aggregate across all accounts |
| GET | `/api/analytics/:accountId/earnings` | Earnings detail |
| GET | `/api/analytics/:accountId/subscribers` | Subscriber list |
| GET | `/api/analytics/:accountId/ppv` | PPV stats |

### Team
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/team` | List team members |
| POST | `/api/team/invite` | Invite chatter/manager |
| POST | `/api/team/assign` | Assign chatter to account |
| DELETE | `/api/team/assign` | Remove assignment |
| DELETE | `/api/team/:userId` | Remove team member |

### Dashboard
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/dashboard` | All dashboard data in one call |

---

## 🔐 Security

- OAuth tokens encrypted at rest with AES-256-GCM
- Tokens never logged or returned to frontend
- JWT authentication on all protected routes
- Organization-level data isolation (users can never access other orgs' data)
- Background token refresh (hourly cron) prevents expired sessions
- Rate limiting on all API routes

---

## 🚢 Deploy to Render

1. Push to GitHub
2. New Web Service on Render → connect repo
3. Build command: `npm install`
4. Start command: `node server.js`
5. Add all environment variables from `.env.example`
6. Set `FANVUE_REDIRECT_URI` to your Render URL + `/api/oauth/callback`

---

## 📋 Roadmap

- [x] Multi-account OAuth connect
- [x] Aggregate analytics dashboard
- [x] Team management + chatter assignment
- [ ] Messaging tools (send/receive via dashboard)
- [ ] Stripe billing (Free / Pro / Agency tiers)
- [ ] Email invites via Resend
- [ ] Analytics snapshots + historical charts
- [ ] Mobile-responsive frontend (React)
- [ ] White label option
