alter table messages enable row level security;

revoke all on messages from anon, authenticated;
grant all on messages to service_role;