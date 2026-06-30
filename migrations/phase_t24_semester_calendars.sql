-- ╔══════════════════════════════════════════════════════════════════════╗
-- ║  Phase T24 — Per-class semester calendars (admin manager + parent view  ║
-- ║  + branded PDF)                                                         ║
-- ╠══════════════════════════════════════════════════════════════════════╣
-- ║  Adds the data model behind the Drama-Kids-style per-class semester     ║
-- ║  calendar (the printed "2025 Fall CALENDAR" sheet handed to parents):   ║
-- ║                                                                          ║
-- ║    semesters              — term definitions (Fall / Winter-Spring /    ║
-- ║                             Summer / custom) with start/end + publish.  ║
-- ║    class_meeting_patterns — recurring weekly pattern per (class,        ║
-- ║                             semester): weekday + time + location/room/  ║
-- ║                             teacher override. One row per weekday a      ║
-- ║                             class meets (most classes = 1 row).         ║
-- ║    schedule_exceptions    — no-class dates (holidays / cancellations)   ║
-- ║                             and makeup dates, scoped to a semester and  ║
-- ║                             optionally a single class (NULL class_id =  ║
-- ║                             applies to every class in the semester).    ║
-- ║    parent_pointers        — per-class policy sections (payments, dress  ║
-- ║                             code, illness, …). NULL class_id = studio   ║
-- ║                             default template used when a class has no   ║
-- ║                             overrides.                                  ║
-- ║                                                                          ║
-- ║  Branding lives on dk_config (studio name / owner / contact / socials  ║
-- ║  / brand colors / logo) — new columns added below, all nullable with   ║
-- ║  sensible client-side fallbacks.                                        ║
-- ║                                                                          ║
-- ║  Public (parent) read path: the security-definer RPC                   ║
-- ║  get_class_calendar(class_id, semester_id) returns a single self-       ║
-- ║  contained JSON blob (header + patterns + exceptions + pointers +      ║
-- ║  branding + the list of available published semesters) ONLY for a      ║
-- ║  published semester. anon + authenticated may execute it, so the       ║
-- ║  standalone class-calendar.html parent page works with no login and    ║
-- ║  WITHOUT granting anon broad SELECT on classes/schools/dk_config.      ║
-- ║                                                                          ║
-- ║  Admin writes are gated on edit_classes (manager+) — no new permission ║
-- ║  name, same §4.5 consolidate-first pattern as schools/cancellations.   ║
-- ╚══════════════════════════════════════════════════════════════════════╝

-- ─────────────────────────────────────────────────────────────────────────
-- Enums
-- ─────────────────────────────────────────────────────────────────────────
do $$ begin
  create type semester_term as enum ('fall', 'winter_spring', 'summer', 'custom');
exception when duplicate_object then null; end $$;

do $$ begin
  create type schedule_exception_kind as enum ('no_class', 'makeup');
exception when duplicate_object then null; end $$;

-- ─────────────────────────────────────────────────────────────────────────
-- semesters
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists public.semesters (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,                       -- "2025 Fall", "2026 Winter/Spring"
  term          semester_term not null default 'custom',
  start_date    date not null,
  end_date      date not null,
  is_published  boolean not null default false,      -- published → parent page can read via RPC
  published_at  timestamptz,
  published_by  uuid references public.profiles(id) on delete set null,
  notes         text,
  created_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint semesters_dates_chk check (end_date >= start_date)
);
create index if not exists semesters_published_idx on public.semesters (is_published);
create index if not exists semesters_dates_idx     on public.semesters (start_date, end_date);

-- ─────────────────────────────────────────────────────────────────────────
-- class_meeting_patterns — recurring weekly pattern per (class, semester)
-- weekday: 0=Sunday … 6=Saturday (matches JS Date.getDay()).
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists public.class_meeting_patterns (
  id             uuid primary key default gen_random_uuid(),
  class_id       uuid not null references public.classes(id) on delete cascade,
  semester_id    uuid not null references public.semesters(id) on delete cascade,
  weekday        smallint not null check (weekday between 0 and 6),
  start_time     time,
  end_time       time,
  location_name  text,   -- override; falls back to class's school / location
  room           text,
  teacher_name   text,   -- free-form label shown on the calendar header
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (class_id, semester_id, weekday)
);
create index if not exists cmp_class_idx    on public.class_meeting_patterns (class_id);
create index if not exists cmp_semester_idx on public.class_meeting_patterns (semester_id);

