-- ============================================================
-- FANVUE CRM - SCHEMA V2 (run AFTER schema.sql)
-- Adds: fans, conversations, messages, snippets, scripts,
--       revenue events, chatter analytics
-- ============================================================

-- ============================================================
-- FANS (one record per fan per connected account)
-- ============================================================
CREATE TABLE fans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID REFERENCES connected_accounts(id) ON DELETE CASCADE,
  organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  fanvue_fan_id TEXT NOT NULL,
  username TEXT,
  display_name TEXT,
  avatar_url TEXT,
  -- Subscription state
  subscription_status TEXT DEFAULT 'unknown', -- active | expired | free
  subscribed_at TIMESTAMPTZ,
  subscription_tier TEXT,
  rebill_on BOOLEAN DEFAULT TRUE,
  -- Spend intelligence
  lifetime_spend DECIMAL(10,2) DEFAULT 0,
  spend_30d DECIMAL(10,2) DEFAULT 0,
  spend_7d DECIMAL(10,2) DEFAULT 0,
  ppv_unlock_count INTEGER DEFAULT 0,
  ppv_sent_count INTEGER DEFAULT 0,
  tip_count INTEGER DEFAULT 0,
  avg_tip DECIMAL(10,2) DEFAULT 0,
  last_purchase_at TIMESTAMPTZ,
  -- Engagement
  first_seen_at TIMESTAMPTZ DEFAULT NOW(),
  last_active_at TIMESTAMPTZ,
  last_message_at TIMESTAMPTZ,
  message_count INTEGER DEFAULT 0,
  -- Scoring (computed, updated by background job)
  buyer_score INTEGER DEFAULT 0, -- 0-100, higher = more likely to buy
  spend_tier TEXT DEFAULT 'low', -- whale | dolphin | low
  -- Internal
  timezone TEXT,
  notes TEXT, -- quick note field
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(account_id, fanvue_fan_id)
);

-- Fan tags
CREATE TABLE fan_tags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fan_id UUID REFERENCES fans(id) ON DELETE CASCADE,
  organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  tagged_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(fan_id, tag)
);

-- Fan notes (full history, not just latest)
CREATE TABLE fan_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fan_id UUID REFERENCES fans(id) ON DELETE CASCADE,
  organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  author_id UUID REFERENCES users(id),
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- CONVERSATIONS (one per fan per account — inbox thread)
-- ============================================================
CREATE TABLE conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID REFERENCES connected_accounts(id) ON DELETE CASCADE,
  organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  fan_id UUID REFERENCES fans(id) ON DELETE CASCADE,
  fanvue_thread_id TEXT, -- platform thread ID
  -- State
  is_unread BOOLEAN DEFAULT FALSE,
  unread_count INTEGER DEFAULT 0,
  last_message_at TIMESTAMPTZ,
  last_message_preview TEXT,
  last_message_from TEXT, -- 'model' | 'fan'
  -- Assignment
  assigned_chatter_id UUID REFERENCES users(id),
  -- Locking (collision prevention)
  locked_by UUID REFERENCES users(id),
  locked_at TIMESTAMPTZ,
  -- Priority flags
  needs_follow_up BOOLEAN DEFAULT FALSE,
  follow_up_at TIMESTAMPTZ,
  is_pinned BOOLEAN DEFAULT FALSE,
  -- Status
  status TEXT DEFAULT 'open', -- open | closed | archived
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(account_id, fan_id)
);

