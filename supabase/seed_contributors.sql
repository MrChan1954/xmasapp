do $$
declare event_id uuid; contributor_id uuid; recipient_id uuid; contributor_name text; recipient_name text; amount integer;
begin
  select id into event_id from public.christmas_events where year = 2026;
  foreach contributor_name in array array['Jade','Kirsten','Paige','Taylor'] loop
    insert into public.people (name) values (contributor_name) on conflict do nothing;
    insert into public.contributors (christmas_event_id, person_id) select event_id, id from public.people where name = contributor_name on conflict do nothing;
  end loop;
  for recipient_name in select name from public.people where name in ('Mum','Dad','Jade','Kirsten','Paige','Taylor','Eden','Lucas','Eliza','Maggie','Harry','Grandma','Joanne','Ian','Owen','Reece','Kerry','Glynn','Jaden') loop
    select r.id into recipient_id from public.christmas_recipients r join public.people p on p.id = r.person_id where r.christmas_event_id = event_id and p.name = recipient_name;
    for contributor_name in select unnest(array['Jade','Kirsten','Paige','Taylor']) loop
      select c.id into contributor_id from public.contributors c join public.people p on p.id = c.person_id where c.christmas_event_id = event_id and p.name = contributor_name;
      amount := case when recipient_name = 'Mum' or recipient_name = 'Dad' then 2500 when recipient_name = 'Jaden' and contributor_name = 'Jade' then 0 when recipient_name in ('Jade','Kirsten','Paige','Taylor','Eden','Lucas','Eliza','Maggie','Harry','Grandma','Joanne','Jaden') then case when recipient_name = contributor_name or (recipient_name in ('Lucas','Eliza','Maggie') and contributor_name = 'Kirsten') or (recipient_name = 'Harry' and contributor_name = 'Paige') then 0 else 1500 end when recipient_name = 'Ian' or recipient_name = 'Reece' or recipient_name = 'Kerry' then 1000 when recipient_name = 'Owen' then case when contributor_name = 'Jade' then 0 else 1000 end else 500 end;
      insert into public.recipient_contributions (christmas_recipient_id, contributor_id, planned_amount_pennies) values (recipient_id, contributor_id, amount) on conflict (christmas_recipient_id, contributor_id) do update set planned_amount_pennies = excluded.planned_amount_pennies;
    end loop;
  end loop;
end $$;
