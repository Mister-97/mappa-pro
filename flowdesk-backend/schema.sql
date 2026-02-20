-- ============================================================
-- FANVUE CRM - SUPABASE SCHEMA
-- Run this entire file in Supabase SQL Editor
-- ============================================================

-- Organizations (agencies)
CREATE TABLE organizations (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'starter', -- starter | pro | agency
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Users (owners, managers, chatters)
CREATE TABLE users (
  id UUID PRIMARY KEY,
  organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'chatter', -- owner | manager | chatter
  must_reset_password BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Connected Fanvue Accounts (one per model/creator)
CREATE TABLE connected_accounts (
  id UUID PRIMARY KEY,
  organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  connected_by UUID REFERENCES users(id),
  label TEXT NOT NULL DEFAULT 'Unnamed Model',
  fanvue_user_id TEXT NOT NULL,
  fanvue_username TEXT NOT NULL,
  fanvue_display_name TEXT,
  avatar_url TEXT,
  -- Tokens stored encrypted (AES-256-GCM)
  access_token_enc TEXT,
  refresh_token_enc TEXT,
  token_expires_at TIMESTAMPTZ,
  is_active BOOLEAN DEFAULT TRUE,
  needs_reconnect BOOLEAN DEFAULT FALSE,
  last_synced TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(fanvue_user_id, organization_id)
);

-- Chatter Assignments (which chatter handles which account)
CREATE TABLE chatter_assignments (
  id UUID PRIMARY KEY,
  chatter_id UUID REFERENCES users(id) ON DELETE CASCADE,
  account_id UUID REFERENCES connected_accounts(id) ON DELETE CASCADE,
  assigned_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(chatter_id, account_id)
);

-- Analytics Snapshots (cached daily for performance)
CREATE TABLE analytics_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID REFERENCES connected_accounts(id) ON DELETE CASCADE,
  snapshot_date DATE NOT NULL,
  subscriber_count INTEGER DEFAULT 0,
  new_subscribers INTEGER DEFAULT 0,
  earnings_total DECIMAL(10,2) DEFAULT 0,
  earnings_subscriptions DECIMAL(10,2) DEFAULT 0,
  earnings_ppv DECIMAL(10,2) DEFAULT 0,
  earnings_tips DECIMAL(10,2) DEFAULT 0,
  message_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(account_id, snapshot_date)
);

-- ============================================================
-- ROW LEVEL SECURITY
-- Ensures organizations can NEVER see each other's data
-- ============================================================

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE connected_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE chatter_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics_snapshots ENABLE ROW LEVEL SECURITY;

-- Note: Since we use the service role key on the backend,
-- RLS is a safety net. Backend enforces org isolation in queries.

-- ============================================================
-- INDEXES for performance
-- ============================================================

CREATE INDEX idx_users_org ON users(organization_id);
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_connected_accounts_org ON connected_accounts(organization_id);
CREATE INDEX idx_connected_accounts_active ON connected_accounts(organization_id, is_active);
CREATE INDEX idx_connected_accounts_token_expiry ON connected_accounts(token_expires_at) WHERE is_active = TRUE;
CREATE INDEX idx_chatter_assignments_chatter ON chatter_assignments(chatter_id);
CREATE INDEX idx_chatter_assignments_account ON chatter_assignments(account_id);
CREATE INDEX idx_analytics_snapshots_account_date ON analytics_snapshots(account_id, snapshot_date);
