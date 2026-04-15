-- Run in Supabase SQL editor or via CLI. Requires extension for gen_random_uuid.
create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Designer-owned systems (full JSON, private to owner via RLS)
-- ---------------------------------------------------------------------------
create table if not exists public.designer_systems (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  system_key text not null,
  title text not null,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  unique (user_id, system_key)
);

create index if not exists designer_systems_user_idx on public.designer_systems (user_id);

alter table public.designer_systems enable row level security;

create policy "designer_systems_select_own"
  on public.designer_systems for select
  using (auth.uid() = user_id);

create policy "designer_systems_insert_own"
  on public.designer_systems for insert
  with check (auth.uid() = user_id);

create policy "designer_systems_update_own"
  on public.designer_systems for update
  using (auth.uid() = user_id);

create policy "designer_systems_delete_own"
  on public.designer_systems for delete
  using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- Published generator snapshots (read via RPC for players)
-- ---------------------------------------------------------------------------
create table if not exists public.published_generators (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  source_system_key text not null,
  slug text not null unique,
  payload jsonb not null,
  visibility text not null
    check (visibility in ('public', 'unlisted', 'invite')),
  invite_secret text,
  updated_at timestamptz not null default now(),
  constraint published_invite_secret_ok check (
    visibility <> 'invite'
    or (invite_secret is not null and length(trim(invite_secret)) > 0)
  )
);

create index if not exists published_generators_user_idx on public.published_generators (user_id);

alter table public.published_generators enable row level security;

create policy "published_generators_select_own"
  on public.published_generators for select
  using (auth.uid() = user_id);

create policy "published_generators_insert_own"
  on public.published_generators for insert
  with check (auth.uid() = user_id);

create policy "published_generators_update_own"
  on public.published_generators for update
  using (auth.uid() = user_id);

create policy "published_generators_delete_own"
  on public.published_generators for delete
  using (auth.uid() = user_id);

-- Public fetch: no direct table access for anon; use SECURITY DEFINER function.
create or replace function public.fetch_published_generator(p_slug text, p_secret text default '')
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.published_generators%rowtype;
begin
  select * into r from public.published_generators where slug = p_slug limit 1;
  if not found then
    return null;
  end if;
  if r.visibility in ('public', 'unlisted') then
    return r.payload;
  end if;
  if r.visibility = 'invite' and r.invite_secret is not null and r.invite_secret = p_secret then
    return r.payload;
  end if;
  return null;
end;
$$;

grant execute on function public.fetch_published_generator(text, text) to anon;
grant execute on function public.fetch_published_generator(text, text) to authenticated;
