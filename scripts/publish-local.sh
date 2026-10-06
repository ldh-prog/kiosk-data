#!/bin/zsh
# 이 MacBook에서 스냅샷을 만들어 gh-pages 브랜치로 배포한다.
#
# GitHub Actions 러너(미국)에서는 apis.data.go.kr 연결이 막혀(UND_ERR_CONNECT_TIMEOUT)
# 국내 IP인 이 맥에서 받는다. launchd(kr.ulsan.ldh.kiosk-data)가 매일 03:00에 부르고,
# 그 시각에 잠자기 중이면 깨어난 직후 한 번 부른다.
#
# 인증키는 로그인 키체인 항목(서비스 kr.ulsan.ldh.kiosk-data, 계정 DATA_GO_KR_SERVICE_KEY)에서 읽는다.
# 환경변수 DATA_GO_KR_SERVICE_KEY 가 있으면 그것을 먼저 쓴다.
set -euo pipefail

REPO_DIR="${0:A:h:h}"
PAGES_BASE_URL="https://ldh-prog.github.io/kiosk-data"
KEYCHAIN_SERVICE="kr.ulsan.ldh.kiosk-data"
KEYCHAIN_ACCOUNT="DATA_GO_KR_SERVICE_KEY"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

log() { print -r -- "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

notify_failure() {
  /usr/bin/osascript -e "display notification \"$1\" with title \"발급기 데이터 갱신 실패\"" >/dev/null 2>&1 || true
}
trap 'notify_failure "로그: ~/Library/Logs/kr.ulsan.ldh.kiosk-data.log"' ERR

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

if [[ -z "${DATA_GO_KR_SERVICE_KEY:-}" ]]; then
  DATA_GO_KR_SERVICE_KEY="$(security find-generic-password -s "$KEYCHAIN_SERVICE" -a "$KEYCHAIN_ACCOUNT" -w)"
fi
export DATA_GO_KR_SERVICE_KEY PAGES_BASE_URL

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
