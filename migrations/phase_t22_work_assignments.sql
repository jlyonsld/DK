-- phase_t22_work_assignments.sql
--
-- Responsibility matrix: a super_admin maps each AREA of work to a PRIMARY
-- admin (plus an optional BACKUP). New work in that area auto-creates a
-- follow-up task owned by the area's admin, so e.g. every new lead routes to
-- the leads admin and every at-risk student routes to the retention admin.
--
-- Areas (v1): leads, retention, sub_coverage, onboarding.
-- Behavior (per product owner 2026-06-04): auto-create one de-duped task per
-- new item, owned by the area's primary (fallback: backup, then super_admin).
-- Backup also "sees" the area's tasks on their Home (client-side).
--
-- Routing is wired via fail-safe AFTER INSERT triggers on leads / sub_requests
-- / teachers, plus the existing weekly retention job. Trigger bodies swallow
-- any error so task-routing can NEVER block a core insert.
--
-- Apply against the DK Supabase project (`ybolygqdbjqowfoqvnsz`) once.

begin;

-- 1. The matrix --------------------------------------------
create table if not exists public.work_assignments (
  area               text primary key
                       check (area in ('leads','retention','sub_coverage','onboarding')),
  primary_profile_id uuid references public.profiles(id) on delete set null,
  backup_profile_id  uuid references public.profiles(id) on delete set null,
  updated_at         timestamptz not null default now(),
  updated_by         uuid references public.profiles(id)
);

insert into public.work_assignments (area) values
  ('leads'), ('retention'), ('sub_coverage'), ('onboarding')
on conflict (area) do nothing;

create or replace function public.tg_work_assignments_touch()
returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end;
$$;
drop trigger if exists work_assignments_touch on public.work_assignments;
create trigger work_assignments_touch
  before update on public.work_assignments
  for each row execute function public.tg_work_assignments_touch();

alter table public.work_assignments enable row level security;

drop policy if exists "wa_select" on public.work_assignments;
create policy "wa_select" on public.work_assignments
  for select to authenticated using (true);

drop policy if exists "wa_write" on public.work_assignments;
create policy "wa_write" on public.work_assignments
  for all to authenticated
  using (public.is_super_admin()) with check (public.is_super_admin());

do $$
begin
  if not exists (select 1 from pg_publication_tables
    where pubname='supabase_realtime' and schemaname='public' and tablename='work_assignments') then
    alter publication supabase_realtime add table public.work_assignments;
  end if;
end $$;

-- 2. Owner resolution + generic task creator ----------------
create or replace function public.work_area_owner(p_area text)
returns uuid
language sql stable security definer set search_path = public
as $$
  select coalesce(
    (select primary_profile_id from public.work_assignments where area = p_area),
    (select backup_profile_id  from public.work_assignments where area = p_area),
    (select id from public.profiles where role = 'super_admin'
       order by role_granted_at nulls last, created_at limit 1)
  );
$$;

create or replace function public.create_area_task(
  p_area text, p_title text, p_desc text, p_ref text, p_priority task_priority
) returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_owner   uuid;
  v_project text;
begin
  v_owner := public.work_area_owner(p_area);
  if v_owner is null then return; end if;
  if exists (
    select 1 from public.tasks t
     where (t.external_ref = p_ref or lower(t.title) = lower(p_title))
       and t.status not in ('done','archived')
  ) then return; end if;
  v_project := case p_area
    when 'leads'        then 'DK: Leads'
    when 'retention'    then 'DK: Retention'
    when 'sub_coverage' then 'DK: Sub coverage'
    when 'onboarding'   then 'DK: Onboarding'
    else 'DK: Tasks' end;
  insert into public.tasks
    (title, description, project_name, priority, status, owner_profile_id, external_ref, created_by)
  values
    (p_title, p_desc, v_project, coalesce(p_priority,'medium'::task_priority), 'open', v_owner, p_ref, v_owner);
end;
$$;

-- 3. Fail-safe routing triggers -----------------------------
-- Each swallows errors so a routing hiccup never blocks the core insert.

create or replace function public.tg_leads_autotask()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  perform public.create_area_task('leads',
    'Respond to lead: ' || coalesce(nullif(new.parent_name,''), new.parent_email, 'new lead'),
    'New lead' || coalesce(' — ' || new.parent_name, '') || '.' || chr(10)
      || coalesce('Email: ' || new.parent_email || chr(10), '')
      || coalesce('Phone: ' || new.parent_phone || chr(10), '')
      || coalesce('Child: ' || new.child_name || chr(10), '')
      || '(Auto-routed to the Leads owner.)',
    'lead:' || new.id, 'high'::task_priority);
  return new;
exception when others then return new;
end;
$$;
drop trigger if exists leads_autotask on public.leads;
create trigger leads_autotask after insert on public.leads
  for each row execute function public.tg_leads_autotask();

