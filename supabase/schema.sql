create extension if not exists pgcrypto;

create table if not exists public.site_users (
  id uuid primary key default gen_random_uuid(),
  username text not null unique,
  email text not null unique,
  email_is_generated boolean not null default false,
  site_origin text not null default 'unknown',
  registered_site text,
  source_site text,
  password_salt text not null,
  password_hash text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_login_at timestamptz
);

create unique index if not exists site_users_username_lower_key
  on public.site_users (lower(username));

alter table public.site_users
  add column if not exists site_origin text not null default 'unknown',
  add column if not exists registered_site text,
  add column if not exists source_site text;

create table if not exists public.user_entitlements (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  site_origin text not null default 'unknown',
  source_site text,
  grant_source text,
  source_plan_code text,
  source_reference text,
  plan text not null default 'free',
  status text not null default 'inactive',
  lifetime boolean not null default false,
  paddle_customer_id text,
  paddle_subscription_id text,
  paddle_transaction_id text,
  current_period_end timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.user_entitlements
  add column if not exists site_origin text not null default 'unknown',
  add column if not exists source_site text,
  add column if not exists grant_source text,
  add column if not exists source_plan_code text,
  add column if not exists source_reference text;

create index if not exists user_entitlements_email_updated_at_idx
  on public.user_entitlements (email, updated_at desc);

create table if not exists public.usage_events (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  site_origin text not null default 'unknown',
  event_type text not null,
  units integer not null default 1,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.usage_events
  add column if not exists site_origin text not null default 'unknown';

create index if not exists usage_events_email_created_at_idx
  on public.usage_events (email, created_at desc);

create table if not exists public.sponsor_orders (
  id uuid primary key default gen_random_uuid(),
  request_id text not null unique,
  email text not null default 'anonymous',
  plan_code text not null,
  site_origin text not null default 'vid2ppt',
  benefit_site text,
  benefit_plan text,
  status text not null default 'checkout_opened',
  code text unique,
  amount_cny numeric(12, 2),
  requested_amount_cny numeric(12, 2),
  quantity integer,
  source text,
  paddle_customer_id text,
  paddle_transaction_id text,
  redeemed_at timestamptz,
  redeemed_by text,
  redeemed_source text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

alter table public.sponsor_orders
  add column if not exists site_origin text not null default 'vid2ppt',
  add column if not exists benefit_site text,
  add column if not exists benefit_plan text;

create index if not exists sponsor_orders_email_created_at_idx
  on public.sponsor_orders (email, created_at desc);

create index if not exists sponsor_orders_status_created_at_idx
  on public.sponsor_orders (status, created_at desc);
