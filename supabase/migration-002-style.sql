-- 第二版：学说话风格。在 SQL Editor 里运行一次（可重复运行）。

alter table public.contacts add column if not exists my_samples text[] not null default '{}';
alter table public.settings add column if not exists style_profile text;

create table if not exists public.style_examples (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users on delete cascade,
  category   text not null,
  text       text not null,
  contact_id text references public.contacts(id) on delete set null,
  source     text not null default '手动',
  created_at timestamptz not null default now()
);
create index if not exists style_user_cat on public.style_examples (user_id, category, created_at desc);

alter table public.style_examples enable row level security;
drop policy if exists "own style" on public.style_examples;
create policy "own style" on public.style_examples for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
