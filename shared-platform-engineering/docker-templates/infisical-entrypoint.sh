#!/bin/sh
# =============================================================================
# 🔐 UNIVERSAL INFISICAL ENTRYPOINT - Zero-Code Secret Injection
# =============================================================================
# 
# This entrypoint wrapper injects secrets from Infisical WITHOUT modifying 
# any microservice code. The service thinks it's reading from process.env,
# but Infisical CLI has already populated those variables.
#
# How it works:
#   1. Detects SERVICE_NAME environment variable (set by Tiltfile)
#   2. Constructs Infisical secret path: /services/{SERVICE_NAME}
#   3. Authenticates using Machine Identity (Universal Auth)
#   4. Uses `infisical run` to fetch secrets and inject into process env
#   5. Executes the original command (bun, npm, node, etc.)
#
# Key Benefits:
#   - Zero refactoring: No SDK imports in microservices
#   - Dynamic pathing: Auto-discovers service-specific secrets
#   - Fallback support: Works without Infisical (for local dev)
#   - Prisma compatible: CLI commands also see injected secrets
#
# 🗃️ DATABASE VIRTUALIZATION (BigTech Pattern):
#   - Single PostgreSQL container with logical databases
#   - Entrypoint waits for database to be ready before starting app
#   - Saves ~80% RAM compared to 120 separate PostgreSQL containers
#
# 🎯 INVERSION OF CONTROL (Tilt as Single Source of Truth):
#   - TILT_DATABASE_URL: If set by Docker Compose/Tilt, ALWAYS wins over Infisical
#   - This ensures Tilt-created databases match application connections
#   - Solves the "hidden DB secret" paradox without modifying Infisical
#   - Precedence: TILT_DATABASE_URL > Infisical DATABASE_URL > Fallback
# =============================================================================

set -e

# Colors for terminal output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

log_info() {
  printf "${BLUE}[ENTRYPOINT]${NC} %s\n" "$1"
}

log_success() {
  printf "${GREEN}[ENTRYPOINT]${NC} %s\n" "$1"
}

log_warn() {
  printf "${YELLOW}[ENTRYPOINT]${NC} %s\n" "$1"
}

log_error() {
  printf "${RED}[ENTRYPOINT]${NC} %s\n" "$1"
}

log_db() {
  printf "${CYAN}[DATABASE]${NC} %s\n" "$1"
}

# =============================================================================
# CONFIGURATION
# =============================================================================

# Service name (auto-detected from container or fallback to env var)
SERVICE_NAME="${SERVICE_NAME:-unknown-service}"

# Infisical configuration
INFISICAL_SITE_URL="${INFISICAL_SITE_URL:-https://app.infisical.com}"
INFISICAL_ENV="${INFISICAL_ENV:-dev}"
INFISICAL_SECRET_PATH="${INFISICAL_SECRET_PATH:-/services/${SERVICE_NAME}}"

# Check if Infisical is enabled (can be disabled for local dev)
INFISICAL_ENABLED="${INFISICAL_ENABLED:-true}"

# Database connectivity settings
DB_WAIT_TIMEOUT="${DB_WAIT_TIMEOUT:-60}"
DB_WAIT_INTERVAL="${DB_WAIT_INTERVAL:-2}"

# =============================================================================
# 🎯 INVERSION OF CONTROL - Tilt as Single Source of Truth
# =============================================================================
# 
# Problem: Tilt creates databases but doesn't know what Infisical contains.
#          This causes DATABASE_URL mismatch (e.g., tdk_project_staff vs staff_db_prod)
#
# Solution: TILT_* prefixed variables ALWAYS override Infisical secrets
#           Tilt sets TILT_DATABASE_URL → we export it as DATABASE_URL BEFORE infisical run
#
# Variables that can be overridden by Tilt:
#   - TILT_DATABASE_URL → DATABASE_URL
#   - TILT_NATS_URL → NATS_URL
#   - TILT_REDIS_URL → REDIS_URL
#   - TILT_* → * (generic pattern)
# =============================================================================

  # List of critical variables that Tilt can override
TILT_OVERRIDE_VARS="DATABASE_URL NATS_URL REDIS_URL DB_HOST DB_PORT DB_NAME DB_USER DB_PASSWORD"

# Track overrides for logging
TILT_OVERRIDES_APPLIED=0

