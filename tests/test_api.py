import asyncio, json, os, time, unittest
from pathlib import Path
from unittest.mock import patch
from argon2 import PasswordHasher
from fastapi.testclient import TestClient
os.environ.update(APP_PASSWORD_HASH=PasswordHasher().hash('test-password-only'),SESSION_SECRET='x'*48,COOKIE_SECURE='false',APP_ORIGIN='http://testserver',
 SUPABASE_URL='https://example.supabase.co',VAPID_PRIVATE_KEY='Q'*43,SUPABASE_SECRET_KEY='k',AGENT_TOKEN='a'*40,CRON_SECRET='c'*32)
JOB='0b8c6c1e-1111-4222-8333-444455556666'
import base64
push_b64=lambda t:base64.urlsafe_b64decode(t+'='*(-len(t)%4))
AGENT={'Authorization':'Bearer '+'a'*40}

class FakeSupabase:
 def __init__(self,existing=None,claim=None):self.calls=[];self.existing=existing or [];self.claim=claim or []
 async def __call__(self,method,path,**kw):
  self.calls.append((method,path,kw))
  if path=='/rest/v1/agents' and method=='GET':
   from datetime import datetime,timezone
   return [{'last_seen':datetime.now(timezone.utc).isoformat()}]
  if path=='/rest/v1/rpc/claim_job':return self.claim
  if path=='/storage/v1/object/sign/transfers':return [{'path':x,'signedURL':'/object/sign/transfers/'+x+'?token=t'} for x in kw['json']['paths']]
  if '/object/list/' in path:return [{'name':'audio.000'},{'name':'cover.jpg'}]
  if '/upload/sign/' in path:return {'url':'/object/upload/sign/'+path.split('/sign/',1)[1]+'?token=t'}
  if method=='GET':return self.existing
  if method=='POST' and path=='/rest/v1/jobs':return [{'id':JOB,**kw['json']}]
  return None
from api.index import app, canonical_url, signature, _attempts, stop

