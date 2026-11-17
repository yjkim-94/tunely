"""Interactive local configuration. Never writes the plaintext password."""
import getpass,secrets
from pathlib import Path
from argon2 import PasswordHasher
path=Path('.env.local')
if path.exists(): raise SystemExit('.env.local이 이미 있습니다. 필요한 값만 직접 수정하세요.')
a=getpass.getpass('앱 전용 비밀번호(12자 이상): ');b=getpass.getpass('비밀번호 확인: ')
if a!=b or len(a)<12: raise SystemExit('비밀번호가 다르거나 너무 짧습니다.')
path.write_text('APP_PASSWORD_HASH='+PasswordHasher().hash(a)+'\nSESSION_SECRET='+secrets.token_urlsafe(48)+'\nAPP_ORIGIN=http://localhost:3000\nCOOKIE_SECURE=false\n')
path.chmod(0o600)
print('로컬 설정 완료. Vercel 배포 시 환경변수 4개를 등록하세요.')