apply_tilt_overrides() {
  log_info "🎯 Checking for Tilt IoC overrides..."
  local overrides_applied=0
  
  for var_name in $TILT_OVERRIDE_VARS; do
    tilt_var="TILT_${var_name}"
    tilt_value=$(eval echo \$$tilt_var)
    
    if [ -n "$tilt_value" ]; then
      log_success "   ✓ TILT_${var_name} overrides ${var_name}"
      export "${var_name}=${tilt_value}"
      overrides_applied=$((overrides_applied + 1))
      TILT_OVERRIDES_APPLIED=$overrides_applied
    fi
  done
  
  if [ $overrides_applied -eq 0 ]; then
    log_info "   No Tilt overrides found - using Infisical/defaults"
  else
    log_success "   🎯 Applied ${overrides_applied} Tilt override(s) - Tilt is SSOT!"
  fi
}

# =============================================================================
# DATABASE VIRTUALIZATION FUNCTIONS (BigTech Pattern)
# =============================================================================
# Single PostgreSQL container with logical databases per service
# Saves ~80% RAM on Mac M1/M2 compared to 120 separate containers

wait_for_postgres() {
  local db_host="$1"
  local db_port="$2"
  local db_name="$3"
  local timeout="${DB_WAIT_TIMEOUT}"
  local interval="${DB_WAIT_INTERVAL}"
  local elapsed=0
  
  log_db "🗃️ Waiting for PostgreSQL: ${db_host}:${db_port}/${db_name}"
  log_db "⏱️ Timeout: ${timeout}s, Check interval: ${interval}s"
  
  while [ $elapsed -lt $timeout ]; do
    # TCP check first (port availability)
    if nc -z "${db_host}" "${db_port}" 2>/dev/null; then
      log_db "✓ PostgreSQL port ${db_port} is open"
      
      # If we have psql, do a deeper health check
      if command -v psql >/dev/null 2>&1; then
        if PGPASSWORD="${db_password:-}" psql -h "${db_host}" -p "${db_port}" -U "${db_user:-tdk_project}" -d "${db_name}" -c "SELECT 1" >/dev/null 2>&1; then
          log_success "✅ Database ${db_name} is ready!"
          return 0
        fi
      else
        # No psql available, trust TCP check
        log_success "✅ PostgreSQL is reachable (TCP check passed)"
        return 0
      fi
    fi
    
    log_db "⏳ Waiting... (${elapsed}/${timeout}s)"
    sleep $interval
    elapsed=$((elapsed + interval))
  done
  
  log_warn "⚠️ Database connection timeout after ${timeout}s - proceeding anyway"
  return 1
}

parse_database_url() {
  # Parse DATABASE_URL: postgresql://user:password@host:port/dbname?schema=public
  local url="$1"
  
  # Extract components using sed
  db_user=$(echo "$url" | sed -n 's|.*://\([^:]*\):.*|\1|p')
  db_password=$(echo "$url" | sed -n 's|.*://[^:]*:\([^@]*\)@.*|\1|p')
  db_host=$(echo "$url" | sed -n 's|.*@\([^:]*\):.*|\1|p')
  db_port=$(echo "$url" | sed -n 's|.*:\([0-9]*\)/.*|\1|p')
  db_name=$(echo "$url" | sed -n 's|.*/\([^?]*\).*|\1|p')
  
  # Export for use in other functions
  export DB_USER="${db_user}"
  export DB_PASSWORD="${db_password}"
  export DB_HOST="${db_host}"
  export DB_PORT="${db_port}"
  export DB_NAME="${db_name}"
}

# =============================================================================
# INFISICAL VALIDATION
# =============================================================================

validate_infisical_config() {
  local missing=""
  
  if [ -z "$INFISICAL_CLIENT_ID" ]; then
    missing="${missing}INFISICAL_CLIENT_ID "
  fi
  
  if [ -z "$INFISICAL_CLIENT_SECRET" ]; then
    missing="${missing}INFISICAL_CLIENT_SECRET "
  fi
  
  if [ -z "$INFISICAL_PROJECT_ID" ]; then
    missing="${missing}INFISICAL_PROJECT_ID "
  fi
  
  if [ -n "$missing" ]; then
    log_warn "Missing Infisical config: ${missing}"
    return 1
  fi
  
  return 0
}

# =============================================================================
# DATABASE CONNECTIVITY VALIDATION (Unified for Database Virtualization)
# =============================================================================

validate_database_connectivity() {
  # Extract database info from DATABASE_URL if available
  if [ -n "$DATABASE_URL" ]; then
    parse_database_url "$DATABASE_URL"
    
    log_info "🗃️ Database Virtualization Check:"
    log_info "   Host: ${DB_HOST:-unknown}"
    log_info "   Port: ${DB_PORT:-5432}"
    log_info "   Database: ${DB_NAME:-unknown}"
    log_info "   Service: ${SERVICE_NAME}"
    
    # Wait for PostgreSQL to be ready
    wait_for_postgres "${DB_HOST}" "${DB_PORT:-5432}" "${DB_NAME}"
  else
    log_warn "DATABASE_URL not set - skipping database connectivity check"
  fi
}

