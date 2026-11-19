# Tunely · iPhone 음악 PWA MVP

Next.js + TypeScript 프론트엔드, Vercel Python Function(FastAPI), Supabase(대기열·임시 파일), Windows PC 에이전트(yt-dlp, FFmpeg, Deno)로 구성한 개인용 앱입니다. 오디오·커버·재생목록은 iPhone의 IndexedDB에 영구 저장합니다. Supabase의 임시 파일은 iPhone이 받으면 즉시, 받지 않으면 3일 뒤 삭제합니다.

## 저장 흐름

Vercel에서 YouTube 다운로드가 봇으로 차단되어, 다운로드와 변환은 집 Windows PC에서 합니다.

1. iPhone: 검색(Vercel) → 저장 → `POST /api/jobs`로 Supabase `jobs` 대기열에 등록
2. PC 에이전트: `POST /api/agent/claim`으로 작업을 받아 다운로드·M4A 변환·썸네일 jpg 생성 → 서명 URL로 Supabase Storage `transfers`에 직접 업로드
3. iPhone: 앱이 열려 있을 때 `GET /api/jobs`로 확인 → 음원·커버를 받아 보관함에 저장 → `received`로 서버 사본 삭제

PC가 꺼져 있으면 요청은 대기열에 남습니다. 처리 중 15분 이상 소식이 없는 작업은 대기열로 되돌립니다.

## Windows PC 에이전트

1. Python 3.12와 Deno(`winget install DenoLand.Deno`)를 설치합니다.
2. 이 저장소를 PC에 받고 `agent\.env.example`을 `agent\.env`로 복사해 `TUNELY_URL`, `AGENT_TOKEN`을 채웁니다. `AGENT_TOKEN`은 Vercel 환경변수와 같은 값입니다.
3. `agent\run-agent.bat`을 실행합니다. 첫 실행에 `.venv`를 만들고, 매번 yt-dlp를 최신으로 올립니다. 창을 띄워 둔 동안 대기열을 처리하고, Ctrl+C로 종료합니다.

필요한 Vercel 환경변수: `SUPABASE_URL`, `SUPABASE_SECRET_KEY`(Supabase 대시보드 → Project Settings → API Keys의 secret key), `AGENT_TOKEN`, `CRON_SECRET`.

## iPhone에서 사용하기

Tunely는 **iPhone Safari에서 접속해 홈 화면에 설치하는 PWA**입니다. Windows 설치 프로그램이 아닙니다.

1. GitHub에 소스를 올리고 Vercel에 배포합니다.
2. iPhone Safari에서 실제 배포 주소를 엽니다.
3. 공유 → **홈 화면에 추가** → Tunely를 실행합니다.
4. 최초 주의사항 동의 후 앱 전용 비밀번호로 로그인합니다.
5. 오디오를 저장한 뒤 비행기 모드와 잠금 화면 재생을 확인합니다.

현재 배포 주소는 아직 발급되지 않았습니다. 아래 PC 명령은 개발자 테스트용입니다.

## 사용

1. 로그인합니다. 로그인은 최초 인증부터 30일이며 자동 연장하지 않습니다.
2. ‘음악 찾기’에서 YouTube 검색어 또는 HTTPS 영상 URL을 입력합니다.
3. 여러 곡을 선택하거나 한 곡씩 저장합니다. PC 에이전트가 순서대로 처리하고, 실패 건은 재시도할 수 있습니다.
4. 라이브러리에서 재생합니다. 로컬 오디오 파일 가져오기도 지원합니다.
5. ‘선택’으로 일괄 삭제하거나 재생목록에 추가합니다. 음악의 `…` 메뉴에서 제목·아티스트·커버를 수정합니다. 재생목록을 연 상태에서 `…` → ‘목록 위/아래로’로 순서를 바꿉니다.
6. 플레이어에서 셔플·한 곡/전체 반복·0.5–2배속을 설정합니다. 재실행 시 재생 위치와 대기열을 복원하되 자동으로 재생하지 않습니다.

## Vercel 배포

이 프로젝트는 **Next.js 정적 내보내기 + Python Function**입니다. Next.js 서버 런타임에서 Python을 호출하는 구조나 컨테이너 배포가 아닙니다.

1. Vercel에서 새 프로젝트를 만들고 이 폴더를 연결합니다. Framework Preset은 **Other**, Build Command는 `npm run build`, Output Directory는 `out`입니다. `vercel.json`에 동일 설정이 있습니다.
2. 로컬 `.env.local`의 `APP_PASSWORD_HASH`, `SESSION_SECRET`을 Vercel 환경변수에 등록합니다. Argon2 해시의 `$`를 포함해 값을 그대로 입력합니다. 평문 비밀번호를 등록하지 않습니다.
3. `APP_ORIGIN=https://실제-서비스-도메인`, `COOKIE_SECURE=true`를 등록합니다. Preview와 Production은 각각 해당 도메인을 설정해야 합니다. 도메인이 바뀌면 다시 설정합니다.
4. Fluid Compute를 켜고 배포합니다. 함수는 `api/index.py` 하나이고, 최대 300초입니다. 백엔드는 전송까지 포함해 275초 안에 종료를 시도합니다.
5. 설정 화면에서 서버 연결을 확인합니다. yt-dlp 버전·FFmpeg·Deno가 모두 확인되어야 합니다.
6. 다운로드 권한이 있는 짧은 테스트 영상으로 검색 → 저장 → 재생을 검증합니다. 결과를 확인하기 전에는 Vercel 다운로드 성공으로 간주하지 않습니다.
7. iPhone Safari로 접속하여 공유 → 홈 화면에 추가 후 실행합니다. 첫 온라인 실행에서 Service Worker가 준비된 다음 오프라인 검증을 합니다.

