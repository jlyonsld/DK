-- phase_t23_task_slas.sql
--
-- Give auto-routed tasks (T22) a due-date SLA so they're time-bound and can
-- be sorted/flagged by urgency. Sensible defaults (adjustable here):
--   leads        → due in 1 day   (speed-to-lead matters for conversion)
--   sub_coverage → due on the session date (coverage is needed by then)
--   onboarding   → due in 7 days
--   retention    → due in 3 days
--
-- Extends create_area_task with a p_due_at param and threads it through the
-- routing triggers + the weekly retention job. Trigger bodies stay fail-safe.
--
-- Apply against the DK Supabase project (`ybolygqdbjqowfoqvnsz`) once.

begin;

-- create_area_task gains a due-date arg. Drop the old 5-arg signature first
-- so we don't leave a stale overload behind.
drop function if exists public.create_area_task(text, text, text, text, task_priority);

create or replace function public.create_area_task(
  p_area text, p_title text, p_desc text, p_ref text, p_priority task_priority,
  p_due_at timestamptz default null
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
    (title, description, project_name, priority, status, owner_profile_id, external_ref, due_at, created_by)
  values
    (p_title, p_desc, v_project, coalesce(p_priority,'medium'::task_priority), 'open', v_owner, p_ref, p_due_at, v_owner);
end;
$$;

-- Re-point the routing triggers to pass a due date.
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
    'lead:' || new.id, 'high'::task_priority, now() + interval '1 day');
  return new;
exception when others then return new;
end;
$$;

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
    'sub_request:' || new.id, 'high'::task_priority, new.session_date::timestamptz);
  return new;
exception when others then return new;
end;
$$;

create or replace function public.tg_teachers_autotask()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  perform public.create_area_task('onboarding',
    'Onboard: ' || coalesce(nullif(new.full_name,''),'new teacher'),
    'New teacher added: ' || coalesce(new.full_name,'') || '.' || chr(10)
      || 'Run onboarding — NDA / contract, background check, waiver, payroll setup.' || chr(10)
      || '(Auto-routed to the Onboarding owner.)',
    'onboarding:' || new.id, 'medium'::task_priority, now() + interval '7 days');
  return new;
exception when others then return new;
end;
$$;

-- Retention job: stamp a 3-day due date on its follow-ups.
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
      (title, description, project_name, priority, status, owner_profile_id, assignee_label, external_ref, due_at, created_by)
    values
      (v_title, v_desc, 'DK: Retention', v_priority, 'open', v_owner, (r.parent_names)[1], v_ref, now() + interval '3 days', v_owner);
    v_created := v_created + 1;
  end loop;
  return v_created;
end;
$$;

commit;