# =============================================================================
# 📦 PRISMA AUTO-MIGRATION (Architect Level - Uber Pattern)
# =============================================================================
# 
# Detects Prisma schema and runs migrations DIRECTLY without relying on 
# package.json scripts. This removes human error dependency and ensures
# migrations always run regardless of script configuration.
#
# Benefits:
#   - No dependency on package.json "db:migrate" script existing
#   - Consistent migration behavior across all services
#   - Self-healing: works even if package.json is misconfigured
# =============================================================================

AUTO_MIGRATE="${AUTO_MIGRATE:-true}"

run_prisma_migrations() {
  # Skip if auto-migrate is disabled
  if [ "$AUTO_MIGRATE" = "false" ] || [ "$AUTO_MIGRATE" = "0" ]; then
    log_info "📦 Auto-migration disabled (AUTO_MIGRATE=false)"
    return 0
  fi
  
  # Check for Prisma schema in common locations
  local prisma_schema=""
  if [ -f "./prisma/schema.prisma" ]; then
    prisma_schema="./prisma/schema.prisma"
  elif [ -f "./prisma/schema/schema.prisma" ]; then
    prisma_schema="./prisma/schema/schema.prisma"
  elif [ -f "./schema.prisma" ]; then
    prisma_schema="./schema.prisma"
  fi
  
  if [ -n "$prisma_schema" ]; then
    log_info "📦 Prisma schema found: ${prisma_schema}"
    
    # Auto-resolve failed migrations (P3009) before deploying new ones.
    # In dev/local environments, stale failed records in _prisma_migrations
    # block all subsequent deploys. Resolve them automatically.
    if [ -n "$DATABASE_URL" ]; then
      local deploy_output
      deploy_output=$(bunx prisma migrate deploy 2>&1) || true
      if echo "$deploy_output" | grep -q "P3009"; then
        log_warn "🔧 P3009: Found failed migration(s) — auto-resolving..."
        # Extract migration name(s) from "The `<name>` migration ... failed" lines
        echo "$deploy_output" | sed -n 's/.*The `\([^`]*\)` migration .* failed.*/\1/p' | while IFS= read -r migration_name; do
          log_info "   Rolling back: ${migration_name}"
          bunx prisma migrate resolve --rolled-back "$migration_name" 2>&1 || true
        done
        # Retry deploy after resolving failed migrations
        log_info "📦 Retrying database migrations..."
        if bunx prisma migrate deploy 2>&1; then
          log_success "✅ Database migrations completed successfully (after auto-resolve)"
        else
          log_warn "⚠️ Migration still failed after auto-resolve"
        fi
      elif echo "$deploy_output" | grep -q "applied successfully"; then
        log_success "✅ Database migrations completed successfully"
      else
        # No P3009 and no success — could be "already in sync" or other info
        echo "$deploy_output"
        log_info "📦 Migration deploy completed (check output above)"
      fi
    else
      log_warn "📦 DATABASE_URL not set — skipping migration deploy"
    fi
  else
    log_info "📦 No Prisma schema found - skipping auto-migration"
  fi
}
    
# =============================================================================
# MAIN EXECUTION
# =============================================================================

