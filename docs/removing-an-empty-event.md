# Removing an event that was never used

Sometimes an event gets created by accident — a test, a mistyped name, a second
copy of something. This is how one is removed, and why almost every event
**cannot** be.

## The rule

An event can be **deleted** only while it holds none of these:

| Category | Table |
| --- | --- |
| Purchases | `purchases` |
| Responsibility snapshots | `purchase_allocations` |
| Payments | `settlements` |
| Confirmations and rejections | `payment_receipts` |
| Gift ideas | `gift_ideas` |

The moment **any** of them exists, the event is history. It can be **archived**
— which takes it off the list and keeps every record — and that is the only way
to put it away.

There is no override, no admin escape hatch and no force flag. The rule is
enforced by `delete_event_if_empty` in migration 027, which checks all five
categories and performs the delete **in the same statement**, so a purchase
recorded a moment earlier cannot be lost to a delete that was decided a moment
before it.

Two further safety nets sit underneath, and both predate this feature:

- `purchases.christmas_recipient_id` and `settlements.christmas_event_id` are
  `ON DELETE RESTRICT`. Even if the checks above were wrong, PostgreSQL would
  refuse the delete rather than lose money.
- `gift_ideas` is `ON DELETE CASCADE` from its recipient, which is exactly why
  it is checked explicitly — the database would have removed those quietly.

## What a delete takes with it

Only setup rows, by cascades that already existed:

```
events ─┬─ christmas_recipients ── recipient_contributions
        └─ contributors         ── recipient_contributions
```

What it does **not** take:

- **The audit log.** The removal is written to `audit_log` *before* the row
  disappears, so the record that this event existed and was deleted outlives it.
  `audit_log.record_id` has no foreign key, so nothing cascades it away.
- **Birthdays.** A birthday belongs to a person, not to an occasion. Deleting a
  birthday occurrence changes nothing about the date.
- **Birthday reminders.** `birthday_reminders` is keyed on the person and the
  occurrence year, not on an event, so reminder history is untouched.

One cosmetic consequence: a notification sent earlier that links to
`/events/<deleted id>` will land on a 404. Nothing breaks; the link is simply
stale.

## Doing it in the app

1. Sign in as the Global Admin.
2. Open the event → **More** → **Event settings**.
3. If the event is empty, a **Delete** section appears at the bottom. If it does
   not appear, the event is not empty — archive it instead.
4. **Delete this event** → confirm.

The screen hides the control when it finds anything; the database refuses the
call when it finds anything. The first is a courtesy, the second is the rule.

## Auditing an event before you touch it

The app's answer is the Delete section itself: it is shown only when all five
categories are empty, and the refusal message names the first category it found
and how many rows are in it.

To check by hand — read-only, changes nothing — run this in the Supabase SQL
editor with the event's id:

```sql
select
  event.name,
  event.event_type,
  event.event_date,
  event.status,
  (select count(*) from public.christmas_recipients r
    where r.christmas_event_id = event.id)                       as recipients,
  (select count(*) from public.contributors c
    where c.christmas_event_id = event.id)                       as contributors,
  (select count(*) from public.purchases p
     join public.christmas_recipients r on r.id = p.christmas_recipient_id
    where r.christmas_event_id = event.id)                       as purchases,
  (select count(*) from public.purchase_allocations a
     join public.purchases p on p.id = a.purchase_id
     join public.christmas_recipients r on r.id = p.christmas_recipient_id
    where r.christmas_event_id = event.id)                       as allocations,
  (select count(*) from public.settlements s
    where s.christmas_event_id = event.id)                       as payments,
  (select count(*) from public.payment_receipts pr
    where pr.christmas_event_id = event.id)                      as receipts,
  (select count(*) from public.gift_ideas gi
     join public.christmas_recipients r on r.id = gi.christmas_recipient_id
    where r.christmas_event_id = event.id)                       as gift_ideas
from public.events as event
where event.id = '<event id>';
```

`recipients` and `contributors` are setup, not activity: an empty event is
expected to have them, and they are what the delete cascades away. Every other
column must read `0` for the event to be deletable.

To find a birthday occurrence's id by name:

```sql
select id, name, event_date, status
from public.events
where event_type = 'birthday'
order by event_date desc;
```
