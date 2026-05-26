-- Teacher agreements: NDA + employment contract status/date fields.
-- SLED background check reuses the existing background_check_* columns
-- (provider = "SLED"); the signed PDFs upload into teacher_documents with
-- kind = 'agreement_nda' / 'agreement_contract' / 'certification_sled'.
-- Applied live via MCP 2026-05-26.

alter table public.teachers
  add column if not exists nda_on_file boolean not null default false,
  add column if not exists nda_signed_date date,
  add column if not exists contract_on_file boolean not null default false,
  add column if not exists contract_signed_date date;