Vercel CLI를 이미 사용하는 경우 프로젝트를 명시적으로 연결한 후 `npx vercel`로 Preview를 생성할 수 있습니다. `.env.local`과 `.venv`는 업로드하지 않습니다. 배포 계정·프로젝트는 이 소스에 연결되어 있지 않습니다.

## 개발자용 PC 로컬 실행

Node.js 20.9 이상과 Python 3.12 이상이 필요합니다. 소스가 있는 `tunely` 폴더에서 아래 명령을 순서대로 실행합니다.

```powershell
npm ci
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe scripts/configure.py
npm run dev
```

`http://localhost:3000`에 접속합니다. 설정 과정에서 입력한 **앱 전용 비밀번호**로 로그인합니다. `npm run dev` 한 번으로 프론트엔드와 Python API를 함께 실행합니다. 프로덕션 화면을 로컬에서 시험하려면 `npm run build` 후 `npm start`로 실행합니다. 8000번 포트를 다른 앱이 쓰고 있으면 종료한 후 실행합니다.

Linux/macOS:

```bash
npm ci
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python scripts/configure.py
npm run dev
```


## 구현 및 검증 범위

- 최초 1회 주의사항 동의, 30일 서명 세션 쿠키, 비밀번호 Argon2id 검증, 만료 시 재로그인
- 내부 YouTube 검색, URL 입력, 선택 저장, 영상 ID 중복 방지, 순차 다운로드, 취소·재시도
- M4A: AAC 원본은 복사, 그 외는 FFmpeg AAC 최고 품질 우선(`-q:a 1`); 품질 개선이나 무손실을 의미하지 않음
- NDJSON 스트리밍: 진행 이벤트·오디오 청크·완료 이벤트를 한 연결로 전달. base64로 전송량 약 33% 증가. 완료 이벤트가 있어야만 IndexedDB에 등록
- 취소 시 클라이언트 AbortController와 서버 연결 종료 → 프로세스 그룹 종료 → 임시 폴더 정리. Vercel의 실제 연결 종료 전파·강제 종료 상황은 배포 후 확인 필요
- 전송 중 누적 데이터는 메모리에만 존재하며 실패·취소 시 폐기. 임시 데이터를 IndexedDB에 쓰지 않음
- 서버가 강제 종료되면 즉시 정리를 보장할 수 없으므로 다음 요청에서 1시간 이상 된 잔여 임시 폴더 정리
- 로컬 오디오·커버·메타데이터·재생목록·재생 상태, 일괄 삭제, 저장량 표시
- Service Worker가 프로덕션 빌드의 화면·JS·CSS를 미리 캐시. API·인증 응답은 캐시하지 않음. 새 버전은 열려 있는 앱을 닫았다 다시 열 때 적용
- HTMLAudioElement·Media Session API, 기기 자동 라이트/다크, 반응형 화면

## 검사

```powershell
npm run build
npm run typecheck
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
```

테스트는 인증·만료·허용 URL·다른 출처 요청·권한 확인·호출 제한·전송 이벤트·실패 시 정리·프로세스 종료를 검증합니다. YouTube 통신을 대체한 테스트는 실제 다운로드 성공 증거가 아닙니다.

## 남은 실제 환경 검증

- **Vercel 배포·YouTube 접속·검색·실제 M4A 저장은 아직 미검증**입니다. 개발 환경의 외부 요청은 인증서 체인 검증 오류가 발생했으며 인증서 검증을 끄지 않았습니다.
- iPhone 설치·오프라인 재실행·IndexedDB 용량·저장소 보호 허용·잠금 화면 연속 재생은 실제 기기에서 검증해야 합니다.
- 저장소 보호 요청이 거절될 수 있고, 앱·웹 데이터 삭제 시 파일이 유실될 수 있습니다. 이 앱은 원본 보관소나 백업을 대체하지 않습니다.
- 로그인 쿠키를 지우는 로그아웃입니다. 복제된 세션의 서버 측 개별 폐기는 영구 세션 저장소가 없는 현재 버전에서 지원하지 않습니다. 비밀번호 해시 또는 SESSION_SECRET 변경 시 기존 세션 전체가 무효화됩니다.
- 호출 제한은 함수 인스턴스별입니다. 외부 공개 시 Vercel Firewall에서 로그인·검색·변환 요청에 대한 분산 호출 제한을 추가하세요.
- 다중 사용자 계정·동기화·백업·iOS 단축어는 MVP 범위에서 제외합니다. 내부 검색이 기본입니다.

공식 참고: [Python 런타임](https://vercel.com/docs/functions/runtimes/python), [스트리밍](https://vercel.com/docs/functions/streaming-functions), [함수 제한](https://vercel.com/docs/functions/limitations), [yt-dlp](https://github.com/yt-dlp/yt-dlp).
