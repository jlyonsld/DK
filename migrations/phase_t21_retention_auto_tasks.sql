-- phase_t21_retention_auto_tasks.sql
--
-- Scheduled retention follow-up. Once a week (Monday morning) a Postgres
-- function evaluates every active enrollment for at-risk signals and creates
-- a de-duped follow-up task per newly at-risk student. This is the server-
-- side twin of the client-side Retention report's "+ Task" action — same
-- heuristic, same task shape — so a human never has to open the report for
-- the follow-ups to appear.
--
-- Decisions (per product owner, 2026-06-04):
--   * Cadence: weekly, Monday morning (12:00 UTC ≈ 7–8am ET; adjust the cron
--     expression below to taste).
--   * Action: create follow-up tasks only (no email).
--   * Owner: dk_config.retention_owner_profile_id if set, else the earliest
--     super_admin ("initially super_admin, later a specific admin" — change it
--     by setting that column, no code change needed).
--
-- At-risk definition (mirrors the client exactly):
--   excused absences are NEUTRAL (dropped from rate + streak); a student is
--   at risk with ≥2 unexcused absences in a row, OR <60% attendance over ≥4
--   recorded (non-excused) sessions in the last 30 days.
--
-- De-dupe: a task carries external_ref = 'retention:<enrollment_id>'; a new
-- one is skipped while any non-done/archived task with that ref OR the same
-- title already exists (so it also respects manually-created follow-ups).
--
-- Apply against the DK Supabase project (`ybolygqdbjqowfoqvnsz`) once.

begin;

-- 1. Owner override on the dk_config singleton --------------
alter table public.dk_config
  add column if not exists retention_owner_profile_id uuid references public.profiles(id);

-- 2. The weekly evaluator -----------------------------------
create or replace function public.create_retention_followup_tasks()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner    uuid;
  v_created  int := 0;
  r          record;
  v_title    text;
  v_ref      text;
  v_rate     int;
  v_priority task_priority;
  v_contact  text;
  v_desc     text;
begin
  select retention_owner_profile_id into v_owner from public.dk_config where id = 1;
  if v_owner is null then
    select id into v_owner
      from public.profiles
     where role = 'super_admin'
     order by role_granted_at nulls last, created_at
     limit 1;
  end if;
  if v_owner is null then
    return 0; -- nobody to own the tasks; bail without writing
  end if;

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
      select enrollment_id,
             count(*)                                            as total,
             count(*) filter (where status in ('present','late')) as present,
             coalesce(min(rn) filter (where status <> 'absent'), max(rn) + 1) - 1 as consec
        from att
       group by enrollment_id
    ),
    flagged as (
      select enrollment_id, total, present, consec
        from agg
       where consec >= 2
          or (total >= 4 and (present::numeric / nullif(total, 0)) < 0.6)
    )
    select f.enrollment_id, f.total, f.present, f.consec,
           round(coalesce(f.present::numeric / nullif(f.total, 0), 0) * 100)::int as rate,
           trim(coalesce(s.first_name, '') || ' ' || coalesce(s.last_name, '')) as student_name,
           coalesce(c.name, '—') as class_name,
           s.parent_names, s.parent_emails, s.parent_phones
      from flagged f
      join public.enrollments e on e.id = f.enrollment_id
      left join public.students s on s.id = e.student_id
      left join public.classes  c on c.id = e.class_id
  loop
    v_ref   := 'retention:' || r.enrollment_id;
    v_title := 'Retention follow-up: '
            || coalesce(nullif(r.student_name, ''), '(unnamed)')
            || ' — ' || r.class_name;

    if exists (
      select 1 from public.tasks t
       where (t.external_ref = v_ref or lower(t.title) = lower(v_title))
         and t.status not in ('done', 'archived')
    ) then
      continue;
    end if;

    v_rate     := r.rate;
    v_priority := case when r.consec >= 2 then 'high'::task_priority else 'medium'::task_priority end;
    v_contact  := coalesce(nullif(concat_ws(' · ',
                    (r.parent_names)[1], (r.parent_emails)[1], (r.parent_phones)[1]), ''),
                    'No parent contact on file.');
    v_desc := r.student_name || ' is at risk in ' || r.class_name || '.' || chr(10)
           || 'Why: '
           || case when r.consec >= 2 then r.consec || ' absences in a row. ' else '' end
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

-- 3. Schedule it: weekly, Monday 12:00 UTC ------------------
do $$
begin
  if exists (select 1 from cron.job where jobname = 'dk-retention-weekly') then
    perform cron.unschedule('dk-retention-weekly');
  end if;
end $$;

select cron.schedule(
  'dk-retention-weekly',
  '0 12 * * 1',
  $$ select public.create_retention_followup_tasks(); $$
);

commit;