main() {
  log_info "═══════════════════════════════════════════════════"
  log_info "🚀 Starting service: ${SERVICE_NAME}"
  log_info "🌍 Environment: ${INFISICAL_ENV}"
  log_info "🔐 Secret path: ${INFISICAL_SECRET_PATH}"
  log_info "🗃️ Database Virtualization: ENABLED (BigTech Pattern)"
  log_info "🎯 Tilt IoC: ENABLED (Single Source of Truth)"
  log_info "═══════════════════════════════════════════════════"
  
  # 🎯 CRITICAL: Apply Tilt overrides FIRST (before anything else)
  # This ensures TILT_DATABASE_URL becomes DATABASE_URL BEFORE:
  # 1. validate_database_connectivity() uses it
  # 2. infisical run potentially overwrites it
  apply_tilt_overrides
  
  # Check if Infisical is disabled
  if [ "$INFISICAL_ENABLED" = "false" ] || [ "$INFISICAL_ENABLED" = "0" ]; then
    log_warn "Infisical disabled - using direct environment variables"
    validate_database_connectivity
    run_prisma_migrations
    exec "$@"
  fi
  
  # Check if infisical CLI is available
  if ! command -v infisical >/dev/null 2>&1; then
    log_warn "Infisical CLI not found - using direct environment variables"
    validate_database_connectivity
    run_prisma_migrations
    exec "$@"
  fi
  
  # Validate Infisical configuration
  if ! validate_infisical_config; then
    log_warn "Infisical not configured - falling back to environment variables"
    validate_database_connectivity
    run_prisma_migrations
    exec "$@"
  fi
  
  log_success "Infisical configured ✓"
  
  # Authenticate with Machine Identity (Universal Auth)
  # This is NON-INTERACTIVE - uses client ID/secret from env vars
  log_info "Authenticating with Machine Identity..."
  
  if ! infisical login --method=universal-auth \
    --client-id="$INFISICAL_CLIENT_ID" \
    --client-secret="$INFISICAL_CLIENT_SECRET" \
    --domain="$INFISICAL_SITE_URL" \
    --silent 2>/dev/null; then
    log_warn "Machine Identity auth failed - falling back to environment variables"
    validate_database_connectivity
    run_prisma_migrations
    exec "$@"
  fi
  
  log_success "Authenticated ✓"
  
  # Validate database connectivity BEFORE starting the app
  # This ensures the shared PostgreSQL is ready (Database Virtualization pattern)
  validate_database_connectivity
  
  # 📦 PRISMA AUTO-MIGRATION with Infisical context
  # Run migrations INSIDE infisical run so DATABASE_URL from secrets is available
  # Includes P3009 auto-resolve: marks stale failed migrations as rolled-back
  log_info "📦 Running Prisma migrations with Infisical secrets..."
  infisical run \
    --domain="$INFISICAL_SITE_URL" \
    --projectId="$INFISICAL_PROJECT_ID" \
    --env="$INFISICAL_ENV" \
    --path="$INFISICAL_SECRET_PATH" \
    --expand=false \
    --silent \
    -- sh -c '
      if [ -f "./prisma/schema.prisma" ] || [ -f "./prisma/schema/schema.prisma" ]; then
        output=$(bunx prisma migrate deploy 2>&1) || true
        if echo "$output" | grep -q "P3009"; then
          echo "[ENTRYPOINT] 🔧 P3009: Auto-resolving failed migration(s)..."
          echo "$output" | sed -n "s/.*The \`\([^\`]*\)\` migration .* failed.*/\1/p" | while IFS= read -r mig; do
            echo "[ENTRYPOINT]    Rolling back: $mig"
            bunx prisma migrate resolve --rolled-back "$mig" 2>&1 || true
          done
          echo "[ENTRYPOINT] 📦 Retrying migrations..."
          bunx prisma migrate deploy 2>&1 || echo "[ENTRYPOINT] ⚠️ Migration still failed after auto-resolve"
        else
          echo "$output"
        fi
      fi
    ' || true
  
  # Execute with Infisical secret injection
  # 🎯 CRITICAL FIX: Instead of using `infisical run` (which always overwrites existing env vars),
  # we fetch secrets and only export vars that aren't already set. This preserves TILT_* overrides.
  # Precedence: TILT_* > Infisical > Defaults
  
  log_info "Fetching secrets from Infisical..."
  
  # Fetch secrets in plain format (KEY=VALUE per line)
  # Use a temporary file to capture output safely
  temp_secrets=$(mktemp)
  trap "rm -f $temp_secrets" EXIT
  
  infisical secrets \
    --domain="$INFISICAL_SITE_URL" \
    --projectId="$INFISICAL_PROJECT_ID" \
    --env="$INFISICAL_ENV" \
    --path="$INFISICAL_SECRET_PATH" \
    --expand=false \
    --plain \
    --silent > "$temp_secrets" 2>/dev/null || true

  # Only export secrets that aren't already set in the environment
  # This preserves TILT_DATABASE_URL -> DATABASE_URL override
  secrets_exported=0
  if [ -s "$temp_secrets" ]; then
    while IFS= read -r line; do
      # Skip empty lines
      [ -z "$line" ] && continue
      
      # Split on first = only (in case value contains =)
      key="${line%%=*}"
      value="${line#*=}"
      
      # Only export if not already set in environment
      eval "current_val=\$$key"
      if [ -z "$current_val" ]; then
        export "${key}=${value}"
        secrets_exported=$((secrets_exported + 1))
      fi
    done < "$temp_secrets"
  fi
  
  log_success "Injected ${secrets_exported} secret(s) from Infisical (preserving ${TILT_OVERRIDES_APPLIED} TILT override(s))"
  log_info "🎯 Final DATABASE_URL: ${DATABASE_URL:-not-set}"
  log_success "🎉 Service ${SERVICE_NAME} starting with Database Virtualization!"
  
  exec "$@"
}

# Handle the case where no command is provided
if [ $# -eq 0 ]; then
  log_error "No command provided"
  log_info "Usage: /entrypoint.sh <command> [args...]"
  log_info "Example: /entrypoint.sh bun run src/index.ts"
  exit 1
fi

main "$@"
