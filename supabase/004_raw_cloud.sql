-- V6.23 additive production Raw bridge. No legacy data or policies are removed.
-- Execute once as database owner after approval. Entire migration is transactional.
begin;
create table public.dashboard_raw_snapshots (
 id uuid primary key default gen_random_uuid(),
 upload_id uuid not null,
 uploaded_by uuid not null references auth.users(id),
 site text not null check (length(site) between 1 and 100),
 snapshot_date date not null,
 uploaded_at timestamptz not null default clock_timestamp(),
 source_filename text not null check(length(source_filename) between 1 and 500),
 row_count integer not null check(row_count between 1 and 50000),
 months text[] not null,
 checksum text not null,
 rows jsonb not null check(jsonb_typeof(rows)='array'),
 unique(uploaded_by,upload_id,site)
);
create index dashboard_raw_latest on public.dashboard_raw_snapshots(site,snapshot_date desc,uploaded_at desc,id desc);
alter table public.dashboard_raw_snapshots enable row level security;
revoke all on public.dashboard_raw_snapshots from anon,authenticated;
-- No direct table access is granted. RPC functions below check membership per call.
create table public.dashboard_raw_audit (
 id uuid primary key default gen_random_uuid(),actor_id uuid not null,
 action text not null,upload_id uuid,details jsonb not null default '{}'::jsonb,
 created_at timestamptz not null default clock_timestamp()
);
alter table public.dashboard_raw_audit enable row level security;
revoke all on public.dashboard_raw_audit from anon,authenticated;

create function dashboard_private.raw_allowed(p_site text,p_write boolean default false)
returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.dashboard_members m join auth.users u on u.id=m.user_id
 where m.user_id=auth.uid() and u.email_confirmed_at is not null and m.approval_status='approved'
 and m.role in ('admin','leader','viewer') and (not p_write or m.role in ('admin','leader'))
 and (m.role='admin' or p_site=any(m.allowed_sites)))
$$;
revoke all on function dashboard_private.raw_allowed(text,boolean) from public,anon,authenticated;

create function public.dashboard_raw_upload(p_upload_id uuid,p_snapshot date,p_filename text,p_rows jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r jsonb; s text; n integer; d date; payload jsonb; fingerprint text; existing public.dashboard_raw_snapshots; bid uuid; result jsonb='[]'::jsonb;
begin
 if auth.uid() is null or not exists(select 1 from public.dashboard_members where user_id=auth.uid() and approval_status='approved' and role in ('admin','leader')) then raise exception 'Approved uploader required'; end if;
 if p_upload_id is null or p_snapshot is null or p_snapshot>(now() at time zone 'Asia/Taipei')::date or p_snapshot<date '2000-01-01' then raise exception 'Invalid upload or snapshot date'; end if;
 if p_filename is null or length(trim(p_filename)) not between 1 and 500 then raise exception 'Invalid filename'; end if;
 if p_rows is null or jsonb_typeof(p_rows)<>'array' then raise exception 'Rows must be an array'; end if;
 n=jsonb_array_length(p_rows);
 if n not between 1 and 50000 or octet_length(p_rows::text)>20971520 then raise exception 'Upload exceeds 50000 rows or 20 MB'; end if;
 if exists(select 1 from jsonb_array_elements(p_rows) x group by x->>'id' having count(*)>1) then raise exception 'Duplicate ticket ID'; end if;
 for r in select value from jsonb_array_elements(p_rows) loop
  if jsonb_typeof(r)<>'object' then raise exception 'Invalid row'; end if;
  if exists(select 1 from jsonb_object_keys(r) k where k not in ('id','site','owner','group','type','status','created','handled','closed','due','sub_type','sub_type2','ticket_type')) then raise exception 'Unsupported field (descriptions/contact data are not accepted)'; end if;
  if not (r ?& array['id','site','owner','type','status','created','handled','closed','due']) then raise exception 'Missing required field'; end if;
  if exists(select 1 from jsonb_each(r) e where jsonb_typeof(e.value)<>'string' or length(e.value #>> '{}')>500) then raise exception 'Invalid field type or length'; end if;
  if length(trim(r->>'id')) not between 1 and 200 or length(trim(r->>'site')) not between 1 and 100 or r->>'site'<>trim(r->>'site') then raise exception 'Ticket and Site are required'; end if;
  if position('welltake' in lower(r->>'owner'))=0 or length(r->>'type')=0 or r->>'status' not in ('In Progress','Resolved','Closed','Cancelled') then raise exception 'Invalid scope/type/status'; end if;
  if not dashboard_private.raw_allowed(r->>'site',true) then raise exception 'Site not authorized'; end if;
  foreach s in array array['created','handled','closed','due'] loop
   if r->>s='' and s<>'created' then continue; end if;
   if r->>s !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'Invalid date format'; end if;
   d=(r->>s)::date;
   if to_char(d,'YYYY-MM-DD')<>r->>s or d<date '2000-01-01' then raise exception 'Invalid date'; end if;
   if s<>'due' and d>p_snapshot then raise exception 'Case date later than snapshot'; end if;
   if s in ('handled','closed') and d<(r->>'created')::date then raise exception 'Completion before creation'; end if;
  end loop;
 end loop;
 perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text||p_upload_id::text,0));
 for s in select distinct value->>'site' from jsonb_array_elements(p_rows) order by 1 loop
  select jsonb_agg(value order by value->>'id') into payload from jsonb_array_elements(p_rows) where value->>'site'=s;
  fingerprint=md5(jsonb_build_object('date',p_snapshot,'file',p_filename,'rows',payload)::text);
  select * into existing from public.dashboard_raw_snapshots where uploaded_by=auth.uid() and upload_id=p_upload_id and site=s;
  if found then
   if existing.checksum<>fingerprint then raise exception 'Upload token already used with different data'; end if;
   bid=existing.id;
  else
   insert into public.dashboard_raw_snapshots(upload_id,uploaded_by,site,snapshot_date,source_filename,row_count,months,checksum,rows)
   values(p_upload_id,auth.uid(),s,p_snapshot,p_filename,jsonb_array_length(payload),array(select distinct left(value->>'created',7) from jsonb_array_elements(payload) order by 1),fingerprint,payload) returning id into bid;
  end if;
  result=result||jsonb_build_array(jsonb_build_object('id',bid,'site',s));
 end loop;
 insert into public.dashboard_raw_audit(actor_id,action,upload_id,details) values(auth.uid(),'raw_upload',p_upload_id,jsonb_build_object('snapshot',p_snapshot,'rows',n,'batches',result));
 return result;
end $$;

create function public.dashboard_raw_sites() returns jsonb language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_agg(site order by site),'[]'::jsonb) from (select distinct site from public.dashboard_raw_snapshots where dashboard_private.raw_allowed(site)) s
$$;
create function public.dashboard_raw_catalog(p_site text) returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if not dashboard_private.raw_allowed(p_site) then raise exception 'Site not authorized'; end if;
 return (select coalesce(jsonb_agg(to_jsonb(s) order by snapshot_date desc,uploaded_at desc,id desc),'[]'::jsonb) from
 (select id,site,snapshot_date,uploaded_at,source_filename,row_count,months from public.dashboard_raw_snapshots where site=p_site) s);