create or replace function public.tg_sub_requests_autotask()
returns trigger language plpgsql security definer set search_path = public
as $$
declare v_class text;
begin
  select name into v_class from public.classes where id = new.class_id;
  perform public.create_area_task('sub_coverage',
    'Find a sub: ' || coalesce(v_class,'class') || ' on ' || to_char(new.session_date,'Mon DD'),
    'Sub needed for ' || coalesce(v_class,'a class') || ' on ' || new.session_date || '.' || chr(10)
      || coalesce('Reason: ' || new.reason || chr(10), '')
      || '(Auto-routed to the Sub-coverage owner.)',
    'sub_request:' || new.id, 'high'::task_priority);
  return new;
exception when others then return new;
end;
$$;
drop trigger if exists sub_requests_autotask on public.sub_requests;
create trigger sub_requests_autotask after insert on public.sub_requests
  for each row execute function public.tg_sub_requests_autotask();

create or replace function public.tg_teachers_autotask()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  perform public.create_area_task('onboarding',
    'Onboard: ' || coalesce(nullif(new.full_name,''),'new teacher'),
    'New teacher added: ' || coalesce(new.full_name,'') || '.' || chr(10)
      || 'Run onboarding — NDA / contract, background check, waiver, payroll setup.' || chr(10)
      || '(Auto-routed to the Onboarding owner.)',
    'onboarding:' || new.id, 'medium'::task_priority);
  return new;
exception when others then return new;
end;
$$;
drop trigger if exists teachers_autotask on public.teachers;
create trigger teachers_autotask after insert on public.teachers
  for each row execute function public.tg_teachers_autotask();

-- 4. Rewire the weekly retention job to use the matrix ------
-- (owner: matrix retention primary → backup → legacy dk_config override →
--  earliest super_admin). Body otherwise identical to phase_t21.
create or replace function public.create_retention_followup_tasks()
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_owner uuid; v_created int := 0; r record;
  v_title text; v_ref text; v_rate int; v_priority task_priority; v_contact text; v_desc text;
begin
  v_owner := coalesce(
    (select primary_profile_id from public.work_assignments where area='retention'),
    (select backup_profile_id  from public.work_assignments where area='retention'),
    (select retention_owner_profile_id from public.dk_config where id = 1),
    (select id from public.profiles where role='super_admin' order by role_granted_at nulls last, created_at limit 1)
  );
  if v_owner is null then return 0; end if;

  for r in
    with att as (
      select a.enrollment_id, a.status, a.session_date,
             row_number() over (partition by a.enrollment_id order by a.session_date desc) as rn
        from public.attendance a
        join public.enrollments e on e.id = a.enrollment_id
       where e.status = 'active'
         and a.session_date >= (current_date - interval '30 days')
         and a.status <> 'excused'
    ),
    agg as (
      select enrollment_id, count(*) as total,
             count(*) filter (where status in ('present','late')) as present,
             coalesce(min(rn) filter (where status <> 'absent'), max(rn) + 1) - 1 as consec
        from att group by enrollment_id
    ),
    flagged as (
      select enrollment_id, total, present, consec from agg
       where consec >= 2 or (total >= 4 and (present::numeric / nullif(total,0)) < 0.6)
    )
    select f.enrollment_id, f.total, f.present, f.consec,
           round(coalesce(f.present::numeric / nullif(f.total,0),0) * 100)::int as rate,
           trim(coalesce(s.first_name,'') || ' ' || coalesce(s.last_name,'')) as student_name,
           coalesce(c.name,'—') as class_name,
           s.parent_names, s.parent_emails, s.parent_phones
      from flagged f
      join public.enrollments e on e.id = f.enrollment_id
      left join public.students s on s.id = e.student_id
      left join public.classes  c on c.id = e.class_id
  loop
    v_ref   := 'retention:' || r.enrollment_id;
    v_title := 'Retention follow-up: ' || coalesce(nullif(r.student_name,''),'(unnamed)') || ' — ' || r.class_name;
    if exists (select 1 from public.tasks t
        where (t.external_ref = v_ref or lower(t.title) = lower(v_title))
          and t.status not in ('done','archived')) then
      continue;
    end if;
    v_rate := r.rate;
    v_priority := case when r.consec >= 2 then 'high'::task_priority else 'medium'::task_priority end;
    v_contact := coalesce(nullif(concat_ws(' · ', (r.parent_names)[1], (r.parent_emails)[1], (r.parent_phones)[1]), ''),
                          'No parent contact on file.');
    v_desc := r.student_name || ' is at risk in ' || r.class_name || '.' || chr(10)
           || 'Why: ' || case when r.consec >= 2 then r.consec || ' absences in a row. ' else '' end
           || 'Attendance ' || v_rate || '% over ' || r.total || ' sessions.' || chr(10)
           || 'Contact — ' || v_contact || chr(10)
           || '(Auto-created by the weekly retention check.)';
    insert into public.tasks
      (title, description, project_name, priority, status, owner_profile_id, assignee_label, external_ref, created_by)
    values
      (v_title, v_desc, 'DK: Retention', v_priority, 'open', v_owner, (r.parent_names)[1], v_ref, v_owner);
    v_created := v_created + 1;
  end loop;
  return v_created;
end;
$$;

commit;