-- ============================================================
-- MESSAGES (cached message history)
-- ============================================================
CREATE TABLE messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
  organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  fanvue_message_id TEXT UNIQUE, -- dedup
  -- Content
  direction TEXT NOT NULL, -- 'inbound' | 'outbound'
  content TEXT,
  media_urls JSONB DEFAULT '[]',
  -- PPV
  is_ppv BOOLEAN DEFAULT FALSE,
  ppv_price DECIMAL(10,2),
  ppv_unlocked BOOLEAN DEFAULT FALSE,
  ppv_unlocked_at TIMESTAMPTZ,
  -- Attribution
  sent_by_user_id UUID REFERENCES users(id), -- null if fan sent it
  sent_by_automation BOOLEAN DEFAULT FALSE,
  script_run_id UUID, -- linked to script run if from script
  -- Platform
  platform_status TEXT DEFAULT 'sent', -- sent | delivered | failed
  sent_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- SNIPPETS / SAVED REPLIES
-- ============================================================
CREATE TABLE snippets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  account_id UUID REFERENCES connected_accounts(id) ON DELETE SET NULL, -- null = global
  created_by UUID REFERENCES users(id),
  -- Content
  title TEXT NOT NULL,
  body TEXT NOT NULL, -- supports {{variables}}
  category TEXT DEFAULT 'general',
  -- Media attachment
  media_urls JSONB DEFAULT '[]',
  -- PPV config
  is_ppv BOOLEAN DEFAULT FALSE,
  default_ppv_price DECIMAL(10,2),
  -- Targeting
  tag_filter TEXT, -- only show for fans with this tag
  -- Stats
  use_count INTEGER DEFAULT 0,
  revenue_attributed DECIMAL(10,2) DEFAULT 0,
  -- Status
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- SCRIPTS / PLAYBOOKS
-- ============================================================
CREATE TABLE scripts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  account_id UUID REFERENCES connected_accounts(id) ON DELETE SET NULL, -- null = global
  created_by UUID REFERENCES users(id),
  name TEXT NOT NULL,
  description TEXT,
  script_type TEXT DEFAULT 'flow', -- macro | flow | campaign
  scope TEXT DEFAULT 'global', -- global | model-specific
  status TEXT DEFAULT 'draft', -- draft | published | archived
  -- Stats (updated by triggers/jobs)
  run_count INTEGER DEFAULT 0,
  conversion_rate DECIMAL(5,2) DEFAULT 0,
  revenue_attributed DECIMAL(10,2) DEFAULT 0,
  avg_revenue_per_run DECIMAL(10,2) DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE script_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  script_id UUID REFERENCES scripts(id) ON DELETE CASCADE,
  step_index INTEGER NOT NULL, -- order
  -- Content
  content TEXT NOT NULL, -- supports {{variables}}
  internal_note TEXT, -- coaching note, not sent to fan
  media_urls JSONB DEFAULT '[]',
  -- PPV config
  is_ppv BOOLEAN DEFAULT FALSE,
  ppv_price DECIMAL(10,2),
  -- Timing
  delay_seconds INTEGER DEFAULT 0, -- wait before this step
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(script_id, step_index)
);

-- Script execution tracking
CREATE TABLE script_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  script_id UUID REFERENCES scripts(id),
  account_id UUID REFERENCES connected_accounts(id),
  fan_id UUID REFERENCES fans(id),
  conversation_id UUID REFERENCES conversations(id),
  chatter_id UUID REFERENCES users(id),
  -- Progress
  current_step INTEGER DEFAULT 0,
  status TEXT DEFAULT 'active', -- active | completed | abandoned
  -- Outcome
  converted BOOLEAN DEFAULT FALSE,
  revenue_generated DECIMAL(10,2) DEFAULT 0,
  -- Timestamps
  started_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  last_step_at TIMESTAMPTZ
);

CREATE TABLE script_run_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID REFERENCES script_runs(id) ON DELETE CASCADE,
  step_index INTEGER,
  action TEXT NOT NULL, -- step_sent | step_skipped | ppv_unlocked | completed | abandoned
  fanvue_message_id TEXT,
  revenue_amount DECIMAL(10,2),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- REVENUE EVENTS (full attribution)
