#!/bin/zsh
# launchd 작업 kr.ulsan.ldh.kiosk-data 를 설치(또는 갱신)한다. 다시 실행해도 된다.
#
# ~/Documents 는 macOS 개인정보 보호(TCC) 때문에 백그라운드 작업이 못 읽는 경우가 있어,
# 실행용 사본을 ~/Library/Application Support 아래에 따로 clone 한다.
set -euo pipefail

LABEL="kr.ulsan.ldh.kiosk-data"
RUN_DIR="$HOME/Library/Application Support/$LABEL/repo"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/$LABEL.log"

if [[ -d "$RUN_DIR/.git" ]]; then
  git -C "$RUN_DIR" pull --ff-only --quiet origin main
else
  mkdir -p "${RUN_DIR:h}"
  git clone --quiet https://github.com/ldh-prog/kiosk-data.git "$RUN_DIR"
fi

if ! security find-generic-password -s "$LABEL" -a DATA_GO_KR_SERVICE_KEY >/dev/null 2>&1; then
  print "키체인에 인증키가 없습니다. 아래 명령으로 넣은 뒤 다시 실행하세요(-w 뒤를 비우면 입력을 묻습니다)."
  print "  security add-generic-password -U -s $LABEL -a DATA_GO_KR_SERVICE_KEY -w"
  exit 1
fi

mkdir -p "${PLIST:h}" "${LOG:h}"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/caffeinate</string>
    <string>-i</string>
    <string>/bin/zsh</string>
    <string>$RUN_DIR/scripts/publish-local.sh</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>3</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>$LOG</string>
  <key>StandardErrorPath</key>
  <string>$LOG</string>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID" "$PLIST"
print "설치 완료: 매일 03:00 (잠자기 중이면 깨어난 직후)"
print "지금 한 번 실행: launchctl kickstart gui/$UID/$LABEL"
print "로그: $LOG"
