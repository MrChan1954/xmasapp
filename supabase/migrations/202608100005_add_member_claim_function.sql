create or replace function public.claim_app_member()
returns boolean language plpgsql security definer set search_path = public
as $$ begin update public.app_members set user_id = auth.uid(), updated_at = now() where lower(email) = lower((select email from auth.users where id = auth.uid())) and user_id is null and active = true; return found; end; $$;
revoke all on function public.claim_app_member() from public;
grant execute on function public.claim_app_member() to authenticated;
