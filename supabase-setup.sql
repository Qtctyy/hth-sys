-- Run this once in your Supabase project's SQL Editor (Dashboard -> SQL Editor -> New query).
-- Safe to re-run: every statement below only creates something if it doesn't already exist.

-- ============================================================
-- RIDES — one row per customer, per agent
-- ============================================================
create table if not exists rides (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  agent text not null default 'Hamzah',
  name text not null,
  mobile_number text,
  building_number text,
  street_name text,

  to_work_enabled boolean not null default true,
  to_work_pickup text,
  to_work_dest text,
  to_work_time text,
  to_work_completed_date text,

  way_back_enabled boolean not null default true,
  way_back_pickup text,
  way_back_dest text,
  way_back_time text,
  way_back_completed_date text,

  amount numeric default 0,
  notes text,
  days_of_week int[] not null default '{0,1,2,3,4,5,6}',
  skipped_date text,
  created_at timestamptz default now()
);

-- If you already have an older version of this table, these add whatever's missing
-- without touching your existing rows.
alter table rides add column if not exists agent text not null default 'Hamzah';
alter table rides add column if not exists mobile_number text;
alter table rides add column if not exists building_number text;
alter table rides add column if not exists street_name text;
alter table rides add column if not exists to_work_enabled boolean not null default true;
alter table rides add column if not exists to_work_completed_date text;
alter table rides add column if not exists way_back_enabled boolean not null default true;
alter table rides add column if not exists way_back_completed_date text;
alter table rides add column if not exists days_of_week int[] not null default '{0,1,2,3,4,5,6}';
-- skipped_date: set to a business-day string (e.g. '2026-08-07') to skip that one
-- occurrence without touching days_of_week — it stops mattering on its own once
-- the date no longer matches today, no cleanup job required.
alter table rides add column if not exists skipped_date text;

alter table rides enable row level security;

drop policy if exists "Users can view their own rides" on rides;
create policy "Users can view their own rides"
  on rides for select
  using (auth.uid() = user_id);

drop policy if exists "Users can insert their own rides" on rides;
create policy "Users can insert their own rides"
  on rides for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users can update their own rides" on rides;
create policy "Users can update their own rides"
  on rides for update
  using (auth.uid() = user_id);

drop policy if exists "Users can delete their own rides" on rides;
create policy "Users can delete their own rides"
  on rides for delete
  using (auth.uid() = user_id);

-- ============================================================
-- TRIP_HISTORY — a log entry every time a leg is marked complete
-- (the History and Payments tabs both read from this table)
-- ============================================================
create table if not exists trip_history (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  ride_id uuid references rides(id) on delete set null,
  agent text not null,
  customer_name text not null,
  leg text not null,
  amount numeric default 0,
  business_day text not null,
  settled boolean not null default false,
  completed_at timestamptz default now()
);

alter table trip_history add column if not exists settled boolean not null default false;

-- Earnings history should survive even if the ride record itself is later deleted —
-- past income shouldn't vanish just because a customer was removed. If you're
-- upgrading from an earlier version of this script, this replaces the old
-- "on delete cascade" behavior on ride_id with "on delete set null".
alter table trip_history drop constraint if exists trip_history_ride_id_fkey;
alter table trip_history
  add constraint trip_history_ride_id_fkey
  foreign key (ride_id) references rides(id) on delete set null;

alter table trip_history enable row level security;

drop policy if exists "Users can view their own trip history" on trip_history;
create policy "Users can view their own trip history"
  on trip_history for select
  using (auth.uid() = user_id);

drop policy if exists "Users can insert their own trip history" on trip_history;
create policy "Users can insert their own trip history"
  on trip_history for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users can update their own trip history" on trip_history;
create policy "Users can update their own trip history"
  on trip_history for update
  using (auth.uid() = user_id);

drop policy if exists "Users can delete their own trip history" on trip_history;
create policy "Users can delete their own trip history"
  on trip_history for delete
  using (auth.uid() = user_id);

-- Speeds up the History tab's per-agent, most-recent-first query.
create index if not exists trip_history_agent_completed_idx
  on trip_history (agent, completed_at desc);

-- Speeds up the Payments tab's "how much is still unsettled" query.
create index if not exists trip_history_agent_settled_idx
  on trip_history (agent, settled);
