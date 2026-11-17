import asyncio, base64, json, os, tempfile, time, unittest
from pathlib import Path
from unittest.mock import patch
from argon2 import PasswordHasher
from fastapi.testclient import TestClient
os.environ.update(APP_PASSWORD_HASH=PasswordHasher().hash('test-password-only'),SESSION_SECRET='x'*48,COOKIE_SECURE='false',APP_ORIGIN='http://testserver')
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
 def test_permission_and_invalid_url(self):
  self.sign_in();self.assertEqual(self.c.post('/api/import/convert',json={'url':'https://youtu.be/QfzmglQwSCk','permitted':False}).status_code,400)
  self.assertEqual(self.c.post('/api/import/convert',json={'url':'https://127.0.0.1','permitted':True}).status_code,400)
 def test_throttle(self):
  for _ in range(5):self.c.post('/api/auth/login',json={'password':'bad'})
  self.assertEqual(self.c.post('/api/auth/login',json={'password':'bad'}).status_code,429)
 def test_stream_and_cleanup(self):
  self.sign_in();folders=[]
  async def fake_spawn(*args):
   folder=Path(args[-1]);folders.append(folder);(folder/'audio.m4a').write_bytes(b'actual-test-audio')
   script='import json; print(json.dumps({"type":"ready","track":{"id":"QfzmglQwSCk","title":"Test"}}),flush=True)'
   return await asyncio.create_subprocess_exec(os.sys.executable,'-c',script,stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.DEVNULL,start_new_session=True)
  with patch('api.index.spawn',fake_spawn):
   r=self.c.post('/api/import/convert',json={'url':'https://youtu.be/QfzmglQwSCk','permitted':True})
  events=[json.loads(x) for x in r.text.splitlines()];self.assertEqual(events[-1]['type'],'done')
  self.assertEqual(b''.join(base64.b64decode(x['data']) for x in events if x['type']=='audio'),b'actual-test-audio')
  self.assertTrue(all(not p.exists() for p in folders))
 def test_failed_stream_cleans_up(self):
  self.sign_in();folders=[]
  async def fake_spawn(*args):
   folder=Path(args[-1]);folders.append(folder);(folder/'partial.part').write_bytes(b'partial')
   return await asyncio.create_subprocess_exec(os.sys.executable,'-c','raise SystemExit(1)',stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.DEVNULL,start_new_session=True)
  with patch('api.index.spawn',fake_spawn):r=self.c.post('/api/import/convert',json={'url':'https://youtu.be/QfzmglQwSCk','permitted':True})
  self.assertEqual(json.loads(r.text.splitlines()[-1])['type'],'error');self.assertTrue(all(not p.exists() for p in folders))

class CancellationTests(unittest.IsolatedAsyncioTestCase):
 async def test_disconnect_stops_process_and_removes_partial_file(self):
  started=asyncio.Event();folders=[];processes=[]
  async def fake_spawn(*args):
   folder=Path(args[-1]);folders.append(folder);(folder/'partial.part').write_bytes(b'partial')
   proc=await asyncio.create_subprocess_exec(os.sys.executable,'-c','import time; time.sleep(120)',stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.DEVNULL,start_new_session=True)
   processes.append(proc);started.set();return proc
  body=json.dumps({'url':'https://youtu.be/QfzmglQwSCk','permitted':True}).encode()
  value=f'{int(time.time())+1000}.disconnecttest';token=value+'.'+signature(value)
  sent=[False]
  async def receive():
   if not sent[0]:sent[0]=True;return {'type':'http.request','body':body,'more_body':False}
   await started.wait();await asyncio.sleep(.05);return {'type':'http.disconnect'}
  async def send(message):pass
  scope={'type':'http','asgi':{'version':'3.0','spec_version':'2.3'},'http_version':'1.1','method':'POST','scheme':'http','path':'/api/import/convert','raw_path':b'/api/import/convert','query_string':b'','root_path':'','server':('testserver',80),'client':('127.0.0.1',1234),'headers':[(b'content-type',b'application/json'),(b'cookie',('soriham_session='+token).encode())]}
  with patch('api.index.spawn',fake_spawn):await asyncio.wait_for(app(scope,receive,send),5)
  self.assertTrue(folders);self.assertTrue(all(not f.exists() for f in folders));self.assertTrue(all(p.returncode is not None for p in processes))
 async def test_stop_kills_process_group(self):
  proc=await asyncio.create_subprocess_exec(os.sys.executable,'-c','import time; time.sleep(120)',start_new_session=True)
  await stop(proc);self.assertIsNotNone(proc.returncode)

if __name__=='__main__':unittest.main()