-- ─────────────────────────────────────────────────────────────────────────
-- schedule_exceptions — no-class dates + makeups
-- class_id NULL = applies to every class in the semester (e.g. a shared
-- school-district holiday). class_id set = that one class only.
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists public.schedule_exceptions (
  id           uuid primary key default gen_random_uuid(),
  semester_id  uuid not null references public.semesters(id) on delete cascade,
  class_id     uuid references public.classes(id) on delete cascade,
  date         date not null,
  kind         schedule_exception_kind not null default 'no_class',
  label        text,
  created_at   timestamptz not null default now()
);
create index if not exists sx_semester_idx on public.schedule_exceptions (semester_id);
create index if not exists sx_class_idx     on public.schedule_exceptions (class_id);
create index if not exists sx_date_idx      on public.schedule_exceptions (date);

-- ─────────────────────────────────────────────────────────────────────────
-- parent_pointers — policy sections. class_id NULL = studio default template.
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists public.parent_pointers (
  id             uuid primary key default gen_random_uuid(),
  class_id       uuid references public.classes(id) on delete cascade,  -- NULL = default
  section_title  text not null,
  body           text not null default '',
  sort_order     int not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists pp_class_idx on public.parent_pointers (class_id, sort_order);

-- touch triggers
create or replace function public.touch_updated_at_generic()
returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end$$;

drop trigger if exists trg_semesters_touch on public.semesters;
create trigger trg_semesters_touch before update on public.semesters
  for each row execute function public.touch_updated_at_generic();

drop trigger if exists trg_cmp_touch on public.class_meeting_patterns;
create trigger trg_cmp_touch before update on public.class_meeting_patterns
  for each row execute function public.touch_updated_at_generic();

drop trigger if exists trg_pp_touch on public.parent_pointers;
create trigger trg_pp_touch before update on public.parent_pointers
  for each row execute function public.touch_updated_at_generic();

-- ─────────────────────────────────────────────────────────────────────────
-- dk_config branding columns (all nullable; client provides fallbacks)
-- ─────────────────────────────────────────────────────────────────────────
alter table public.dk_config add column if not exists studio_name        text;
alter table public.dk_config add column if not exists studio_owner_name   text;
alter table public.dk_config add column if not exists studio_phone        text;
alter table public.dk_config add column if not exists studio_email        text;
alter table public.dk_config add column if not exists studio_website      text;
alter table public.dk_config add column if not exists studio_facebook     text;
alter table public.dk_config add column if not exists studio_instagram    text;
alter table public.dk_config add column if not exists studio_address      text;
alter table public.dk_config add column if not exists brand_primary_color text;  -- header/footer ink (navy)
alter table public.dk_config add column if not exists brand_accent_color  text;  -- meeting-day circle (red)
alter table public.dk_config add column if not exists logo_url            text;

-- ─────────────────────────────────────────────────────────────────────────
-- RLS
-- ─────────────────────────────────────────────────────────────────────────
alter table public.semesters             enable row level security;
alter table public.class_meeting_patterns enable row level security;
alter table public.schedule_exceptions   enable row level security;
alter table public.parent_pointers       enable row level security;

-- SELECT: any signed-in user (the admin console + in-app preview read these
-- directly). The parent page does NOT use these policies — it goes through
-- the security-definer RPC below, so anon never touches the tables.
do $$ begin
  create policy semesters_select_auth on public.semesters
    for select to authenticated using (true);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy cmp_select_auth on public.class_meeting_patterns
    for select to authenticated using (true);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy sx_select_auth on public.schedule_exceptions
    for select to authenticated using (true);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy pp_select_auth on public.parent_pointers
    for select to authenticated using (true);
exception when duplicate_object then null; end $$;

-- WRITE: gated on edit_classes (manager+). has_permission() reads auth.uid()
-- internally, so these fire correctly under the user's JWT.
do $$ begin
  create policy semesters_write on public.semesters
    for all to authenticated
    using (public.has_permission('edit_classes'))
    with check (public.has_permission('edit_classes'));
exception when duplicate_object then null; end $$;
do $$ begin
  create policy cmp_write on public.class_meeting_patterns
    for all to authenticated
    using (public.has_permission('edit_classes'))
    with check (public.has_permission('edit_classes'));
exception when duplicate_object then null; end $$;
do $$ begin
  create policy sx_write on public.schedule_exceptions
    for all to authenticated
    using (public.has_permission('edit_classes'))
    with check (public.has_permission('edit_classes'));
exception when duplicate_object then null; end $$;
do $$ begin
  create policy pp_write on public.parent_pointers
    for all to authenticated
    using (public.has_permission('edit_classes'))
    with check (public.has_permission('edit_classes'));
exception when duplicate_object then null; end $$;

-- ─────────────────────────────────────────────────────────────────────────
-- Realtime publication
-- ─────────────────────────────────────────────────────────────────────────
do $$ begin
  alter publication supabase_realtime add table public.semesters;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.class_meeting_patterns;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.schedule_exceptions;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.parent_pointers;
exception when duplicate_object then null; end $$;

-- ─────────────────────────────────────────────────────────────────────────
-- get_class_calendar — the ONLY parent-facing read path.
-- Returns a self-contained JSON model for a class + (optionally) a semester.
-- If p_semester_id is NULL, picks the most recent PUBLISHED semester that has
-- a meeting pattern for the class. Only published semesters are ever returned.
-- security definer → bypasses RLS so anon can call it without table grants.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function public.get_class_calendar(
  p_class_id    uuid,
  p_semester_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_class     record;
  v_school    record;
  v_sem       record;
  v_cfg       record;
  v_result    jsonb;
  v_available jsonb;
begin
  select * into v_class from public.classes where id = p_class_id;
  if not found then
    return jsonb_build_object('error', 'class_not_found');
  end if;

  -- The list of published semesters this class has a pattern for (for the
  -- parent-page semester selector). Ordered most-recent first.
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', s.id, 'name', s.name, 'term', s.term,
           'start_date', s.start_date, 'end_date', s.end_date
         ) order by s.start_date desc), '[]'::jsonb)
    into v_available
    from public.semesters s
   where s.is_published
     and exists (select 1 from public.class_meeting_patterns p
                  where p.semester_id = s.id and p.class_id = p_class_id);

  -- Resolve the target semester: explicit id (must be published) or newest.
  if p_semester_id is not null then
    select * into v_sem from public.semesters
     where id = p_semester_id and is_published;
  else
    select s.* into v_sem
      from public.semesters s
     where s.is_published
       and exists (select 1 from public.class_meeting_patterns p
                    where p.semester_id = s.id and p.class_id = p_class_id)
     order by s.start_date desc
     limit 1;
  end if;

  if v_sem.id is null then
    return jsonb_build_object(
      'error', 'no_published_calendar',
      'class', jsonb_build_object('id', v_class.id, 'name', v_class.name),
      'available_semesters', v_available
    );
  end if;

  if v_class.school_id is not null then
    select * into v_school from public.schools where id = v_class.school_id;
  end if;

  select * into v_cfg from public.dk_config where id = 1;

  v_result := jsonb_build_object(
    'class', jsonb_build_object(
      'id',            v_class.id,
      'name',          v_class.name,
      'days',          v_class.days,
      'times',         v_class.times,
      'day_time',      v_class.day_time,
      'location',      v_class.location,
      'age_range',     v_class.age_range
    ),
    'school', case when v_school.id is null then null else jsonb_build_object(
      'name',          v_school.name,
      'address_line1', v_school.address_line1,
      'address_line2', v_school.address_line2,
      'city',          v_school.city,
      'state',         v_school.state,
      'postal_code',   v_school.postal_code
    ) end,
    'semester', jsonb_build_object(
      'id',         v_sem.id,
      'name',       v_sem.name,
      'term',       v_sem.term,
      'start_date', v_sem.start_date,
      'end_date',   v_sem.end_date
    ),
    'patterns', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'weekday',       p.weekday,
               'start_time',    p.start_time,
               'end_time',      p.end_time,
               'location_name', p.location_name,
               'room',          p.room,
               'teacher_name',  p.teacher_name
             ) order by p.weekday), '[]'::jsonb)
        from public.class_meeting_patterns p
       where p.semester_id = v_sem.id and p.class_id = p_class_id
    ),
    'exceptions', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'date',  x.date,
               'kind',  x.kind,
               'label', x.label
             ) order by x.date), '[]'::jsonb)
        from public.schedule_exceptions x
       where x.semester_id = v_sem.id
         and (x.class_id is null or x.class_id = p_class_id)
    ),
    'pointers', (
      -- class-specific pointers if any exist, else the studio default set.
      select coalesce(jsonb_agg(jsonb_build_object(
               'section_title', pp.section_title,
               'body',          pp.body
             ) order by pp.sort_order, pp.created_at), '[]'::jsonb)
        from public.parent_pointers pp
       where pp.class_id = (
         case when exists (select 1 from public.parent_pointers where class_id = p_class_id)
              then p_class_id else null end)
    ),
    'branding', jsonb_build_object(
      'studio_name',     coalesce(v_cfg.studio_name, v_cfg.sender_name),
      'owner_name',      v_cfg.studio_owner_name,
      'phone',           v_cfg.studio_phone,
      'email',           coalesce(v_cfg.studio_email, v_cfg.sender_email),
      'website',         v_cfg.studio_website,
      'facebook',        v_cfg.studio_facebook,
      'instagram',       v_cfg.studio_instagram,
      'address',         v_cfg.studio_address,
      'primary_color',   v_cfg.brand_primary_color,
      'accent_color',    v_cfg.brand_accent_color,
      'logo_url',        v_cfg.logo_url
    ),
    'available_semesters', v_available
  );

  return v_result;
