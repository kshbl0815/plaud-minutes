# 🎙️ Plaud 회의록 (PWA)

Plaud Note Pro로 녹음한 파일을 **한국어 회의록**으로 만들어 주는 웹앱입니다.
Plaud 앱은 **녹음/동기화만** 하고, 전사·요약·보관·검색은 이 앱이 합니다. → Plaud의 월 300분 전사 제한과 상관없이 쓸 수 있습니다.

- **서버 없음**: 정적 파일만 무료 호스팅(GitHub Pages / Cloudflare Pages)에 올리면 끝. 모든 처리는 브라우저가 AI 서비스에 직접 요청합니다.
- **휴대폰 + PC 공용**: 같은 주소를 휴대폰 Chrome과 PC Chrome/Edge에서 열고, **내 Google Drive**로 보관함을 동기화합니다.
- **Plaud 앱에서 바로 공유**: 휴대폰에 "앱 설치"를 해 두면 공유 메뉴에 **회의록**이 나타납니다.
- 주제별 섹션 요약 · 결정사항 · 할 일(담당/기한) · 자동 태그 · 전체 검색 · 주제별 종합 요약 · 보관함 AI 질문 · 마크다운 내보내기

---

## 1. 필요한 키 (모두 휴대폰/PC의 앱 **설정** 화면에 직접 입력, 기기 안에 암호화 저장)

| 용도 | 서비스 | 비용 | 발급 |
|---|---|---|---|
| 음성 인식(추천, 무료) | **Groq** – Whisper large-v3 | 무료: 하루 8시간(28,800초), 시간당 2시간(7,200초), 파일당 25MB(앱이 자동 분할) | https://console.groq.com/keys |
| 회의록 요약(무료) | **Google Gemini** | 무료 티어(한도는 AI Studio에 표시). ⚠ 무료 티어 데이터는 Google 제품 개선에 사용될 수 있음 | https://aistudio.google.com/apikey |
| 요약/음성인식(유료, 고품질) | **xAI Grok** | 음성인식 $0.10/시간(화자 구분 지원), 요약 grok-4.3 입력 $1.25·출력 $2.50 /100만 토큰 → 1시간 회의 약 $0.03 | https://console.x.ai |

**추천 조합**
- 완전 무료: *Groq 음성인식 + Gemini 요약* (설정 → 빠른 설정 → "무료 조합")
- Grok 사용: *Groq 음성인식(무료) + Grok 요약* (기본값), 또는 화자 구분이 필요하면 *xAI 음성인식 + Grok 요약* (1시간 약 $0.13)

> Groq(그록, 음성인식 회사)와 Grok(xAI의 AI 모델)은 다른 회사입니다.

## 2. 설치 (한 번만)

### 2-1. 웹에 올리기 (무료, 둘 중 하나)
**A. Cloudflare Pages (가장 쉬움, Git 불필요)**
1. https://dash.cloudflare.com → Workers & Pages → Create → Pages → **Upload assets**
2. `plaud-minutes-app.zip`의 압축을 풀어 나온 파일(`index.html`이 있는 폴더)을 업로드 → 주소 예: `https://plaud-minutes.pages.dev`

**B. GitHub Pages**
1. GitHub에 새 저장소를 만들고 이 프로젝트를 올립니다(`app/` 폴더 포함).
2. Settings → Pages → Source: **GitHub Actions** (포함된 `.github/workflows/pages.yml`이 `app/`을 배포) → 주소 예: `https://<아이디>.github.io/plaud-minutes/`
   (무료 계정은 공개 저장소여야 합니다. 코드만 공개되고 회의 데이터·키는 저장소에 들어가지 않습니다.)

### 2-2. 휴대폰에 설치
1. 휴대폰 **Chrome**으로 위 주소 열기 → 메뉴(⋮) → **앱 설치**(또는 홈 화면에 추가)
2. 앱 열기 → ⚙️ 설정 → API 키 입력 → 💾 저장 → 🔑 키 확인

### 2-3. PC
PC Chrome/Edge로 같은 주소를 열고 주소창의 설치 아이콘(⊕)을 누르면 데스크톱 앱처럼 쓸 수 있습니다. 파일은 끌어다 놓으면 됩니다.

### 2-4. (선택) Google Drive 동기화 — PC·휴대폰 같은 보관함
Drive 접근에는 본인 소유의 "OAuth 클라이언트 ID"가 필요합니다(무료, 약 5분).
1. https://console.cloud.google.com → 새 프로젝트 만들기
2. **API 및 서비스 → 라이브러리 → Google Drive API → 사용**
3. **Google 인증 플랫폼(OAuth 동의 화면)**: 사용자 유형 *외부*, 앱 이름 "Plaud 회의록", 이메일 입력 → 데이터 액세스(범위)에 `.../auth/drive.file` 추가 → **대상 → 테스트 사용자**에 본인 Gmail 추가
4. **사용자 인증 정보 → 사용자 인증 정보 만들기 → OAuth 클라이언트 ID → 웹 애플리케이션**
   - 승인된 JavaScript 원본: 2-1의 주소의 **도메인까지만** (예: `https://plaud-minutes.pages.dev` 또는 `https://<아이디>.github.io`)