-- ============================================================
CREATE TABLE revenue_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  account_id UUID REFERENCES connected_accounts(id),
  fan_id UUID REFERENCES fans(id),
  -- Attribution
  chatter_id UUID REFERENCES users(id), -- null if automation
  message_id UUID REFERENCES messages(id),
  script_run_id UUID REFERENCES script_runs(id),
  -- Event
  event_type TEXT NOT NULL, -- subscription | ppv | tip | renewal
  amount DECIMAL(10,2) NOT NULL,
  fanvue_event_id TEXT UNIQUE,
  -- Timestamp
  occurred_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- INBOX SYNC STATE (tracks polling cursor per account)
-- ============================================================
CREATE TABLE inbox_sync_state (
  account_id UUID PRIMARY KEY REFERENCES connected_accounts(id) ON DELETE CASCADE,
  last_synced_at TIMESTAMPTZ,
  last_cursor TEXT, -- pagination cursor from Fanvue API
  sync_status TEXT DEFAULT 'idle', -- idle | syncing | error
  error_message TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- RLS
-- ============================================================
ALTER TABLE fans ENABLE ROW LEVEL SECURITY;
ALTER TABLE fan_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE fan_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE snippets ENABLE ROW LEVEL SECURITY;
ALTER TABLE scripts ENABLE ROW LEVEL SECURITY;
ALTER TABLE script_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE script_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE script_run_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE revenue_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbox_sync_state ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- INDEXES
-- ============================================================
CREATE INDEX idx_fans_account ON fans(account_id);
CREATE INDEX idx_fans_org ON fans(organization_id);
CREATE INDEX idx_fans_fanvue_id ON fans(account_id, fanvue_fan_id);
CREATE INDEX idx_fans_spend_tier ON fans(organization_id, spend_tier);
CREATE INDEX idx_fans_buyer_score ON fans(account_id, buyer_score DESC);
CREATE INDEX idx_fans_last_active ON fans(account_id, last_active_at DESC);

CREATE INDEX idx_fan_tags_fan ON fan_tags(fan_id);
CREATE INDEX idx_fan_tags_org_tag ON fan_tags(organization_id, tag);

CREATE INDEX idx_conversations_account ON conversations(account_id);
CREATE INDEX idx_conversations_fan ON conversations(fan_id);
CREATE INDEX idx_conversations_unread ON conversations(account_id, is_unread) WHERE is_unread = TRUE;
CREATE INDEX idx_conversations_last_msg ON conversations(account_id, last_message_at DESC);
CREATE INDEX idx_conversations_chatter ON conversations(assigned_chatter_id);
CREATE INDEX idx_conversations_follow_up ON conversations(organization_id, needs_follow_up) WHERE needs_follow_up = TRUE;

CREATE INDEX idx_messages_conversation ON messages(conversation_id);
CREATE INDEX idx_messages_sent_at ON messages(conversation_id, sent_at DESC);
CREATE INDEX idx_messages_script_run ON messages(script_run_id);

CREATE INDEX idx_snippets_org ON snippets(organization_id, is_active);
CREATE INDEX idx_snippets_account ON snippets(account_id);

CREATE INDEX idx_scripts_org ON scripts(organization_id, status);
CREATE INDEX idx_script_steps_script ON script_steps(script_id, step_index);
CREATE INDEX idx_script_runs_conversation ON script_runs(conversation_id);
CREATE INDEX idx_script_runs_fan ON script_runs(fan_id);
CREATE INDEX idx_script_runs_active ON script_runs(conversation_id, status) WHERE status = 'active';

CREATE INDEX idx_revenue_events_org ON revenue_events(organization_id, occurred_at DESC);
CREATE INDEX idx_revenue_events_account ON revenue_events(account_id, occurred_at DESC);
CREATE INDEX idx_revenue_events_chatter ON revenue_events(chatter_id, occurred_at DESC);
CREATE INDEX idx_revenue_events_fan ON revenue_events(fan_id);
CREATE INDEX idx_revenue_events_script ON revenue_events(script_run_id);
