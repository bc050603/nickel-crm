-- 镍圈客户簿：在 Supabase 的 SQL Editor 里整段运行一次。
-- 每张表都开了行级权限（RLS）：登录的人只能读写自己的数据。

create table if not exists public.contacts (
  id          text primary key,
  user_id     uuid not null default auth.uid() references auth.users on delete cascade,
  name        text not null,
  wechat_name text,
  phone       text,
  company     text,
  role        text,
  segment     text,
  relation    text,
  tier        text not null default 'C' check (tier in ('A','B','C','D')),
  topics      text[] not null default '{}',
  gives       text,
  wants       text,
  highlights  text,
  issues      text,
  next        text,
  dynamics    text,
  last_their  date,
  last_touch  date,
  next_due    date,
  next_note   text not null default '',
  stats       jsonb not null default '{}',
  source      text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.logs (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users on delete cascade,
  contact_id   text not null references public.contacts(id) on delete cascade,
  contact_name text,
  channel      text,
  date         date not null default current_date,
  summary      text,
  next         text,
  next_date    date,
  created_at   timestamptz not null default now()
);

create table if not exists public.intel (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users on delete cascade,
  contact_id   text references public.contacts(id) on delete set null,
  contact_name text,
  date         date not null default current_date,
  category     text,
  content      text not null,
  source       text,
  created_at   timestamptz not null default now()
);

create table if not exists public.settings (
  user_id    uuid primary key default auth.uid() references auth.users on delete cascade,
  cadence    jsonb not null default '{"A":3,"B":7,"C":30}',
  updated_at timestamptz not null default now()
);

create index if not exists logs_user_date  on public.logs  (user_id, date desc);
create index if not exists intel_user_date on public.intel (user_id, date desc);
create index if not exists contacts_user   on public.contacts (user_id);

alter table public.contacts enable row level security;
alter table public.logs     enable row level security;
alter table public.intel    enable row level security;
alter table public.settings enable row level security;

drop policy if exists "own contacts" on public.contacts;
create policy "own contacts" on public.contacts for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "own logs" on public.logs;
create policy "own logs" on public.logs for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "own intel" on public.intel;
create policy "own intel" on public.intel for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "own settings" on public.settings;
create policy "own settings" on public.settings for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