5. 생성된 클라이언트 ID(`....apps.googleusercontent.com`)를 앱 설정 → *Google OAuth 클라이언트 ID*에 붙여넣고 **Google Drive 연결**
6. PC와 휴대폰 모두에서 같은 클라이언트 ID로 연결하면 같은 보관함을 봅니다.

- 저장 위치: 내 드라이브 › **Plaud 회의록** 폴더 (`m_*.json` 회의 데이터, `a_*.mp3` 원본 오디오, `topics.json`)
- 권한은 `drive.file`(비민감 범위): 이 앱이 만든 파일만 접근, 다른 Drive 파일은 못 봅니다.
- 용량: Google 계정 저장공간(무료 15GB, MP3 1시간 ≈ 30~60MB) 사용. "업로드 후 기기에서 오디오 삭제"를 켜면 휴대폰 용량도 아낍니다.
- 로그인 토큰은 1시간 유효 → 만료되면 상단 ☁️를 눌러 다시 연결(한 번 탭).
- 다른 기기 설정 복사: 설정 → "설정을 Drive에 저장" / "Drive에서 설정 불러오기" (키 포함은 선택, 포함 시 내 Drive에 평문 저장)

## 3. 사용법

1. Plaud 앱에서 녹음 동기화 → 녹음 열기 → 오른쪽 위 아이콘 → **Export as file(파일로 내보내기) → Audio → MP3**
2. 공유 시트에서 **회의록** 선택 → 자동으로 가져와 **전사 → 회의록 작성** (1시간 녹음 기준 보통 1~2분)
   - 공유 목록에 없으면 파일을 저장한 뒤 앱의 ➕ 가져오기 → 파일 선택
3. 📋 회의록: 전체 검색(예: `예산 "출시 일정" -잡담`), 태그 필터, 💬 보관함에 질문
4. 회의 화면: 회의록/전사본 탭, 타임스탬프 눌러 해당 위치 재생, ✏️ 제목·일시·태그·메모 편집, 👥 화자 이름 지정, 📤 공유, ⬇️ .md 저장, 🔁 다시 생성
5. 🗂️ 주제: 태그별로 여러 회의 묶어 보기 → ✨ **종합 요약**(경과, 누적 결정사항, 미완료 할 일)

**팁**: 설정의 *용어 사전*에 사람 이름·제품명·약어를 넣으면 인식 정확도가 올라갑니다. 회의 메모에 참석자를 적어두면 회의록에 반영됩니다.

## 4. 한도·비용·주의

- Groq 무료: 하루 8시간 / 시간당 2시간 분량. 한도에 걸리면 앱이 **자동으로 대기 후 이어서** 처리합니다(완료된 부분은 다시 보내지 않음).
- 처리 중에는 앱 화면을 열어 두세요(화면 꺼짐 방지 자동 적용). 브라우저가 앱을 종료해도 다음에 열면 **이어서** 처리합니다.
- 긴 녹음: Groq는 10분 단위로 자동 분할(MP3는 재인코딩 없이 프레임 단위, WAV 등은 16kHz 모노로 변환 후 조용한 지점에서 분할). xAI는 500MB까지 통째로 전송.
- 화자 구분은 xAI 음성인식에서만 제공됩니다(Whisper는 미지원).
- API 키는 각 기기 브라우저 저장소에 암호화되어 저장되며 어디에도 전송되지 않습니다(각 AI 서비스 호출 시 제외).
- 브라우저 데이터를 지우면 기기 내 보관함이 삭제됩니다 → Drive 동기화 또는 설정 → 전체 백업을 권장합니다.
- iPhone Safari는 공유 대상(Web Share Target)을 지원하지 않습니다(파일 선택으로 가져오기는 가능).

## 5. 개발

```
app/            # 배포되는 정적 PWA (빌드 없음, 순수 ES 모듈)
  js/audio.js   # 포맷 판별, MP3 프레임 분할, WAV/디코딩 → 16kHz WAV 분할(무음 지점)
  js/stt.js     # Groq/OpenAI 호환 Whisper, xAI STT(화자), 환각 문구 제거
  js/llm.js     # 회의록 프롬프트/JSON 스키마, 긴 회의 분할 요약, 주제 종합, 보관함 Q&A
  js/pipeline.js# 청크별 재개 가능한 처리 파이프라인
  js/drive.js, js/sync.js  # Google Drive 동기화
  js/search.js  # 한국어 부분일치 전문 검색
  sw.js         # 오프라인 캐시 + 공유 대상(POST) 처리
tests/          # node --test (단위 + 가짜 API E2E)
tools/          # mock-api.js, serve.js, browser-e2e.js(헤드리스 Chrome)
```
- 테스트: `sh tools/make_fixtures.sh && npm test` / 브라우저 E2E: `cd tools && npm i && node browser-e2e.js`
- 로컬 실행: `node tools/serve.js app 8080` → http://localhost:8080 (OAuth 원본에 `http://localhost:8080` 추가 시 Drive도 테스트 가능)
- 앱 업데이트 배포 시 `app/sw.js`의 `VERSION`을 올리면 캐시가 갱신됩니다.