end $$;

revoke all on function public.get_class_calendar(uuid, uuid) from public;
grant execute on function public.get_class_calendar(uuid, uuid) to anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- Seed a sensible default Parent Pointers template (class_id NULL) so a
-- brand-new studio's calendars already carry the standard Drama Kids
-- policies. Idempotent: only seeds when no default rows exist yet.
-- ─────────────────────────────────────────────────────────────────────────
do $$
begin
  if not exists (select 1 from public.parent_pointers where class_id is null) then
    insert into public.parent_pointers (class_id, section_title, body, sort_order) values
      (null, 'Payments & Refunds',
       'Tuition is billed on the first of each month. A late fee applies after the 10th. Refunds are prorated for the remainder of the semester upon written withdrawal notice.', 1),
      (null, 'Dress Code',
       'Students should wear comfortable, movement-friendly clothing and closed-toe shoes. No flip-flops, sandals, or restrictive clothing.', 2),
      (null, 'Class Closures',
       'When the host school is closed for weather or holidays, Drama Kids class is also closed. Makeup dates appear on this calendar where scheduled.', 3),
      (null, 'Illness',
       'Please keep your child home if they have a fever, are contagious, or are too unwell to participate. Notify us of any allergies or medical needs.', 4),
      (null, 'Promptness',
       'Please drop off and pick up on time. Our teachers cannot supervise students before or after the scheduled class window.', 5),
      (null, 'Parent Participation',
       'Class time is for the students. Parents are welcome at scheduled showcase and demonstration days, announced in advance.', 6),
      (null, 'Behavior',
       'We foster a positive, respectful, and inclusive environment. Disruptive behavior is addressed with the student and, if needed, the family.', 7),
      (null, 'Snacks',
       'Please send a water bottle. Snacks are generally not needed for class; if your child requires one, please keep it nut-free.', 8);
  end if;
end $$;