class SecurityTests(unittest.TestCase):
 def setUp(self):
  _attempts.clear();self.c=TestClient(app)
 def sign_in(self):
  self.assertEqual(self.c.post('/api/auth/login',json={'password':'test-password-only'}).status_code,200)
 def test_unauthenticated(self):
  for path in ['/api/auth/session','/api/health']:
   self.assertEqual(self.c.get(path).status_code,401)
  self.assertEqual(self.c.post('/api/search',json={'query':'test'}).status_code,401)
 def test_login_logout_cookie(self):
  self.assertEqual(self.c.post('/api/auth/login',json={'password':'bad'}).status_code,401)
  r=self.c.post('/api/auth/login',json={'password':'test-password-only'})
  self.assertIn('HttpOnly',r.headers['set-cookie']);self.assertIn('SameSite=strict',r.headers['set-cookie'])
  self.assertEqual(self.c.get('/api/auth/session').status_code,200)
  expiry=self.c.get('/api/auth/session').json()['expires'];self.assertAlmostEqual(expiry-time.time(),30*86400,delta=3)
  self.c.post('/api/auth/logout');self.assertEqual(self.c.get('/api/auth/session').status_code,401)
 def test_expired_and_tampered(self):
  value=f'{int(time.time())-1}.nonce';self.c.cookies.set('soriham_session',value+'.'+signature(value))
  self.assertEqual(self.c.get('/api/auth/session').status_code,401)
  self.c.cookies.set('soriham_session','9999999999.nonce.fake');self.assertEqual(self.c.get('/api/auth/session').status_code,401)
 def test_ssrf_and_canonicalization(self):
  self.assertEqual(canonical_url('https://youtu.be/QfzmglQwSCk?list=x'),'https://www.youtube.com/watch?v=QfzmglQwSCk')
  for url in ['http://youtube.com/watch?v=QfzmglQwSCk','https://youtube.com.evil.test/watch?v=QfzmglQwSCk','https://127.0.0.1','file:///etc/passwd','https://user@youtube.com/watch?v=QfzmglQwSCk','https://youtube.com:444/watch?v=QfzmglQwSCk','https://youtu.be/--exec']:
   with self.assertRaises(Exception):canonical_url(url)
 def test_csrf(self):
  r=self.c.post('/api/auth/login',json={'password':'test-password-only'},headers={'Origin':'https://evil.test'})
  self.assertEqual(r.status_code,403)
 def test_job_requires_valid_youtube_url(self):
  self.sign_in()
  with patch('api.index.sb',FakeSupabase()):
   self.assertEqual(self.c.post('/api/jobs',json={'url':'https://127.0.0.1'}).status_code,400)
 def test_search_sort_is_passed_and_validated(self):
  self.sign_in();seen=[]
  async def fake_spawn(*args):
   seen.append(args)
   return await asyncio.create_subprocess_exec(os.sys.executable,'-c','import json;print(json.dumps({"items":[{"id":"QfzmglQwSCk","views":123456}]}))',stdout=asyncio.subprocess.PIPE,start_new_session=True)
  with patch('api.index.spawn',fake_spawn):
   r=self.c.post('/api/search',json={'query':'lofi','sort':'views'})
   self.assertEqual(r.json()[0]['views'],123456);self.assertEqual(seen[-1],('search','lofi','views','20'))
   self.assertEqual(self.c.post('/api/search',json={'query':'lofi','sort':'random'}).status_code,422)
   self.c.post('/api/search',json={'query':'lofi','limit':60});self.assertEqual(seen[-1],('search','lofi','relevance','60'))
   self.assertEqual(self.c.post('/api/search',json={'query':'lofi','limit':80}).status_code,422)
 def test_agent_complete_records_source_codec(self):
  fake=FakeSupabase(existing=[{'id':JOB}])
  with patch('api.index.sb',fake):
   self.assertEqual(self.c.post(f'/api/agent/jobs/{JOB}/complete',json={'title':'t','artist':'a','duration':1,'source_codec':'aac'},headers=AGENT).status_code,200)
  self.assertEqual([c for c in fake.calls if c[0]=='PATCH'][0][2]['json']['source_codec'],'aac')
 def test_complete_stores_peaks_clamped(self):
  fake=FakeSupabase(existing=[{'id':JOB}])
  with patch('api.index.sb',fake):
   self.assertEqual(self.c.post(f'/api/agent/jobs/{JOB}/complete',json={'title':'t','artist':'a','duration':1,'peaks':[0,50,100,130]},headers=AGENT).status_code,200)
   self.assertEqual(self.c.post(f'/api/agent/jobs/{JOB}/complete',json={'title':'t','artist':'a','duration':1,'peaks':[1]*1001},headers=AGENT).status_code,422)
  self.assertEqual([c for c in fake.calls if c[0]=='PATCH'][0][2]['json']['peaks'],[0,50,100,100])
 def test_library_sync_keeps_trim(self):
  self.sign_in();fake=FakeSupabase()
  with patch('api.index.sb',fake):
   self.assertEqual(self.c.post('/api/library/sync',json={'tracks':[{'video_id':'QfzmglQwSCk','title':'t','artist':'a','duration':271,'trim_start':42,'trim_end':245.5}]}).status_code,200)
   self.assertEqual(self.c.post('/api/library/sync',json={'tracks':[{'video_id':'QfzmglQwSCk','title':'t','artist':'a','duration':271,'trim_start':-1}]}).status_code,422)
  row=[c for c in fake.calls if c[:2]==('POST','/rest/v1/library_tracks')][0][2]['json'][0]
  self.assertEqual((row['trim_start'],row['trim_end']),(42,245.5))
 def test_agent_fail_strips_signed_urls(self):
  fake=FakeSupabase(existing=[{'id':JOB}])
  with patch('api.index.sb',fake):
   self.c.post(f'/api/agent/jobs/{JOB}/fail',json={'error':'413 for https://x.supabase.co/storage/v1/object/upload/sign/transfers/a/audio.m4a?token=eyJsecret'},headers=AGENT)
  err=[c for c in fake.calls if c[0]=='PATCH'][0][2]['json']['error']
  self.assertNotIn('eyJsecret',err)
 def test_throttle(self):
  for _ in range(5):self.c.post('/api/auth/login',json={'password':'bad'})
  self.assertEqual(self.c.post('/api/auth/login',json={'password':'bad'}).status_code,429)
 def test_create_job_without_permission_flag(self):
  self.sign_in();fake=FakeSupabase()
  with patch('api.index.sb',fake):
   r=self.c.post('/api/jobs',json={'url':'https://youtu.be/QfzmglQwSCk','title':'Song'})
  self.assertEqual(r.status_code,200)
  inserted=[c for c in fake.calls if c[0]=='POST' and c[1]=='/rest/v1/jobs'][0][2]['json']
  self.assertEqual(inserted['video_id'],'QfzmglQwSCk');self.assertTrue(inserted['thumbnail'].startswith('https://i.ytimg.com/'))
 def test_existing_active_job_is_not_duplicated(self):
  self.sign_in();fake=FakeSupabase(existing=[{'id':'x','video_id':'QfzmglQwSCk'}])
  with patch('api.index.sb',fake):
   r=self.c.post('/api/jobs',json={'url':'https://youtu.be/QfzmglQwSCk'})
  self.assertEqual(r.json()['id'],'x');self.assertFalse([c for c in fake.calls if c[0]=='POST'])
 def test_list_jobs_signs_ready_files(self):
  self.sign_in();fake=FakeSupabase(existing=[{'id':JOB,'status':'ready','parts':3},{'id':'q','status':'queued','parts':None},{'id':'old','status':'ready','parts':None}])
  with patch('api.index.sb',fake):r=self.c.get('/api/jobs').json()
  self.assertEqual([u.split('/')[-1] for u in r['jobs'][0]['audio_urls']],['audio.000?token=t','audio.001?token=t','audio.002?token=t'])
  self.assertTrue(r['jobs'][0]['cover_url'].endswith('/cover.jpg?token=t'));self.assertNotIn('audio_urls',r['jobs'][1])
  self.assertTrue(r['jobs'][2]['audio_urls'][0].endswith('/audio.m4a?token=t'))
  self.assertTrue(r['agent']['online'])
 def test_received_deletes_files_and_record(self):
  self.sign_in();fake=FakeSupabase()
  with patch('api.index.sb',fake):self.assertEqual(self.c.post(f'/api/jobs/{JOB}/received',json={}).status_code,200)
  deleted=[c for c in fake.calls if c[:2]==('DELETE','/storage/v1/object/transfers')][0][2]['json']['prefixes']
  self.assertEqual(deleted,[f'{JOB}/audio.000',f'{JOB}/cover.jpg'])
  self.assertIn(('DELETE','/rest/v1/jobs'),[c[:2] for c in fake.calls])
  self.assertEqual(self.c.post('/api/jobs/../x/received',json={}).status_code,404)
 def test_received_backs_up_track_text_only(self):
  self.sign_in();fake=FakeSupabase(existing=[{'video_id':'QfzmglQwSCk','title':'Song','artist':'A','duration':200,'source_codec':'aac'}])
  with patch('api.index.sb',fake):self.assertEqual(self.c.post(f'/api/jobs/{JOB}/received',json={}).status_code,200)
  ins=[c for c in fake.calls if c[:2]==('POST','/rest/v1/library_tracks')][0]
  self.assertEqual(ins[2]['json'],{'video_id':'QfzmglQwSCk','title':'Song','artist':'A','duration':200,'codec':'aac'})
  self.assertEqual(ins[2]['headers'],{'Prefer':'resolution=ignore-duplicates'})
 def test_library_sync_and_fetch(self):
  self.sign_in();fake=FakeSupabase(existing=[{'video_id':'QfzmglQwSCk','title':'t','artist':'a','duration':1,'codec':None}])
  body={'tracks':[{'video_id':'QfzmglQwSCk','title':'Edited','artist':'a','duration':1,'codec':'aac'}],'delete_tracks':['AAAAAAAAAAA'],
        'playlists':[{'id':'pl-1','name':'출근','tracks':['QfzmglQwSCk']}],'delete_playlists':['pl-2']}
  with patch('api.index.sb',fake):
   self.assertEqual(self.c.post('/api/library/sync',json=body).status_code,200)
   self.assertEqual(self.c.post('/api/library/sync',json={'delete_tracks':['../x']}).status_code,400)
   self.assertEqual(self.c.post('/api/library/sync',json={'tracks':[{'video_id':'bad','title':'','artist':'','duration':0}]}).status_code,422)
   self.assertEqual(self.c.get('/api/library').json()['tracks'][0]['video_id'],'QfzmglQwSCk')
  calls=[c[:2] for c in fake.calls]
  self.assertIn(('POST','/rest/v1/library_tracks'),calls);self.assertIn(('POST','/rest/v1/library_playlists'),calls)
  dels=[c[2]['params'] for c in fake.calls if c[0]=='DELETE']
  self.assertIn({'video_id':'in.("AAAAAAAAAAA")'},dels);self.assertIn({'id':'in.("pl-2")'},dels)
 def test_library_requires_login_and_allows_large_sync(self):
  self.assertEqual(self.c.get('/api/library').status_code,401)
  self.sign_in();big={'tracks':[{'video_id':'QfzmglQwSCk','title':'x'*290,'artist':'y'*190,'duration':1} for _ in range(300)]}
  with patch('api.index.sb',FakeSupabase()):
   self.assertEqual(self.c.post('/api/library/sync',json=big).status_code,200)
   self.assertEqual(self.c.post('/api/jobs',json={'url':'https://youtu.be/QfzmglQwSCk','title':'x'*9000}).status_code,413)
 def test_push_subscribe_validates_endpoint(self):
  self.sign_in();fake=FakeSupabase()
  keys={'p256dh':'B'+'A'*86,'auth':'A'*22}
  with patch('api.index.sb',fake):
   self.assertEqual(len(push_b64(self.c.get('/api/push/key').json()['key'])),65)
   self.assertEqual(self.c.post('/api/push/subscribe',json={'endpoint':'https://evil.test/x','keys':keys}).status_code,400)
   self.assertEqual(self.c.post('/api/push/subscribe',json={'endpoint':'https://web.push.apple.com/abc','keys':keys}).status_code,200)
  self.assertIn(('POST','/rest/v1/push_subscriptions'),[c[:2] for c in fake.calls])
 def test_complete_sends_push_and_drops_expired(self):
  from cryptography.hazmat.primitives.asymmetric import ec
  from cryptography.hazmat.primitives import serialization
  import base64
  ua=ec.generate_private_key(ec.SECP256R1()).public_key().public_bytes(serialization.Encoding.X962,serialization.PublicFormat.UncompressedPoint)
  b=lambda x:base64.urlsafe_b64encode(x).rstrip(b'=').decode()
  subs=[{'endpoint':'https://web.push.apple.com/live','p256dh':b(ua),'auth':b(os.urandom(16))},{'endpoint':'https://web.push.apple.com/gone','p256dh':b(ua),'auth':b(os.urandom(16))}]
  class Fake(FakeSupabase):
   async def __call__(self,method,path,**kw):
    if path=='/rest/v1/push_subscriptions' and method=='GET':self.calls.append((method,path,kw));return subs
    return await super().__call__(method,path,**kw)
  fake=Fake(existing=[{'id':JOB}]);posted=[]
  class R:
   def __init__(s,c):s.status_code=c;s.text=''
  async def post(self,url,headers=None,content=None):
   posted.append((url,headers));return R(410 if url.endswith('gone') else 201)
  with patch('api.index.sb',fake),patch('httpx.AsyncClient.post',post):
   self.assertEqual(self.c.post(f'/api/agent/jobs/{JOB}/complete',json={'title':'곡','artist':'a','duration':1},headers=AGENT).status_code,200)
  self.assertEqual(len(posted),2);self.assertTrue(posted[0][1]['Authorization'].startswith('vapid t='))
  self.assertIn(('DELETE','/rest/v1/push_subscriptions'),[c[:2] for c in fake.calls])
 def test_agent_requires_token(self):
  with patch('api.index.sb',FakeSupabase()):
   self.assertEqual(self.c.post('/api/agent/claim').status_code,401)
   self.assertEqual(self.c.post('/api/agent/claim',headers={'Authorization':'Bearer wrong'}).status_code,401)
   self.sign_in();self.assertEqual(self.c.post('/api/agent/claim').status_code,401)
 def test_agent_claim_returns_upload_urls(self):
  fake=FakeSupabase(claim=[{'id':JOB,'video_id':'QfzmglQwSCk','title':'t','artist':'a','duration':1,'thumbnail':None}])
  with patch('api.index.sb',fake):r=self.c.post('/api/agent/claim',headers=AGENT).json()
  self.assertEqual(r['job']['url'],'https://www.youtube.com/watch?v=QfzmglQwSCk')
  self.assertIn('/upload/sign/',r['job']['upload']['audio'])
 def test_agent_v2_gets_chunk_upload_urls(self):
  fake=FakeSupabase(existing=[{'id':JOB}],claim=[{'id':JOB,'video_id':'QfzmglQwSCk','title':'t','artist':'a','duration':1,'thumbnail':None}])
  with patch('api.index.sb',fake):
   job=self.c.post('/api/agent/claim',headers=AGENT|{'X-Agent-Version':'2'}).json()['job']
   self.assertNotIn('upload',job)
   r=self.c.post(f'/api/agent/jobs/{JOB}/uploads',json={'parts':15,'size':600_000_000},headers=AGENT).json()
   self.assertEqual(self.c.post(f'/api/agent/jobs/{JOB}/uploads',json={'parts':41,'size':1},headers=AGENT).status_code,422)
  self.assertEqual(len(r['audio']),15);self.assertIn('/audio.014?token=t',r['audio'][-1]);self.assertIn('/cover.jpg',r['cover'])
 def test_agent_requeue(self):
  fake=FakeSupabase(existing=[{'id':JOB}])
  with patch('api.index.sb',fake):self.assertEqual(self.c.post(f'/api/agent/jobs/{JOB}/requeue',headers=AGENT).status_code,200)
  self.assertEqual([c for c in fake.calls if c[0]=='PATCH'][0][2]['json']['status'],'queued')
  with patch('api.index.sb',FakeSupabase()):self.assertEqual(self.c.post(f'/api/agent/jobs/{JOB}/requeue',headers=AGENT).status_code,409)
 def test_agent_progress_on_cancelled_job_conflicts(self):
  with patch('api.index.sb',FakeSupabase(existing=[])):
   self.assertEqual(self.c.post(f'/api/agent/jobs/{JOB}/progress',json={'stage':'다운로드','percent':5},headers=AGENT).status_code,409)
 def test_cron_requires_secret(self):
  with patch('api.index.sb',FakeSupabase(existing=[{'id':JOB}])):
   self.assertEqual(self.c.get('/api/cron/cleanup').status_code,401)
   self.assertEqual(self.c.get('/api/cron/cleanup',headers={'Authorization':'Bearer '+'c'*32}).json(),{'deleted':1})

class CancellationTests(unittest.IsolatedAsyncioTestCase):
 async def test_stop_kills_process_group(self):
  proc=await asyncio.create_subprocess_exec(os.sys.executable,'-c','import time; time.sleep(120)',start_new_session=True)
  await stop(proc);self.assertIsNotNone(proc.returncode)

if __name__=='__main__':unittest.main()
