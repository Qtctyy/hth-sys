-- Run this once in your Supabase project's SQL Editor (Dashboard -> SQL Editor -> New query).

create table rides (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  to_work_pickup text,
  to_work_dest text,
  to_work_time text,
  way_back_pickup text,
  way_back_dest text,
  way_back_time text,
  amount numeric default 0,
  notes text,
  created_at timestamptz default now()
);

-- Turn on row-level security so nobody can see or touch anyone else's rows.
alter table rides enable row level security;

-- Each person can only see their own rides.
create policy "Users can view their own rides"
  on rides for select
  using (auth.uid() = user_id);

-- Each person can only insert rides under their own account.
create policy "Users can insert their own rides"
  on rides for insert
  with check (auth.uid() = user_id);

-- Each person can only update their own rides.
create policy "Users can update their own rides"
  on rides for update
  using (auth.uid() = user_id);

-- Each person can only delete their own rides.
create policy "Users can delete their own rides"
  on rides for delete
  using (auth.uid() = user_id);
