update public.recipient_contributions rc
set planned_amount_pennies = 0, updated_at = now()
from public.christmas_recipients r
join public.people recipient_person on recipient_person.id = r.person_id
join public.contributors c on c.id = rc.contributor_id
join public.people contributor_person on contributor_person.id = c.person_id
where rc.christmas_recipient_id = r.id
  and recipient_person.name = 'Jaden'
  and contributor_person.name = 'Jade'
  and r.christmas_event_id = c.christmas_event_id;
