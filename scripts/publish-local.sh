#!/bin/zsh
# 이 MacBook에서 스냅샷을 만들어 gh-pages 브랜치로 배포한다.
#
# GitHub Actions 러너(미국)에서는 apis.data.go.kr 연결이 막혀(UND_ERR_CONNECT_TIMEOUT)
# 국내 IP인 이 맥에서 받는다. launchd(kr.ulsan.ldh.kiosk-data)가 하루 여러 번(03·09·12·15·18·21시) 부르고,
# 오늘(KST) 배포본이 이미 있으면 건너뛴다. 맥이 배터리로 잠깐 깨었다가 다시 잠들면 실행이 중간에 끊기므로
# (2026-10-07 03:00), 한 번에 성공하는 것보다 하루 중 깨어 있는 때에 한 번 성공하는 쪽을 택했다.
#
# 인증키는 로그인 키체인 항목(서비스 kr.ulsan.ldh.kiosk-data, 계정 DATA_GO_KR_SERVICE_KEY)에서 읽는다.
# 환경변수 DATA_GO_KR_SERVICE_KEY 가 있으면 그것을 먼저 쓴다. FORCE=1 이면 오늘 배포본이 있어도 다시 만든다.
set -euo pipefail

REPO_DIR="${0:A:h:h}"
PAGES_BASE_URL="https://ldh-prog.github.io/kiosk-data"
KEYCHAIN_SERVICE="kr.ulsan.ldh.kiosk-data"
KEYCHAIN_ACCOUNT="DATA_GO_KR_SERVICE_KEY"
STALE_HOURS=30
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

log() { print -r -- "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

# 배포본 생성 후 지난 시간(시간 단위, 정수). 못 읽으면 빈 문자열.
published_age_hours() {
  curl -s --max-time 15 "$PAGES_BASE_URL/v1/meta.json" 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const t=Date.parse(JSON.parse(s).generatedAt);if(Number.isFinite(t))process.stdout.write(String(Math.floor((Date.now()-t)/36e5)))}catch{}})' 2>/dev/null \
    || true
}

# 오늘(KST) 만든 배포본이 있으면 0
published_today_kst() {
  curl -s --max-time 15 "$PAGES_BASE_URL/v1/meta.json" 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const kst=(ms)=>new Date(ms+9*36e5).toISOString().slice(0,10);process.exit(kst(Date.parse(JSON.parse(s).generatedAt))===kst(Date.now())?0:1)}catch{process.exit(1)}})' 2>/dev/null
}

# 실패해도 다음 시간대에 다시 돈다. 배포본이 오래됐을 때만 알린다.
on_failure() {
  local age; age="$(published_age_hours)"
  if [[ -z "$age" || "$age" -ge "$STALE_HOURS" ]]; then
    /usr/bin/osascript -e "display notification \"배포본이 ${age:-?}시간 전 것입니다. 로그: ~/Library/Logs/kr.ulsan.ldh.kiosk-data.log\" with title \"발급기 데이터 갱신 실패\"" >/dev/null 2>&1 || true
  fi
  log "실패 (배포본 ${age:-?}시간 전)"
}
trap on_failure ERR

# 깨어난 직후에는 네트워크가 늦게 붙는다. 최대 10분 기다린다.
wait_for_network() {
  for attempt in {1..20}; do
    if curl -s -o /dev/null --max-time 10 https://github.com; then
      return 0
    fi
    sleep 30
  done
  log "네트워크가 연결되지 않았습니다."
  return 1
}

log "시작"
cd "$REPO_DIR"
wait_for_network

if [[ "${FORCE:-0}" != "1" ]] && published_today_kst; then
  log "오늘 배포본이 이미 있어 건너뜁니다."
  exit 0
fi

if [[ -z "${DATA_GO_KR_SERVICE_KEY:-}" ]]; then
  DATA_GO_KR_SERVICE_KEY="$(security find-generic-password -s "$KEYCHAIN_SERVICE" -a "$KEYCHAIN_ACCOUNT" -w)"
fi
# 도로명주소 API 승인키(선택). 둘 다 있어야 새 발급기 좌표를 찾고, 없으면 직전 배포본 좌표만 이월한다.
read_optional_key() { security find-generic-password -s "$KEYCHAIN_SERVICE" -a "$1" -w 2>/dev/null || true; }
: "${JUSO_SEARCH_KEY:=$(read_optional_key JUSO_SEARCH_KEY)}"
: "${JUSO_COORD_KEY:=$(read_optional_key JUSO_COORD_KEY)}"
export DATA_GO_KR_SERVICE_KEY PAGES_BASE_URL JUSO_SEARCH_KEY JUSO_COORD_KEY

# 스크립트 수정분을 받는다. 로컬에서 고친 내용이 있으면 덮지 않고 실패한다.
git pull --ff-only --quiet origin main

node scripts/build-snapshot.mjs

# 배포본은 한 커밋짜리 고아 브랜치로 강제 push한다. 매일 커밋을 쌓지 않으려는 것이다.
generated_at="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync("site/v1/meta.json","utf8")).generatedAt)')"
publish_dir="$(mktemp -d)"
trap 'rm -rf "$publish_dir"' EXIT
cp -R site/. "$publish_dir/"
touch "$publish_dir/.nojekyll"
git -C "$publish_dir" init -q -b gh-pages
git -C "$publish_dir" add -A
git -C "$publish_dir" -c user.name="ldh-prog" -c user.email="deuckho@gmail.com" commit -q -m "snapshot ${generated_at}"
git -C "$publish_dir" push -q -f "$(git remote get-url origin)" gh-pages
log "배포 완료: ${generated_at}"
