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
| 설치정보 `installation_info` (약 5,800행) | 하루 1회 | 약 59회 |
| 발급 서류 `certificate_info` (약 51만 행) | 일요일, 또는 `REFRESH_CERTIFICATES=true` | 약 5,100회 |
| 좌표 (도로명주소 검색·좌표제공 API) | 새 발급기·주소 바뀐 발급기만 | 발급기당 2회 |

launchd가 03·09·12·15·18·21시에 부르고, 오늘(KST) 배포본이 이미 있으면 건너뜁니다. 그 시각에 맥이 잠자기 중이면 깨어난 직후 실행합니다. 하루 중 맥이 깨어 있는 때에 한 번 성공하면 됩니다. 서류 목록을 받지 않는 날은 직전 배포본을 그대로 옮깁니다. 개발계정 일일 한도는 10,000회입니다.

- 서류 갱신이 실패하면(한도 초과 등) 직전 배포본을 쓰고 경고만 남깁니다.
- 설치정보가 직전 배포의 90% 미만이면 배포하지 않고 실패합니다.
- 직전 배포본을 네트워크 문제로 못 읽으면 실행을 접습니다. ‘첫 실행’으로 보고 서류 전체(5,100회)와 좌표 전체를 다시 받지 않게 하려는 것입니다. 2026-10-07 03:00, 맥이 배터리로 잠깐 깨었다가 다시 잠들어 DNS가 끊긴 일이 있었습니다.
- 실패하면 직전 사이트가 그대로 남고 다음 시간대에 다시 돕니다. 배포본이 30시간보다 오래됐을 때만 맥에 알림이 뜹니다.

## 파일

| 경로 | 내용 |
| --- | --- |
| `v1/meta.json` | 생성 시각, 시도별 건수, 서류 기준 시각 |
| `v1/kiosks/{시도코드}.json` | 설치정보 원본 필드(앱이 쓰는 것만). 시도코드는 `CTPV_CD` 7자리 |
| `v1/points.json` | 좌표 있는 발급기의 시도별 `[위도, 경도]` 목록. 앱이 내 위치의 시도를 고를 때 씁니다 |
| `v1/certificates/{시도코드}.json` | 서류 사전 `documents[i] = [분류번호, 서류명, 메뉴명]`, 발급기별 `kiosks["개방자치단체코드:발급기번호"].docs = [i, ...]` |

발급기 번호는 선행 0을 뗍니다(`0501` → `501`). 앱의 `sameKioskNumber()`와 같은 규칙입니다.
원본에 완전히 같은 설치정보 행이 50건쯤 있어 중복을 제거합니다.

### 좌표 (`GEO_LAT`, `GEO_LON`)

원본에는 좌표가 없습니다(`INSTL_PLC_PSTN`은 ‘관공서’ 같은 시설 분류). 대신 모든 행에 도로명주소 키(`ROAD_SGG_CD`+`ROAD_CD`, 지하여부, 건물본번·부번)가 있어, 행정안전부 도로명주소 API로 **건물 주출입구 좌표**를 붙입니다.

1. 검색 API(`addrLinkApi.do`)로 주소를 찾아 도로명코드·건물번호가 정확히 같은 결과의 행정구역코드(`admCd`)를 얻습니다.
2. 좌표제공 API(`addrCoordApi.do`)로 UTM-K(EPSG:5179) 좌표를 받아 WGS84로 바꿉니다(`scripts/geo.mjs`, pyproj와 1e-6도 안).
3. 직전 배포본에 같은 발급기·같은 주소의 좌표가 있으면 다시 부르지 않습니다. 같은 건물은 한 실행에서 한 번만 찾습니다.

`GEO_LAT`/`GEO_LON`은 원본 API 필드가 아닙니다. 카카오·브이월드 지오코딩은 약관상 결과를 저장·재배포할 수 없어 쓰지 않습니다. 정확히 같은 건물을 못 찾은 발급기는 좌표 없이 둡니다.
스키마를 바꾸면 `v2/`로 올리고, 구버전 앱이 읽는 `v1/`은 한동안 같이 둡니다.

## 설치 (맥 한 번)

```bash
# 1) 인증키를 로그인 키체인에 넣는다. -w 뒤를 비우면 입력을 묻는다.
security add-generic-password -U -s kr.ulsan.ldh.kiosk-data -a DATA_GO_KR_SERVICE_KEY -w

# 1-1) 도로명주소 API 승인키(business.juso.go.kr, 검색 API·좌표제공 API). 없으면 좌표는 이월만 한다.
security add-generic-password -U -s kr.ulsan.ldh.kiosk-data -a JUSO_SEARCH_KEY -w
security add-generic-password -U -s kr.ulsan.ldh.kiosk-data -a JUSO_COORD_KEY -w

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

- 행정안전부, 공공데이터포털 [무인민원발급기정보 조회서비스](https://www.data.go.kr/data/15154774/openapi.do). 이용허락범위 제한 없음.
- 좌표: 행정안전부 도로명주소 [좌표제공 API](https://www.data.go.kr/data/15056663/openapi.do)(건물 주출입구). 이용허락범위 제한 없음.
