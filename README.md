# 무인민원발급기 데이터 스냅샷

「무인민원발급기 찾기」 앱(`kr.ulsan.ldh.kiosk`)이 읽는 정적 JSON을 만들어 GitHub Pages에 올립니다.

주소: https://ldh-prog.github.io/kiosk-data/

## 왜 따로 두나요?

앱이 공공데이터 OpenAPI를 직접 부르면 인증키가 APK 안에 들어갑니다. APK는 누구나 풀어 볼 수 있습니다.
그래서 키는 개발자 맥의 키체인에만 두고, 맥이 하루 1회 API를 받아 정적 파일로 배포합니다. 앱은 정적 파일만 읽습니다.

원본도 하루 1회(2일 전 기준) 갱신이라, 하루 1회 받아 두면 앱이 직접 부를 때와 정보가 같습니다.

## 왜 GitHub Actions가 아니라 맥인가요?

GitHub Actions 러너(미국)에서 `apis.data.go.kr`에 붙으면 연결 시간 초과(`UND_ERR_CONNECT_TIMEOUT`)가 납니다(2026-10-06, 2회 확인). 국내 IP에서는 됩니다.
그래서 생성·배포는 국내에 있는 개발자 MacBook의 launchd가 하고, GitHub에서는 테스트와 Pages 호스팅만 합니다.

맥이 꺼져 있거나 해외에 있으면 그동안 갱신이 멈춥니다. 앱은 마지막 배포본을 계속 보여 줍니다.

## 갱신 주기와 API 사용량

| 데이터 | 주기 | API 호출 |
| --- | --- | --- |
| 설치정보 `installation_info` (약 5,800행) | 매일 03:00 KST | 약 59회 |
| 발급 서류 `certificate_info` (약 51만 행) | 일요일, 또는 `REFRESH_CERTIFICATES=true` | 약 5,100회 |

03:00에 맥이 잠자기 중이면 깨어난 직후 한 번 실행합니다. 서류 목록을 받지 않는 날은 직전 배포본을 그대로 옮깁니다. 개발계정 일일 한도는 10,000회입니다.

서류 갱신이 실패하면(한도 초과 등) 직전 배포본을 쓰고 경고만 남깁니다. 설치정보가 직전 배포의 90% 미만이면 배포하지 않고 실패합니다. 실패하면 직전 사이트가 그대로 남고, 맥에 알림이 뜹니다.

## 파일

| 경로 | 내용 |
| --- | --- |
| `v1/meta.json` | 생성 시각, 시도별 건수, 서류 기준 시각 |
| `v1/kiosks/{시도코드}.json` | 설치정보 원본 필드(앱이 쓰는 것만). 시도코드는 `CTPV_CD` 7자리 |
| `v1/certificates/{시도코드}.json` | 서류 사전 `documents[i] = [분류번호, 서류명, 메뉴명]`, 발급기별 `kiosks["개방자치단체코드:발급기번호"].docs = [i, ...]` |

발급기 번호는 선행 0을 뗍니다(`0501` → `501`). 앱의 `sameKioskNumber()`와 같은 규칙입니다.
원본에 완전히 같은 설치정보 행이 50건쯤 있어 중복을 제거합니다. 원본에는 좌표가 없습니다(`INSTL_PLC_PSTN`은 ‘관공서’ 같은 시설 분류).
스키마를 바꾸면 `v2/`로 올리고, 구버전 앱이 읽는 `v1/`은 한동안 같이 둡니다.

## 설치 (맥 한 번)

```bash
# 1) 인증키를 로그인 키체인에 넣는다. -w 뒤를 비우면 입력을 묻는다.
security add-generic-password -U -s kr.ulsan.ldh.kiosk-data -a DATA_GO_KR_SERVICE_KEY -w

# 2) 실행용 사본 clone + launchd 등록
./scripts/install-launchd.sh

# 3) 지금 한 번 실행하고 로그 보기
launchctl kickstart gui/$UID/kr.ulsan.ldh.kiosk-data
tail -f ~/Library/Logs/kr.ulsan.ldh.kiosk-data.log
```

실행용 사본은 `~/Library/Application Support/kr.ulsan.ldh.kiosk-data/repo`에 있습니다. `~/Documents`는 macOS 개인정보 보호 때문에 백그라운드 작업이 못 읽을 수 있어서입니다. 매 실행 때 `main`을 `git pull --ff-only`로 받으므로, 스크립트를 고치면 push만 하면 됩니다.

배포는 `site/`를 한 커밋짜리 `gh-pages` 브랜치로 강제 push합니다. 매일 커밋을 쌓지 않으려는 것입니다. Pages는 `gh-pages` 브랜치 루트를 서비스합니다.

## 운영

```bash
npm test
# 로컬 시험(서류는 20쪽만). 배포하지 않는다.
DATA_GO_KR_SERVICE_KEY=... CERT_MAX_PAGES=20 OUT_DIR=/tmp/site node scripts/build-snapshot.mjs
```

- 서류까지 지금 새로 받기: `REFRESH_CERTIFICATES=true "$HOME/Library/Application Support/kr.ulsan.ldh.kiosk-data/repo/scripts/publish-local.sh"`
- 인증키 교체: 1)의 `security add-generic-password -U ...`를 다시 실행(덮어씀).
- 끄기: `launchctl bootout gui/$UID/kr.ulsan.ldh.kiosk-data`

## 출처

행정안전부, 공공데이터포털 [무인민원발급기정보 조회서비스](https://www.data.go.kr/data/15154774/openapi.do). 이용허락범위 제한 없음.
