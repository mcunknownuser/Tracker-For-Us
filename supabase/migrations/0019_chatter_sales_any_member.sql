-- =============================================================================
--  0019_chatter_sales_any_member.sql
--
--  Allow chatter_sales rows to reference ANY team_member, not just
--  commission-paid ones. Background:
--
--    Migration 0010 added a generated `pay_structure` column on chatter_sales,
--    permanently set to 'commission', plus a composite FK to
--    team_members(id, pay_structure). That made the database enforce
--    "only commission-paid members can have sales attached to them" —
--    which broke the new use case where flat-paid staff also bring in revenue
--    that the agency wants to attribute to them (their wage is unrelated
--    to those sales, but we still want to track how much they generated).
--
--    Fix: drop the composite FK + the redundant generated column, and add
--    a plain FK on team_member_id alone. Same `on delete restrict` semantics.
--
--  Effect on existing rows: none — only the constraint shape changes. The
--  former generated column value is dropped along with the column.
-- =============================================================================


-- ---------------------------------------------------------------------------
--  1. Drop the composite FK. The column reference is positional in the
--     constraint, so we have to drop the constraint first before dropping
--     the column it references.
-- ---------------------------------------------------------------------------

alter table public.chatter_sales
  drop constraint if exists chatter_sales_team_member_id_pay_structure_fkey;


-- ---------------------------------------------------------------------------
--  2. Drop the generated pay_structure column.
-- ---------------------------------------------------------------------------

alter table public.chatter_sales
  drop column if exists pay_structure;


-- ---------------------------------------------------------------------------
--  3. Add a plain FK on team_member_id. on delete restrict so a member
--     can't be hard-deleted while they have sales attached — matches the
--     previous behavior.
-- ---------------------------------------------------------------------------

alter table public.chatter_sales
  add constraint chatter_sales_team_member_id_fkey
  foreign key (team_member_id)
  references public.team_members(id)
  on delete restrict;
