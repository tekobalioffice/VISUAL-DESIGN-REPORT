-- Teiko Planner: run once in Supabase > SQL Editor. Safe to run again.
create table if not exists public.docs (
  col text not null,
  id text not null,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (col, id)
);
create unique index if not exists docs_col_id_key on public.docs (col, id);
alter table public.docs enable row level security;
alter table public.docs replica identity full;

-- only signed-in team accounts can read and write (turn off public sign-ups in Authentication settings)
drop policy if exists "tim baca tulis" on public.docs;
create policy "tim baca tulis" on public.docs for all to authenticated using (true) with check (true);

-- everything needs login (the public view-only policy was removed on 2026-11-05)
drop policy if exists "publik lihat progres" on public.docs;



-- live updates between browsers
do $$ begin
  alter publication supabase_realtime add table public.docs;
exception when duplicate_object then null;
end $$;

-- photos and files: public read by their random file name, upload only for the team
insert into storage.buckets (id, name, public, file_size_limit)
values ('uploads', 'uploads', true, 20971520)
on conflict (id) do update set public = true, file_size_limit = 20971520;
drop policy if exists "tim upload" on storage.objects;
create policy "tim upload" on storage.objects for insert to authenticated with check (bucket_id = 'uploads');
