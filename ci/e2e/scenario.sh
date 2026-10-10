#!/usr/bin/env bash
# Inside a blank systemd container: one phase of the Phi Bot end-to-end test (spec 15.2), run as
# root by scripts/phibot-e2e-install.sh. Each check prints "E2E OK <check>"; the first failed check
# prints "E2E FAIL <check>", the service diagnostics, and exits with code 1.
#
# Usage: bash /e2e/scenario.sh <phase> [arguments]
#   node                                   Node.js 24 by the NodeSource commands of the README (spec 6.1)
#   install <version> <registry>           the command of spec section 0, access ssh, then the checks of 15.2 point 2
#   functional                             15.2 point 3 (scripted fake provider, API path, run)
#   backup                                 phibot backup --full, prints "E2E ARCHIVE <path>"
#   reconfigure                            15.2 point 6: setup --reconfigure from ssh to domain (--tls-internal)
#   uninstall                              15.2 point 8: phibot uninstall --yes, data kept
#   restore <version> <registry> <archive> <company id>   15.2 points 4 and 7: fresh server, domain access
#   update <version> <registry>            15.2 point 5: update from the installed version, then rollback
set -uo pipefail

PHASE="${1:-}"
E2E_DIR=/e2e
PW_FILE=/root/e2e-owner-password
EMAIL=ci@example.invalid
DOMAIN=phibot.ci.test
PAGE_HOST=phibot-e2e.test
FAKE_KEY=sk-test-e2e-9b2f
INSTANCE=/var/lib/phibot/.paperclip/instances/default
INSTALL_ENV=(PHI_SKIP_POSTINSTALL=1 CAMOUFOX_SKIP_DOWNLOAD=1 ONNXRUNTIME_NODE_INSTALL_CUDA=skip)

ok() { echo "E2E OK $*"; }
diagnose() {
  systemctl --no-pager status phibot.service phibot-guard.service caddy.service 2>&1 | tail -n 60
  journalctl --no-pager -u phibot.service -n 200 2>&1 | tail -n 200
}
fail() {
  echo "E2E FAIL $*"
  diagnose
  exit 1
}
check() {
  local name="$1"
  shift
  if "$@"; then ok "$name"; else fail "$name"; fi
}

