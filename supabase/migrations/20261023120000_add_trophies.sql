-- Trophies / Hall of Fame
-- A championship becomes part of the trophy history only once an admin
-- "finalizes" it (completed_at is set). Final podium is snapshotted into
-- user_trophies so future recalculations never alter the history.

alter table public.championships
  add column if not exists completed_at timestamptz;

create table if not exists public.user_trophies (
  id bigserial primary key,
  user_id text not null references public.users(id) on delete cascade,
  championship_id bigint not null references public.championships(id) on delete cascade,
  trophy_code text not null
    check (trophy_code in ('season_champion', 'season_runner_up', 'season_third', 'special')),
  final_position int,
  final_score numeric,
  title text,                      -- used for 'special' awards (e.g. "Re della Sprint")
  metadata jsonb not null default '{}'::jsonb,  -- snapshot: name, alias, team, participants
  awarded_by text,
  awarded_at timestamptz not null default now()
);

create unique index if not exists user_trophies_unique_season
  on public.user_trophies (user_id, championship_id, trophy_code)
  where trophy_code <> 'special';

create index if not exists user_trophies_user_idx on public.user_trophies (user_id);
create index if not exists user_trophies_championship_idx on public.user_trophies (championship_id);