end $$;
create function public.dashboard_raw_read(p_id uuid,p_site text) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
 if not dashboard_private.raw_allowed(p_site) then raise exception 'Site not authorized'; end if;
 select jsonb_build_object('id',id,'site',site,'snapshot_date',snapshot_date,'uploaded_at',uploaded_at,'source_filename',source_filename,'row_count',row_count,'rows',rows)
 into result from public.dashboard_raw_snapshots where id=p_id and site=p_site;
 if result is null then raise exception 'Snapshot not found'; end if;return result;
end $$;
create function public.dashboard_raw_review_member(p_user uuid,p_role text,p_status text,p_sites text[]) returns void
language plpgsql security definer set search_path='' as $$
begin
 if not dashboard_private.is_admin() then raise exception 'Administrator required'; end if;
 if p_user=auth.uid() or p_user is null then raise exception 'Cannot change own access'; end if;
 if p_role is null or p_role not in ('leader','viewer') or p_status is null or p_status not in ('approved','disabled') then raise exception 'Invalid role/status'; end if;
 if p_sites is null or (p_status='approved' and cardinality(p_sites)=0) then raise exception 'Choose authorized sites'; end if;
 if exists(select 1 from unnest(p_sites) s where s is null or not exists(select 1 from public.dashboard_raw_snapshots where site=s)) then raise exception 'Site has no uploaded baseline'; end if;
 update public.dashboard_members set role=p_role,approval_status=p_status,allowed_sites=p_sites where user_id=p_user and role<>'admin';
 if not found then raise exception 'Member not found or protected'; end if;
 insert into public.dashboard_raw_audit(actor_id,action,details) values(auth.uid(),'review_raw_member',jsonb_build_object('user',p_user,'role',p_role,'status',p_status,'sites',p_sites));
end $$;
revoke all on function public.dashboard_raw_upload(uuid,date,text,jsonb),public.dashboard_raw_sites(),public.dashboard_raw_catalog(text),public.dashboard_raw_read(uuid,text),public.dashboard_raw_review_member(uuid,text,text,text[]) from public,anon;
grant execute on function public.dashboard_raw_upload(uuid,date,text,jsonb),public.dashboard_raw_sites(),public.dashboard_raw_catalog(text),public.dashboard_raw_read(uuid,text),public.dashboard_raw_review_member(uuid,text,text,text[]) to authenticated;
commit;
