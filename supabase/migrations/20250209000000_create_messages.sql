create table messages (
  id uuid primary key default gen_random_uuid(),
  dialpad_id text unique not null,
  contact_id text not null,
  created_date timestamptz not null,
  device_type text,
  direction text not null,
  from_number text not null,
  message_status text not null default 'pending',
  target_id text,
  target_type text,
  text text,
  to_numbers text[] not null
);

alter table messages enable row level security;

create index idx_messages_contact_id on messages (contact_id);
create index idx_messages_message_status on messages (message_status);
create index idx_messages_created_date on messages (created_date);

revoke all on messages from anon, authenticated;
grant all on messages to service_role;
