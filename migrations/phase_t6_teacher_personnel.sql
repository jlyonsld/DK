-- phase_t6_teacher_personnel.sql
--
-- Expands the `teachers` table to hold full personnel info — identity,
-- mailing address, emergency contact, employment classification, payroll
-- details, and background-check / certification / liability-waiver
-- compliance.
--
-- Apply against the DK Supabase project (`ybolygqdbjqowfoqvnsz`) once.
-- Idempotent: each ADD uses IF NOT EXISTS, each CHECK constraint is
-- dropped and re-added.
--
-- RLS unchanged — `teachers` already gates writes on
-- has_permission('edit_teachers'). Client-side gating in app.js hides
-- the new sections from manager-role users (PII, payroll, compliance
-- data is only editable by admin / super_admin via the modal).

begin;

alter table public.teachers
  add column if not exists preferred_name text,
  add column if not exists date_of_birth date,
  add column if not exists address_line1 text,
  add column if not exists address_line2 text,
  add column if not exists city text,
  add column if not exists state text,
  add column if not exists postal_code text,
  add column if not exists emergency_contact_name text,
  add column if not exists emergency_contact_phone text,
  add column if not exists emergency_contact_relationship text,
  add column if not exists title text,
  add column if not exists employment_type text,
  add column if not exists termination_date date,
  add column if not exists pay_type text,
  add column if not exists payment_method text,
  add column if not exists w9_on_file boolean default false,
  add column if not exists w9_received_date date,
  add column if not exists background_check_status text,
  add column if not exists background_check_provider text,
  add column if not exists background_check_date date,
  add column if not exists background_check_expires_date date,
  add column if not exists cpr_certified boolean default false,
  add column if not exists cpr_expires_date date,
  add column if not exists first_aid_certified boolean default false,
  add column if not exists first_aid_expires_date date,
  add column if not exists liability_waiver_signed boolean default false,
  add column if not exists liability_waiver_date date;

alter table public.teachers
  drop constraint if exists teachers_employment_type_check;
alter table public.teachers
  add constraint teachers_employment_type_check
  check (employment_type is null
         or employment_type in ('w2','1099','volunteer','intern','other'));

alter table public.teachers
  drop constraint if exists teachers_pay_type_check;
alter table public.teachers
  add constraint teachers_pay_type_check
  check (pay_type is null
         or pay_type in ('per_class','hourly','salary','stipend','other'));

alter table public.teachers
  drop constraint if exists teachers_payment_method_check;
alter table public.teachers
  add constraint teachers_payment_method_check
  check (payment_method is null
         or payment_method in ('direct_deposit','check','paypal','venmo','zelle','other'));

alter table public.teachers
  drop constraint if exists teachers_background_check_status_check;
alter table public.teachers
  add constraint teachers_background_check_status_check
  check (background_check_status is null
         or background_check_status in ('none','pending','cleared','flagged','expired'));

commit;
