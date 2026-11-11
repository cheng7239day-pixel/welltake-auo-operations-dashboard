-- Synthetic tests. Run after 004_raw_cloud.sql. Everything is rolled back.
begin;
insert into auth.users(id,email,email_confirmed_at) values
('62300000-0000-4000-8000-000000000001','v623-leader@example.invalid',now()),
('62300000-0000-4000-8000-000000000002','v623-viewer@example.invalid',now()),
('62300000-0000-4000-8000-000000000003','v623-pending@example.invalid',now());
insert into public.dashboard_members(user_id,display_name,role,approval_status,allowed_sites) values
('62300000-0000-4000-8000-000000000001','Synthetic leader','leader','approved',array['TEST-RAW-A']),
('62300000-0000-4000-8000-000000000002','Synthetic viewer','viewer','approved',array['TEST-RAW-A']),
('62300000-0000-4000-8000-000000000003','Synthetic pending','viewer','pending',array['TEST-RAW-A']);
select set_config('request.jwt.claims','{"sub":"62300000-0000-4000-8000-000000000001","role":"authenticated"}',true);
set local role authenticated;
do $$
declare p jsonb='[{"id":"SYNTHETIC-1","site":"TEST-RAW-A","owner":"welltake-demo","type":"Incident","status":"In Progress","created":"2026-10-01","handled":"","closed":"","due":""}]';a jsonb;b jsonb;denied boolean;
begin
 a=public.dashboard_raw_upload('62300000-0000-4000-8000-000000000010','2026-11-03','synthetic.csv',p);
 b=public.dashboard_raw_upload('62300000-0000-4000-8000-000000000010','2026-11-03','synthetic.csv',p);
 if a<>b then raise exception 'Retry idempotency failed'; end if;
 perform public.dashboard_raw_upload('62300000-0000-4000-8000-000000000011','2026-11-02','older.csv',p);
 if public.dashboard_raw_catalog('TEST-RAW-A')->0->>'snapshot_date'<>'2026-11-03' then raise exception 'Backfill replaced latest'; end if;
 if jsonb_array_length(public.dashboard_raw_catalog('TEST-RAW-A'))<>2 then raise exception 'Unexpected revision count'; end if;
 denied=false;begin perform public.dashboard_raw_upload('62300000-0000-4000-8000-000000000012','2026-11-03','unauthorized.csv',replace(p::text,'TEST-RAW-A','TEST-RAW-B')::jsonb);exception when others then denied=true;end;if not denied then raise exception 'Cross-site upload permitted';end if;
 denied=false;begin perform public.dashboard_raw_upload('62300000-0000-4000-8000-000000000013','2026-11-03','extra-field.csv',jsonb_build_array((p->0)||'{"description":"must not upload"}'::jsonb));exception when others then denied=true;end;if not denied then raise exception 'Unsupported sensitive field permitted';end if;
 denied=false;begin perform public.dashboard_raw_upload('62300000-0000-4000-8000-000000000014','2026-11-03','duplicate.csv',p||p);exception when others then denied=true;end;if not denied then raise exception 'Duplicate ID permitted';end if;
 denied=false;begin perform public.dashboard_raw_read((a->0->>'id')::uuid,'TEST-RAW-B');exception when others then denied=true;end;if not denied then raise exception 'Cross-site read permitted';end if;
 denied=false;begin perform count(*) from public.dashboard_raw_snapshots;exception when insufficient_privilege then denied=true;end;if not denied then raise exception 'Direct table read permitted';end if;
 if has_function_privilege('anon','public.dashboard_raw_upload(uuid,date,text,jsonb)','EXECUTE') or has_function_privilege('anon','public.dashboard_raw_read(uuid,text)','EXECUTE') then raise exception 'Anonymous RPC permitted';end if;
end $$;
reset role;
select set_config('request.jwt.claims','{"sub":"62300000-0000-4000-8000-000000000002","role":"authenticated"}',true);
set local role authenticated;
do $$
declare c jsonb;denied boolean=false;
begin
 c=public.dashboard_raw_catalog('TEST-RAW-A');
 if public.dashboard_raw_read((c->0->>'id')::uuid,'TEST-RAW-A')->>'row_count'<>'1' then raise exception 'Viewer read failed';end if;
 begin perform public.dashboard_raw_upload('62300000-0000-4000-8000-000000000015','2026-11-03','viewer.csv','[{"id":"VIEWER-1","site":"TEST-RAW-A","owner":"welltake-demo","type":"Incident","status":"In Progress","created":"2026-10-01","handled":"","closed":"","due":""}]');exception when others then denied=true;end;
 if not denied then raise exception 'Viewer upload permitted';end if;
end $$;
reset role;
select set_config('request.jwt.claims','{"sub":"62300000-0000-4000-8000-000000000003","role":"authenticated"}',true);
set local role authenticated;
do $$declare denied boolean=false;begin
 begin perform public.dashboard_raw_catalog('TEST-RAW-A');exception when others then denied=true;end;
 if not denied then raise exception 'Pending account read permitted';end if;
end $$;
reset role;
update public.dashboard_members set approval_status='disabled' where user_id='62300000-0000-4000-8000-000000000001';
select set_config('request.jwt.claims','{"sub":"62300000-0000-4000-8000-000000000001","role":"authenticated"}',true);
set local role authenticated;
do $$declare denied boolean=false;begin
 begin perform public.dashboard_raw_catalog('TEST-RAW-A');exception when others then denied=true;end;
 if not denied then raise exception 'Disabled account read permitted';end if;
end $$;
reset role;
select 'PASS: leader/viewer/pending/disabled, cross-site, no anon/direct access, idempotency, backfill, validation' as result;
rollback;
