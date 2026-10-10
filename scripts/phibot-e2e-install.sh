#!/usr/bin/env bash
# Phi Bot end-to-end installation test (PHIBOT-SOLO-SPEC.md section 15.2), on a Linux host with
# Docker: the archive that will be published, served by a local Verdaccio registry, installed by
# the README command in blank systemd containers (ci/e2e/Dockerfile.<distro>).
#
# Usage: bash scripts/phibot-e2e-install.sh <archive .tgz> <version> [<distro>]
#   <distro>: ubuntu-24.04 (default), ubuntu-22.04 or debian-12
# Environment: PHIBOT_E2E_PREVIOUS=<version> forces the version used by the update test
# (default: the highest version published on npm below <version>, 0.0.0 excluded; none = skipped).
# Output: one "E2E OK <check>" line per check; exit code 1 at the first failure.
set -euo pipefail

TGZ="${1:?usage: phibot-e2e-install.sh <archive .tgz> <version> [<distro>]}"
VERSION="${2:?usage: phibot-e2e-install.sh <archive .tgz> <version> [<distro>]}"
DISTRO="${3:-ubuntu-24.04}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d "${RUNNER_TEMP:-/tmp}/phibot-e2e.XXXXXX")"
REGISTRY_HOST="http://127.0.0.1:4873"
REGISTRY="http://host.docker.internal:4873"
IMAGE="phibot-e2e-$DISTRO"
CONTAINERS=()
VERDACCIO_PID=""

case "$DISTRO" in ubuntu-24.04 | ubuntu-22.04 | debian-12) ;; *) echo "unknown distro: $DISTRO" >&2; exit 2 ;; esac
[ -f "$TGZ" ] || { echo "archive not found: $TGZ" >&2; exit 2; }
TGZ="$(cd "$(dirname "$TGZ")" && pwd)/$(basename "$TGZ")"

cleanup() {
  for name in "${CONTAINERS[@]}"; do docker rm -f "$name" > /dev/null 2>&1 || true; done
  [ -n "$VERDACCIO_PID" ] && kill "$VERDACCIO_PID" 2> /dev/null || true
}
trap cleanup EXIT

# 1. The archive itself (spec 5.1, 5.2, 5.5).
node "$REPO_ROOT/scripts/phibot-pack.mjs" --check-archive "$TGZ" --version "$VERSION"
echo "E2E OK archive content"

# 2. Local registry (research R1 section 7.3): Verdaccio 6.10.4, listening for the containers too.
mkdir -p "$WORK/verdaccio"
cp "$REPO_ROOT/ci/e2e/verdaccio.yaml" "$WORK/verdaccio/config.yaml"
(cd "$WORK/verdaccio" && exec npx --yes verdaccio@6.10.4 --config ./config.yaml --listen 0.0.0.0:4873 > verdaccio.log 2>&1) &
VERDACCIO_PID=$!
for _ in $(seq 1 60); do curl -fsS "$REGISTRY_HOST/-/ping" > /dev/null 2>&1 && break; sleep 2; done
curl -fsS "$REGISTRY_HOST/-/ping" > /dev/null || { cat "$WORK/verdaccio/verdaccio.log"; exit 1; }
TOKEN="$(curl -fsS -X PUT -H 'Content-Type: application/json' -d '{"name":"ci","password":"ci-pass-e2e"}' \
  "$REGISTRY_HOST/-/user/org.couchdb.user:ci" | node -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>console.log(JSON.parse(s).token))')"
printf '//127.0.0.1:4873/:_authToken=%s\n' "$TOKEN" > "$WORK/npmrc"
npm publish "$TGZ" --registry "$REGISTRY_HOST" --userconfig "$WORK/npmrc" --tag e2e
node "$REPO_ROOT/ci/e2e/mark-shrinkwrap.mjs" "$WORK/verdaccio/storage" @phi-code-admin/phi-bot "$VERSION"
echo "E2E OK archive published on the local registry"

