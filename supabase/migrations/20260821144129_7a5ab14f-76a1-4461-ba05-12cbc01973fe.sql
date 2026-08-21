select vault.create_secret('838316b25fc6feb9f055d7851f9cdf9933e6bff53aa64ae6f4fea43e515d8dc9', 'umraio_cron_secret', 'Shared secret for authorising scheduled autonomy hooks');

select cron.alter_job(1, command := $cmd$
  select net.http_post(
    url:='https://project--34af2e6d-598c-48a2-a52d-f7cca0cbb051.lovable.app/api/public/hooks/task-engine',
    headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'umraio_cron_secret')),
    body:='{}'::jsonb
  ) as request_id;
$cmd$);

select cron.alter_job(2, command := $cmd$
  select net.http_post(
    url:='https://project--34af2e6d-598c-48a2-a52d-f7cca0cbb051.lovable.app/api/public/hooks/executive-autonomy',
    headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'umraio_cron_secret')),
    body:='{}'::jsonb
  ) as request_id;
$cmd$);