health_status() { curl -fsS --max-time 5 http://127.0.0.1:3100/api/health 2>/dev/null | node -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).status)}catch{console.log("none")}})'; }
wait_health() {
  for _ in $(seq 1 120); do
    [ "$(health_status)" = "ok" ] && return 0
    sleep 5
  done
  return 1
}
installed_version() { node -p 'require(require("node:child_process").execSync("npm root -g").toString().trim() + "/@phi-code-admin/phi-bot/package.json").version'; }
package_dir() { echo "$(npm root -g)/@phi-code-admin/phi-bot"; }
auth_origin() {
  node -e 'const a=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).auth;console.log(a.baseUrlMode==="explicit"&&a.publicBaseUrl?new URL(a.publicBaseUrl).origin:"http://127.0.0.1:3100")' "$INSTANCE/config.json"
}
functional() {
  E2E_EMAIL="$EMAIL" E2E_PASSWORD_FILE="$PW_FILE" E2E_API_KEY="$FAKE_KEY" E2E_PROVIDER_URL=http://127.0.0.1:18765/v1 \
    E2E_AUTH_ORIGIN="$(auth_origin)" node "$E2E_DIR/functional.mjs" "$@"
}
only_loopback() {
  local port="$1"
  local addresses
  addresses="$(ss -ltnH "sport = :$port" | awk '{print $4}')"
  [ -n "$addresses" ] && ! echo "$addresses" | grep -vqE '^(127\.0\.0\.1|\[::1\]):'
}
nobody_refused() { ! runuser -u nobody -- bash -c 'exec 3<>/dev/tcp/127.0.0.1/54329' 2>/dev/null; }
no_bootstrap_link() { [ "$(journalctl --no-pager -u phibot.service | grep -c pcp_bootstrap_)" = "0" ]; }
write_password() {
  umask 077
  printf 'e2e-owner-pass-%s\n' "$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')" > "$PW_FILE"
}
# The command of spec section 0, with the local registry (15.2 point 1).
run_setup() {
  local version="$1" registry="$2"
  shift 2
  env "${INSTALL_ENV[@]}" PHIBOT_NPM_REGISTRY="$registry" \
    npx --yes --registry "$registry" "@phi-code-admin/phi-bot@$version" setup "$@" 2>&1 | tee /root/setup.log
  return "${PIPESTATUS[0]}"
}
# npm warns about every install script missing from --allow-scripts (spec 5.4): none may be missing.
allow_scripts_complete() { ! sed -n '/npm install -g, plusieurs minutes/,$p' /root/setup.log | grep -q 'not yet covered by allowScripts'; }

case "$PHASE" in
  node)
    curl -fsSL https://deb.nodesource.com/setup_24.x -o /tmp/nodesource_setup.sh || fail "download NodeSource"
    bash /tmp/nodesource_setup.sh > /tmp/nodesource.log 2>&1 || fail "NodeSource repository"
    apt-get install -y nodejs > /tmp/node-install.log 2>&1 || fail "apt-get install nodejs"
    # Test tool only (ss), not a Phi Bot requirement.
    apt-get install -y iproute2 > /dev/null 2>&1 || fail "apt-get install iproute2"
    check "node $(node --version) >= 24.11" node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>24||(a===24&&b>=11)?0:1)'
    ;;
  install)
    VERSION="$2" REGISTRY="$3"
    write_password
    run_setup "$VERSION" "$REGISTRY" --access ssh --yes --owner-email "$EMAIL" --owner-password-file "$PW_FILE" --company CI \
      || fail "setup (section 0 command)"
    ok "setup (section 0 command)"
    check "install scripts all allowed" allow_scripts_complete
    check "phibot.service active" test "$(systemctl is-active phibot.service)" = active
    check "phibot.service enabled" test "$(systemctl is-enabled phibot.service)" = enabled
    check "phibot-guard.service active" test "$(systemctl is-active phibot-guard.service)" = active
    check "health ok" test "$(health_status)" = ok
    check "installed version = $VERSION" test "$(installed_version)" = "$VERSION"
    check "shrinkwrap respected" node /e2e-tools/phibot-pack.mjs --verify-install "$(package_dir)"
    functional signin || fail "owner sign-in and one company"
    check "port 3100 on loopback only" only_loopback 3100
    check "port 54329 on loopback only" only_loopback 54329
    check "database refused to another account (nobody)" nobody_refused
    check "phi runs as phibot" runuser -u phibot -- "$(package_dir)/node_modules/.bin/phi" --version
    check "no pcp_bootstrap_ in the journal" no_bootstrap_link
    phibot backup --full > /root/backup.log 2>&1 || fail "backup --full"
    check "backup --full archive" bash -c "ls $INSTANCE/data/backups/full-*.tar.gz > /dev/null"
    phibot doctor > /root/doctor.log 2>&1 || { cat /root/doctor.log; fail "doctor without failure"; }
    ok "doctor without failure"
    systemctl restart phibot.service
    check "restart then health ok" wait_health
    ;;
  functional)
    grep -q "$PAGE_HOST" /etc/hosts || echo "127.0.0.1 $PAGE_HOST" >> /etc/hosts
    nohup node "$E2E_DIR/mock-llm.mjs" 18765 /root/mock-llm.log "http://$PAGE_HOST:18765/e2e-page" > /root/mock-llm.out 2>&1 &
    sleep 2
    functional full | tee /root/functional.log
    [ "${PIPESTATUS[0]}" = "0" ] || fail "functional path"
    node "$E2E_DIR/verify-mock-log.mjs" /root/mock-llm.log || fail "provider requests"
    check "memory note in /var/lib/phibot/.phi/memory/notes" grep -rqs PHIBOT-E2E-MEMORY-5c1d /var/lib/phibot/.phi/memory/notes
    sleep 5
    check "no port 17318 open" bash -c '! ss -ltnH "sport = :17318" | grep -q .'
    check "fake key absent from the journal" bash -c "! journalctl --no-pager -u phibot.service | grep -q $FAKE_KEY"
    check "fake key absent from /var/lib/phibot/.phi/phibot" bash -c "! grep -rqs $FAKE_KEY /var/lib/phibot/.phi/phibot"
    check "UI title Phi Bot" bash -c 'curl -fsS http://127.0.0.1:3100/ | grep -q "<title>Phi Bot</title>"'
    ;;
  backup)
    phibot backup --full > /root/backup2.log 2>&1 || fail "backup --full before restore"
    # shellcheck disable=SC2012 # archive names are full-<timestamp>.tar.gz
    ARCHIVE="$(ls -t "$INSTANCE"/data/backups/full-*.tar.gz | head -n 1)"
    ok "backup --full before restore"
    echo "E2E ARCHIVE $ARCHIVE"
    ;;
  reconfigure)
    grep -q "$DOMAIN" /etc/hosts || echo "127.0.0.1 $DOMAIN" >> /etc/hosts
    phibot setup --reconfigure --access domain --domain "$DOMAIN" --tls-internal --yes > /root/reconfigure.log 2>&1 \
      || { cat /root/reconfigure.log; fail "setup --reconfigure ssh -> domain"; }
    ok "setup --reconfigure ssh -> domain"
    check "caddy.service active" test "$(systemctl is-active caddy.service)" = active
    check "HTTPS health through Caddy (curl --resolve)" bash -c "curl -fsSk --resolve $DOMAIN:443:127.0.0.1 https://$DOMAIN/api/health | grep -q '\"status\":\"ok\"'"
    check "public URL in .env" grep -q "^PAPERCLIP_PUBLIC_URL=https://$DOMAIN" "$INSTANCE/.env"
    functional signin || fail "owner sign-in after reconfigure"
    ;;
  uninstall)
    phibot uninstall --yes > /root/uninstall.log 2>&1 || { cat /root/uninstall.log; fail "phibot uninstall --yes"; }
    ok "phibot uninstall --yes"
    check "phibot.service stopped" test "$(systemctl is-active phibot.service)" != active
    check "unit removed" test ! -e /etc/systemd/system/phibot.service
    check "guard removed" test ! -e /etc/systemd/system/phibot-guard.service
    check "Caddy unit removed" test ! -e /etc/systemd/system/caddy.service
    check "data kept" test -f "$INSTANCE/config.json"
    ;;
  restore)
    VERSION="$2" REGISTRY="$3" ARCHIVE="$4" COMPANY="$5"
    grep -q "$DOMAIN" /etc/hosts || echo "127.0.0.1 $DOMAIN" >> /etc/hosts
    run_setup "$VERSION" "$REGISTRY" --restore "$ARCHIVE" --access domain --domain "$DOMAIN" --tls-internal --yes \
      || fail "setup --restore (domain access, --tls-internal)"
    ok "setup --restore (domain access, --tls-internal)"
    check "health ok" test "$(health_status)" = ok
    check "HTTPS health through Caddy (curl --resolve)" bash -c "curl -fsSk --resolve $DOMAIN:443:127.0.0.1 https://$DOMAIN/api/health | grep -q '\"status\":\"ok\"'"
    functional signin | tee /root/signin.log
    [ "${PIPESTATUS[0]}" = "0" ] || fail "owner sign-in with the old password"
    check "same company" grep -q "^E2E COMPANY $COMPANY$" /root/signin.log
    check "memory note restored" grep -rqs PHIBOT-E2E-MEMORY-5c1d /var/lib/phibot/.phi/memory/notes
    ;;
  update)
    VERSION="$2" REGISTRY="$3"
    PREVIOUS="$(installed_version)"
    env PHIBOT_NPM_REGISTRY="$REGISTRY" phibot update --version "$VERSION" 2>&1 | tee /root/update.log
    [ "${PIPESTATUS[0]}" = "0" ] || fail "update $PREVIOUS -> $VERSION"
    check "update: version $VERSION" test "$(installed_version)" = "$VERSION"
    check "update: service active" test "$(systemctl is-active phibot.service)" = active
    check "update: health ok" test "$(health_status)" = ok
    check "update: pre-update archive" bash -c "ls $INSTANCE/data/backups/pre-update-*.tar.gz > /dev/null"
    env PHIBOT_NPM_REGISTRY="$REGISTRY" phibot update --version "$PREVIOUS" --yes 2>&1 | tee /root/rollback.log
    [ "${PIPESTATUS[0]}" = "0" ] || fail "rollback $VERSION -> $PREVIOUS"
    check "rollback: version $PREVIOUS" test "$(installed_version)" = "$PREVIOUS"
    check "rollback: health ok" test "$(health_status)" = ok
    ;;
  *)
    echo "usage: bash /e2e/scenario.sh node|install|functional|backup|reconfigure|uninstall|restore|update ..." >&2
    exit 2
    ;;
esac
