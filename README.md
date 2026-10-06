# 무인민원발급기 데이터 스냅샷

「무인민원발급기 찾기」 앱(`kr.ulsan.ldh.kiosk`)이 읽는 정적 JSON을 만들어 GitHub Pages에 올립니다.

주소: https://ldh-prog.github.io/kiosk-data/

## 왜 따로 두나요?

앱이 공공데이터 OpenAPI를 직접 부르면 인증키가 APK 안에 들어갑니다. APK는 누구나 풀어 볼 수 있습니다.
그래서 키는 이 저장소의 **Actions Secret**에만 두고, Actions가 하루 1회 API를 받아 정적 파일로 배포합니다. 앱은 정적 파일만 읽습니다.

원본도 하루 1회(2일 전 기준) 갱신이라, 하루 1회 받아 두면 앱이 직접 부를 때와 정보가 같습니다.

## 갱신 주기와 API 사용량

| 데이터 | 주기 | API 호출 |
| --- | --- | --- |
| 설치정보 `installation_info` (약 5,800행) | 매일 03:00 KST | 약 59회 |
| 발급 서류 `certificate_info` (약 51만 행) | 일요일 03:00 KST, 또는 수동 | 약 5,100회 |

서류 목록을 받지 않는 날은 직전 배포본을 그대로 옮깁니다. 개발계정 일일 한도는 10,000회입니다.

서류 갱신이 실패하면(한도 초과 등) 직전 배포본을 쓰고 경고만 남깁니다. 설치정보가 직전 배포의 90% 미만이면 배포하지 않고 실패합니다. 실패하면 직전 사이트가 그대로 남습니다.

## 파일

| 경로 | 내용 |
| --- | --- |
| `v1/meta.json` | 생성 시각, 시도별 건수, 서류 기준 시각 |
| `v1/kiosks/{시도코드}.json` | 설치정보 원본 필드(앱이 쓰는 것만). 시도코드는 `CTPV_CD` 7자리 |
| `v1/certificates/{시도코드}.json` | 서류 사전 `documents[i] = [분류번호, 서류명, 메뉴명]`, 발급기별 `kiosks["개방자치단체코드:발급기번호"].docs = [i, ...]` |

발급기 번호는 선행 0을 뗍니다(`0501` → `501`). 앱의 `sameKioskNumber()`와 같은 규칙입니다.
스키마를 바꾸면 `v2/`로 올리고, 구버전 앱이 읽는 `v1/`은 한동안 같이 둡니다.

## 운영

```bash
npm test
# 로컬 시험(서류는 20쪽만). 결과는 배포하지 않는다.
DATA_GO_KR_SERVICE_KEY=... CERT_MAX_PAGES=20 OUT_DIR=/tmp/site node scripts/build-snapshot.mjs
```

- 수동 실행: Actions → snapshot → Run workflow. 서류까지 새로 받으려면 `refresh_certificates`를 켭니다.
- 인증키 교체: `gh secret set DATA_GO_KR_SERVICE_KEY --repo ldh-prog/kiosk-data` 후 수동 실행.
- 공개 저장소의 예약 실행은 60일간 활동이 없으면 꺼집니다. `keepalive` 작업이 실행마다 다시 켜 두지만, 꺼졌다는 메일을 받으면 Actions 탭에서 다시 켭니다.

## 출처

행정안전부, 공공데이터포털 [무인민원발급기정보 조회서비스](https://www.data.go.kr/data/15154774/openapi.do). 이용허락범위 제한 없음.
