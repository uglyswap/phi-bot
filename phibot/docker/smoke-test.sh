#!/usr/bin/env bash
# Smoke test of the Phi Bot Docker image (spec 14, plan F), run by .github/workflows/phibot-docker.yml.
# Usage: bash phibot/docker/smoke-test.sh <image>
# Needs docker, curl, jq and openssl. Every checkpoint prints one line starting with "SMOKE ".
set -euo pipefail

IMAGE="${1:?usage : smoke-test.sh <image>}"
NAME="phibot-smoke"
VOLUME="phibot-smoke-data"
BASE_URL="http://127.0.0.1:3100"
OWNER_EMAIL="fumee@example.com"
COMPANY_NAME="Entreprise de fumée"
COMPANIES_DIR="/var/lib/phibot/.phi/phibot/companies"
BACKUP_DIR="/var/lib/phibot/.paperclip/instances/default/data/backups"
FIRST_START_TIMEOUT="${PHIBOT_SMOKE_FIRST_START_TIMEOUT:-1800}"
WORK="$(mktemp -d)"

cleanup() {
  local status=$?
  if [ "$status" -ne 0 ]; then
    echo "--- docker logs $NAME (200 dernières lignes) ---"
    docker logs --tail 200 "$NAME" 2>&1 || true
  fi
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker volume rm "$VOLUME" >/dev/null 2>&1 || true
  rm -rf "$WORK"
  exit "$status"
}
trap cleanup EXIT

fail() {
  echo "SMOKE ÉCHEC : $*" >&2
  exit 1
}

# Prints one field of the anonymous /api/health answer, or nothing.
health_field() {
  curl -fsS --max-time 5 "$BASE_URL/api/health" 2>/dev/null | jq -r ".$1 // empty" 2>/dev/null || true
}

wait_for_health() {
  local timeout="$1" waited=0
  while [ "$waited" -lt "$timeout" ]; do
    if [ "$(health_field status)" = "ok" ]; then
      echo "santé ok après ${waited} s"
      return 0
    fi
    if [ "$(docker inspect -f '{{.State.Running}}' "$NAME")" != "true" ]; then
      fail "le conteneur s'est arrêté avant d'être prêt"
    fi
    sleep 10
    waited=$((waited + 10))
  done
  fail "santé non atteinte après ${timeout} s"
}

docker rm -f "$NAME" >/dev/null 2>&1 || true
docker volume rm "$VOLUME" >/dev/null 2>&1 || true
docker volume create "$VOLUME" >/dev/null
docker run -d --name "$NAME" --shm-size=1g -p 127.0.0.1:3100:3100 -v "$VOLUME:/var/lib/phibot" "$IMAGE" >/dev/null
echo "SMOKE 01 conteneur démarré"

[ "$(docker exec "$NAME" id -un):$(docker exec "$NAME" id -u)" = "phibot:10001" ] || fail "le conteneur ne tourne pas sous phibot (10001)"
[ "$(docker exec "$NAME" cat /proc/1/comm)" = "tini" ] || fail "tini n'est pas le processus 1"
echo "SMOKE 02 compte phibot (uid 10001), tini en PID 1"

wait_for_health "$FIRST_START_TIMEOUT"
echo "SMOKE 03 /api/health : status=ok"

[ "$(health_field bootstrapStatus)" = "pending" ] || fail "bootstrapStatus attendu : pending"
if docker logs "$NAME" 2>&1 | grep -q "/invite/"; then fail "un lien d'invitation apparaît dans docker logs"; fi
echo "SMOKE 04 bootstrapStatus=pending, aucun lien d'invitation dans les journaux"

health=""
for _ in $(seq 1 24); do
  health="$(docker inspect -f '{{.State.Health.Status}}' "$NAME")"
  [ "$health" = "healthy" ] && break
  sleep 5
done
[ "$health" = "healthy" ] || fail "HEALTHCHECK de l'image : $health"
echo "SMOKE 05 HEALTHCHECK de l'image : healthy"

