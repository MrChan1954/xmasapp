do $$
declare event_id uuid;
begin
  select id into event_id from public.christmas_events where year = 2026;
  insert into public.people (name) values
    ('Mum'), ('Dad'), ('Jade'), ('Kirsten'), ('Paige'), ('Taylor'), ('Eden'), ('Lucas'), ('Eliza'), ('Maggie'), ('Harry'), ('Grandma'), ('Joanne'), ('Ian'), ('Owen'), ('Reece'), ('Kerry'), ('Glynn'), ('Jaden');
  insert into public.christmas_recipients (christmas_event_id, person_id, budget_pennies)
  select event_id, p.id, case p.name
    when 'Mum' then 10000 when 'Dad' then 10000 when 'Jade' then 4500 when 'Kirsten' then 4500 when 'Paige' then 4500 when 'Taylor' then 4500 when 'Eden' then 6000 when 'Lucas' then 4500 when 'Eliza' then 4500 when 'Maggie' then 4500 when 'Harry' then 4500 when 'Grandma' then 6000 when 'Joanne' then 6000 when 'Ian' then 4000 when 'Owen' then 3000 when 'Reece' then 4000 when 'Kerry' then 4000 when 'Glynn' then 2000 when 'Jaden' then 4500 end
  from public.people p where p.name in ('Mum','Dad','Jade','Kirsten','Paige','Taylor','Eden','Lucas','Eliza','Maggie','Harry','Grandma','Joanne','Ian','Owen','Reece','Kerry','Glynn','Jaden');
end $$;
