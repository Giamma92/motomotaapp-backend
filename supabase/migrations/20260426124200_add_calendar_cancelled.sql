alter table public.calendar
add column if not exists cancelled boolean not null default false;