# 3. Blank systemd containers.
docker build --quiet -t "$IMAGE" -f "$REPO_ROOT/ci/e2e/Dockerfile.$DISTRO" "$REPO_ROOT/ci/e2e" > /dev/null
start_container() {
  local name="$1"
  docker run -d --name "$name" --hostname "$name" --privileged --cgroupns=host \
    -v /sys/fs/cgroup:/sys/fs/cgroup:rw --tmpfs /run --tmpfs /run/lock \
    --add-host host.docker.internal:host-gateway "$IMAGE" > /dev/null
  CONTAINERS+=("$name")
  for _ in $(seq 1 60); do
    state="$(docker exec "$name" systemctl is-system-running 2> /dev/null || true)"
    case "$state" in running | degraded) break ;; esac
    sleep 2
  done
  docker cp "$REPO_ROOT/ci/e2e/." "$name:/e2e"
  docker exec "$name" mkdir -p /e2e-tools
  docker cp "$REPO_ROOT/scripts/phibot-pack.mjs" "$name:/e2e-tools/phibot-pack.mjs"
  docker cp "$REPO_ROOT/scripts/phibot-pack-lib.mjs" "$name:/e2e-tools/phibot-pack-lib.mjs"
  echo "E2E OK container $name ($DISTRO, systemd $state)"
}
phase() {
  local name="$1"
  shift
  docker exec "$name" bash /e2e/scenario.sh "$@"
}

# 4. Installation, checks, functional path, reconfiguration, backup, uninstallation (points 1 to 3, 6, 8).
A="phibot-e2e-$DISTRO-a"
start_container "$A"
phase "$A" node
phase "$A" install "$VERSION" "$REGISTRY"
phase "$A" functional | tee "$WORK/functional.log"
COMPANY="$(sed -n 's/^E2E COMPANY //p' "$WORK/functional.log" | head -n 1)"
phase "$A" reconfigure
phase "$A" backup | tee "$WORK/backup.log"
ARCHIVE="$(sed -n 's/^E2E ARCHIVE //p' "$WORK/backup.log")"
docker cp "$A:$ARCHIVE" "$WORK/full-backup.tar.gz"
phase "$A" uninstall

# 5. Restoration on a new blank server, domain access with Caddy's internal certificate (points 4 and 7).
B="phibot-e2e-$DISTRO-b"
start_container "$B"
docker cp "$WORK/full-backup.tar.gz" "$B:/root/full-backup.tar.gz"
docker exec "$B" chmod 600 /root/full-backup.tar.gz
phase "$B" node
phase "$B" restore "$VERSION" "$REGISTRY" /root/full-backup.tar.gz "$COMPANY"

# 6. Update from the previous published version, then rollback (point 5).
PREVIOUS="${PHIBOT_E2E_PREVIOUS:-$(npm view @phi-code-admin/phi-bot versions --json 2> /dev/null | node -e '
let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
  const target = process.argv[1].split(/[.-]/).map(Number);
  const older = (v) => { const p = v.split(/[.-]/).map(Number); for (let i = 0; i < 3; i += 1) if (p[i] !== target[i]) return p[i] < target[i]; return false; };
  let list = []; try { list = [].concat(JSON.parse(s)); } catch {}
  const candidates = list.filter((v) => v !== "0.0.0" && !v.includes("-") && older(v));
  console.log(candidates.at(-1) ?? "");
});' "$VERSION")}"
if [ -z "$PREVIOUS" ]; then
  echo "E2E SKIP update: no earlier Phi Bot version published"
else
  C="phibot-e2e-$DISTRO-c"
  start_container "$C"
  phase "$C" node
  phase "$C" install "$PREVIOUS" "$REGISTRY"
  phase "$C" update "$VERSION" "$REGISTRY"
fi
echo "E2E RESULT OK $DISTRO $VERSION"
