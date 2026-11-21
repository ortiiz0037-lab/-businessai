-- Runs after 10_rls_business.test.sql on a database with 0005, 0007, 0009.
\set ON_ERROR_STOP 1
do $$ begin
  perform t.ok((select public from storage.buckets where id = 'Company-signatures') = false,
               'Company-signatures bucket is private');
  perform t.ok((select allowed_mime_types from storage.buckets where id = 'Company-signatures')
               = array['image/png', 'image/jpeg', 'image/webp'], 'signatures: PNG/JPEG/WEBP only');
  perform t.ok((select file_size_limit from storage.buckets where id = 'Company-signatures') = 2097152,
               'signatures: 2 MB limit');
  perform t.ok((select public from storage.buckets where id = 'Company-assets') = true,
               'Company-assets (logos) stays public');
  perform t.ok((select allowed_mime_types from storage.buckets where id = 'Company-assets')
               = array['image/png', 'image/jpeg', 'image/webp'], 'logos: PNG/JPEG/WEBP only (no SVG/HTML)');
  perform t.ok((select file_size_limit from storage.buckets where id = 'Company-assets') = 5242880,
               'logos: 5 MB limit unchanged');
end $$;

do $$ begin
  perform t.as_user('userA'); set local role authenticated;
  insert into storage.objects (bucket_id, name, owner)
    values ('Company-signatures', t.id('coA') || '/signature-11111111-2222-4333-8444-555566667777.png', t.id('userA'));
  perform t.ok(true, 'owner A uploads a signature into its company folder');
  begin
    insert into storage.objects (bucket_id, name)
      values ('Company-signatures', t.id('coB') || '/signature-evil.png');
    perform t.ok(false, 'A cannot upload a signature into B''s folder');
  exception when insufficient_privilege then perform t.ok(true, 'A cannot upload a signature into B''s folder'); end;
  begin
    insert into storage.objects (bucket_id, name) values ('Company-signatures', 'signature-root.png');
    perform t.ok(false, 'A cannot upload a signature outside a company folder');
  exception when insufficient_privilege then perform t.ok(true, 'A cannot upload a signature outside a company folder'); end;
end $$;
do $$ begin
  perform t.as_user('userB'); set local role authenticated;
  insert into storage.objects (bucket_id, name, owner)
    values ('Company-signatures', t.id('coB') || '/signature-b.png', t.id('userB'));
end $$;

-- Signed URLs are issued only if the requester can SELECT the object.
do $$ begin
  perform t.as_user('userC'); set local role authenticated;
  perform t.ok(exists (select 1 from storage.objects where bucket_id = 'Company-signatures'
                       and name like t.id('coA') || '/%'),
               'member C can read company A''s signature (documents render for members)');
  perform t.ok(not exists (select 1 from storage.objects where bucket_id = 'Company-signatures'
                           and name like t.id('coB') || '/%'),
               'member C cannot read company B''s signature');
  begin
    insert into storage.objects (bucket_id, name) values ('Company-signatures', t.id('coA') || '/signature-c.png');
    perform t.ok(false, 'member C cannot upload a signature (owner/admin only)');
  exception when insufficient_privilege then perform t.ok(true, 'member C cannot upload a signature (owner/admin only)'); end;
end $$;
do $$ declare n int; begin
  perform t.as_user('userC'); set local role authenticated;
  delete from storage.objects where bucket_id = 'Company-signatures' and name like t.id('coA') || '/%';
  get diagnostics n = row_count;
  perform t.ok(n = 0, 'member C cannot delete signatures');
end $$;
do $$ declare n int; begin
  perform t.as_user('userA'); set local role authenticated;
  perform t.ok(not exists (select 1 from storage.objects where bucket_id = 'Company-signatures'
                           and name like t.id('coB') || '/%'), 'A cannot read B''s signature');
  update storage.objects set owner = t.id('userA')
   where bucket_id = 'Company-signatures' and name like t.id('coA') || '/%';
  get diagnostics n = row_count;
  perform t.ok(n = 0, 'nobody can overwrite a signature (no update policy)');
  delete from storage.objects where bucket_id = 'Company-signatures' and name like t.id('coB') || '/%';
  get diagnostics n = row_count;
  perform t.ok(n = 0, 'A cannot delete B''s signature');
end $$;
do $$ begin
  set local role anon;
  perform t.ok(not exists (select 1 from storage.objects where bucket_id = 'Company-signatures'),
               'anon cannot read any signature');
  begin
    insert into storage.objects (bucket_id, name) values ('Company-signatures', t.id('coA') || '/anon.png');
    perform t.ok(false, 'anon cannot upload a signature');
  exception when insufficient_privilege then perform t.ok(true, 'anon cannot upload a signature'); end;
end $$;
do $$ declare n int; begin
  perform t.as_user('userA'); set local role authenticated;
  delete from storage.objects where bucket_id = 'Company-signatures' and name like t.id('coA') || '/%';
  get diagnostics n = row_count;
  perform t.ok(n = 1, 'owner A can delete its replaced signature');
end $$;
do $$ begin
  perform t.ok(exists (select 1 from storage.objects where bucket_id = 'Company-assets'
                       and name = t.id('coA') || '/logo-1.png'), 'logos untouched by 0009');
end $$;
do $$ begin raise notice 'ALL SIGNATURE TESTS PASSED'; end $$;
