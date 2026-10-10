/**
 * Fixed identity and locations of a Phi Bot installation (spec sections 4.2, 5.4, 6).
 * Server paths are Linux paths and always use "/" separators.
 */
export const PHIBOT_PACKAGE_NAME = "@phi-code-admin/phi-bot";
export const PHIBOT_PACKAGE_SCOPE = "@phi-code-admin";
export const PHIBOT_BIN_NAME = "phibot";
export const PHIBOT_REPOSITORY_URL = "https://github.com/uglyswap/phi-bot";

export const PHIBOT_SYSTEM_USER = "phibot";
export const PHIBOT_HOME_DIR = "/var/lib/phibot";
export const PHIBOT_PAPERCLIP_HOME = "/var/lib/phibot/.paperclip";
export const PHIBOT_INSTANCE_ID = "default";
export const PHIBOT_INSTANCE_ROOT = "/var/lib/phibot/.paperclip/instances/default";
export const PHIBOT_CONFIG_PATH = `${PHIBOT_INSTANCE_ROOT}/config.json`;
export const PHIBOT_ENV_PATH = `${PHIBOT_INSTANCE_ROOT}/.env`;
export const PHIBOT_ADAPTERS_PATH = `${PHIBOT_INSTANCE_ROOT}/adapters.json`;
export const PHIBOT_MASTER_KEY_PATH = `${PHIBOT_INSTANCE_ROOT}/secrets/master.key`;
export const PHIBOT_BACKUP_DIR = `${PHIBOT_INSTANCE_ROOT}/data/backups`;
export const PHIBOT_SETUP_MARKER_PATH = `${PHIBOT_INSTANCE_ROOT}/.phibot-setup-complete`;
export const PHIBOT_PHI_DIR = "/var/lib/phibot/.phi";
export const PHIBOT_COMPANIES_DIR = "/var/lib/phibot/.phi/phibot/companies";
export const PHIBOT_CAMOUFOX_CACHE_DIR = "/var/lib/phibot/.cache/phi-code/camoufox";
export const ROOT_CAMOUFOX_CACHE_DIR = "/root/.cache/phi-code/camoufox";

export const PHIBOT_UNIT_NAME = "phibot.service";
export const PHIBOT_UNIT_PATH = "/etc/systemd/system/phibot.service";
export const PHIBOT_GUARD_UNIT_NAME = "phibot-guard.service";
export const PHIBOT_GUARD_UNIT_PATH = "/etc/systemd/system/phibot-guard.service";
export const PHIBOT_GUARD_DIR = "/etc/phibot";
export const PHIBOT_GUARD_NFT_PATH = "/etc/phibot/guard.nft";
export const PHIBOT_SERVER_PORT = 3100;
export const PHIBOT_DB_PORT = 54329;
export const PHIBOT_LOCAL_URL = "http://127.0.0.1:3100";
export const PHIBOT_SSH_PUBLIC_URL = "http://localhost:3100";
export const PHIBOT_DB_URL = "postgres://paperclip:paperclip@127.0.0.1:54329/paperclip";

export const PHIBOT_DEFAULT_COMPANY_NAME = "Mon entreprise";
export const PHIBOT_MIN_PASSWORD_LENGTH = 12;
export const PHIBOT_DEFAULT_NPM_REGISTRY = "https://registry.npmjs.org";
/**
 * Install scripts allowed by `npm install -g` (spec 5.4): the ones Phi Bot cannot run without
 * (prebuilt better-sqlite3 binary, symlinks of the embedded Postgres libraries). Plan E2 completes
 * this list from npm's warnings on the published archive.
 */
export const PHIBOT_NPM_ALLOW_SCRIPTS = ["better-sqlite3", "@embedded-postgres/linux-x64"] as const;
/** Environment of the root `npm install -g` (spec 6.2 step 5). */
export const PHIBOT_NPM_INSTALL_ENV = {
  CAMOUFOX_SKIP_DOWNLOAD: "1",
  ONNXRUNTIME_NODE_INSTALL_CUDA: "skip",
  PHI_SKIP_POSTINSTALL: "1",
} as const;

export const PHIBOT_HEALTH_TIMEOUT_MS = 300_000;
export const PHIBOT_MIN_TOTAL_MEMORY_BYTES = 3 * 1024 ** 3;
export const PHIBOT_RECOMMENDED_MEMORY_BYTES = 7 * 1024 ** 3;
export const PHIBOT_MIN_FREE_DISK_BYTES = 10 * 1024 ** 3;
export const PHIBOT_DOCTOR_MIN_FREE_DISK_BYTES = 5 * 1024 ** 3;
export const PHIBOT_BACKUP_MAX_AGE_MS = 26 * 60 * 60 * 1000;

export const CADDY_VERSION = "2.11.7";
export const CADDY_ARCHIVE_NAME = `caddy_${CADDY_VERSION}_linux_amd64.tar.gz`;
export const CADDY_ARCHIVE_URL = `https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}/${CADDY_ARCHIVE_NAME}`;
/** SHA-512 of the archive, checked against caddy_2.11.7_checksums.txt on 2026-10-08. */
export const CADDY_ARCHIVE_SHA512 =
  "a7a433a1b133efc3c8d10eb0b99d52a24b5ef5c322dc77f5282182b1c0402139ab83f3a99f0c52409df77d20123fb0b523edad8a66d8f5e49136197bf61ef0e7";
export const CADDY_BINARY_PATH = "/usr/local/bin/caddy";
export const CADDY_CONFIG_DIR = "/etc/caddy";
export const CADDYFILE_PATH = "/etc/caddy/Caddyfile";
export const CADDY_INSTALL_MARKER_PATH = "/etc/caddy/.phibot-installed";
export const CADDY_UNIT_PATH = "/etc/systemd/system/caddy.service";
export const CADDY_MANAGED_HEADER = "# managed-by: phibot";
export const CADDY_HEALTH_TIMEOUT_MS = 120_000;