password="$(openssl rand -hex 16)"
if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::add-mask::$password"; fi
printf '%s\n' "$password" | docker exec -i "$NAME" sh -c 'umask 077 && cat > /tmp/owner-password'
docker exec "$NAME" phibot owner create --owner-email "$OWNER_EMAIL" --owner-name "Fumée" \
  --owner-password-file /tmp/owner-password --company "$COMPANY_NAME" --yes 2>&1 | tee "$WORK/owner-1.txt"
grep -qF "Préparation de phi pour l'entreprise" "$WORK/owner-1.txt" || fail "owner create n'a pas lancé phi:prepare"
echo "SMOKE 06 phibot owner create : propriétaire et entreprise créés"

ids="$(docker exec "$NAME" ls -1 "$COMPANIES_DIR")"
printf '%s\n' "$ids" | grep -Eqx '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' || fail "identifiant d'entreprise introuvable dans $COMPANIES_DIR : $ids"
[ "$(printf '%s\n' "$ids" | wc -l)" -eq 1 ] || fail "une seule entreprise attendue dans $COMPANIES_DIR : $ids"
company_id="$ids"
agent_dir="$COMPANIES_DIR/$company_id/agent"
docker exec "$NAME" test -f "$agent_dir/settings.json" || fail "$agent_dir/settings.json absent"
docker exec "$NAME" test -f "$agent_dir/cache/models/Xenova/all-MiniLM-L6-v2/onnx/model_quantized.onnx" || fail "modèle d'embedding absent"
[ "$(health_field bootstrapStatus)" = "ready" ] || fail "bootstrapStatus attendu : ready"
echo "SMOKE 07 entreprise prête (dossier agent, modèle d'embedding), bootstrapStatus=ready"

docker exec "$NAME" phibot owner create --owner-email "$OWNER_EMAIL" \
  --owner-password-file /tmp/owner-password --company "$COMPANY_NAME" --yes 2>&1 | tee "$WORK/owner-2.txt"
grep -qF "Le propriétaire et l'entreprise existent déjà." "$WORK/owner-2.txt" || fail "owner create relancé n'est pas idempotent"
docker exec "$NAME" rm -f /tmp/owner-password
echo "SMOKE 08 phibot owner create relancé : rien à refaire"

jq -n --arg email "$OWNER_EMAIL" --arg password "$password" '{email: $email, password: $password}' > "$WORK/sign-in.json"
code="$(curl -sS -o "$WORK/sign-in-answer.json" -w '%{http_code}' -H 'Content-Type: application/json' \
  -H "Origin: $BASE_URL" --data @"$WORK/sign-in.json" "$BASE_URL/api/auth/sign-in/email")"
[ "$code" = "200" ] || fail "connexion du propriétaire : HTTP $code"
echo "SMOKE 09 connexion du propriétaire : HTTP 200"

docker exec "$NAME" phibot phi:prepare --company "$company_id" 2>&1 | tee "$WORK/prepare.txt"
grep -qF "Version de phi" "$WORK/prepare.txt" || fail "phi:prepare n'a pas fini"
echo "SMOKE 10 phibot phi:prepare --company <id>"

docker restart -t 60 "$NAME" >/dev/null
wait_for_health 600
[ "$(health_field bootstrapStatus)" = "ready" ] || fail "bootstrapStatus attendu après redémarrage : ready"
echo "SMOKE 11 redémarrage : données conservées, santé ok"

docker exec "$NAME" phibot backup --full 2>&1 | tee "$WORK/backup.txt"
archives="$(docker exec "$NAME" sh -c "ls -1 $BACKUP_DIR | grep -c '^full-.*\\.tar\\.gz\$'" || true)"
[ "$archives" = "1" ] || fail "une archive full-*.tar.gz attendue, trouvé : $archives"
mode="$(docker exec "$NAME" sh -c "stat -c %a $BACKUP_DIR/full-*.tar.gz")"
[ "$mode" = "600" ] || fail "mode de l'archive : $mode (600 attendu)"
echo "SMOKE 12 phibot backup --full : une archive 0600"

echo "SMOKE OK"
