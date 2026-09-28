#!/bin/sh
set -e

# =============================================================================
# CRITICAL FIX: Bun concurrency and DNS settings for Docker/Colima
# These prevent "Resolving dependencies" hang
# =============================================================================
export BUN_INSTALL_CONCURRENCY=4          # Default is 16+, reduce for Docker
export UV_THREADPOOL_SIZE=4               # Limit threads (default is 128)
export BUN_NETWORK_TIMEOUT=30000          # 30s timeout per request
export BUN_RESOLVE_TIMEOUT=60000          # 60s for resolution phase

# DNS fixes for Colima/Docker
export NODE_OPTIONS="--dns-result-order=ipv4first"

start_ts=$(date +%s)
echo "⏱️ install-deps start: $(date '+%Y-%m-%d %H:%M:%S %z')"
echo "🔧 Bun concurrency: $BUN_INSTALL_CONCURRENCY, Threadpool: $UV_THREADPOOL_SIZE"

finish_install_timer() {
  end_ts=$(date +%s)
  echo "install-deps duration: $((end_ts-start_ts))s"
}
trap 'finish_install_timer' EXIT INT TERM

export NODE_ENV=development

# Use persistent cache directory (Docker layer, not mount)
export BUN_INSTALL_CACHE_DIR=/cache/bun
mkdir -p $BUN_INSTALL_CACHE_DIR

# =============================================================================
# Check Verdaccio registry (premium feature — only required when VERDACCIO_LICENSE_KEY is set)
# Without a license key, skip Verdaccio and fall back to public npm registry.
# =============================================================================
if [ -z "${TDK_LICENSE_KEY:-}" ]; then
  echo "ℹ️  TDK_LICENSE_KEY not set — skipping private registry (public npm only)"
  VERDACCIO_URL=""
else
  VERDACCIO_URL="http://localhost:4873"
  echo "🔍 Checking Verdaccio registry at $VERDACCIO_URL..."
  if ! wget -q --spider --timeout=3 "$VERDACCIO_URL" 2>/dev/null; then
    VERDACCIO_URL="http://host.docker.internal:4873"
    echo "   localhost unreachable, trying $VERDACCIO_URL..."
    if ! wget -q --spider --timeout=3 "$VERDACCIO_URL" 2>/dev/null; then
      echo "❌ Verdaccio not reachable at localhost:4873 or host.docker.internal:4873. Build will fail."
      echo "   Ensure Verdaccio is running: docker ps | grep verdaccio"
      exit 1
    fi
  fi
  echo "✅ Verdaccio available at $VERDACCIO_URL"
fi

# =============================================================================
# CRITICAL FIX: Reduced timeout for faster failure detection (was 900s)
# Using 60s to fail fast and retry, rather than hanging for 15 minutes
# =============================================================================
# CRITICAL FIX: Extended timeout for full dependency resolution
# 60s was too short - packages resolve but need time for transitive deps
INSTALL_TIMEOUT_SECONDS="${BUN_INSTALL_TIMEOUT_SECONDS:-300}"
echo "📦 Dependency install timeout: ${INSTALL_TIMEOUT_SECONDS}s (Verdaccio packages available)"

INSTALL_DEPS_VERBOSE="${INSTALL_DEPS_VERBOSE:-0}"
if [ "$INSTALL_DEPS_VERBOSE" = "1" ]; then
  echo "🚀 Installing dependencies (verbose)..."
  BUN_VERBOSE_FLAG="--verbose"
  FAIL_TAIL_LINES=200
else
  echo "📦 Installing dependencies..."
  BUN_VERBOSE_FLAG=""
  FAIL_TAIL_LINES=50
fi

BUN_INSTALL_LOG=/tmp/bun-install.log

# Start tail in background for live logging
touch "$BUN_INSTALL_LOG"
tail -n 20 -f "$BUN_INSTALL_LOG" 2>/dev/null &
TAIL_PID=$!
cleanup_tail() {
  kill "$TAIL_PID" 2>/dev/null || true
}
trap 'cleanup_tail; finish_install_timer' EXIT INT TERM

# =============================================================================
# Cache configuration: Use persistent Docker layer path
# =============================================================================
# Uses /cache/bun (persistent Docker layer path, not a mount).
# This avoids the "FileNotFound when create temporary directory" bug
# that occurs with Docker --mount=type=cache, while still persisting
# cache across rebuilds via Docker layer caching.
echo "🔧 Using /cache/bun for Bun cache (persistent Docker layer)..."
export BUN_CACHE_DIR="/cache/bun"
mkdir -p "$BUN_CACHE_DIR"
BUN_CACHE_FLAG="--cache-dir=/cache/bun"
echo "📁 Cache location: /cache/bun"

# =============================================================================
# Install function with timeout and logging
# Uses constrained concurrency to prevent "Resolving dependencies" hang
# =============================================================================
run_install() {
  local args="$1"
  local attempt="$2"

  echo "📌 Attempt $attempt: bun install $args (concurrency: $BUN_INSTALL_CONCURRENCY)"
  set +e
  # Use timeout with explicit concurrency limit
  timeout "$INSTALL_TIMEOUT_SECONDS" \
    bun install $args \
    --concurrent-tasks "$BUN_INSTALL_CONCURRENCY" \
    --concurrent-scripts "$BUN_INSTALL_CONCURRENCY" \
    $BUN_CACHE_FLAG $BUN_VERBOSE_FLAG >"$BUN_INSTALL_LOG" 2>&1
  local code=$?
  set -e
  return $code
}

# =============================================================================
# Install with lockfile but allow updates within resolved ranges
# =============================================================================
ATTEMPT=1
INSTALL_CODE=0

run_install "--force" $ATTEMPT
INSTALL_CODE=$?
ATTEMPT=$((ATTEMPT + 1))

cleanup_tail

# =============================================================================
# Final status check
# =============================================================================
if [ "$INSTALL_CODE" -ne 0 ]; then
  echo "❌ Dependency installation failed after $((ATTEMPT - 1)) attempts (exit $INSTALL_CODE). Last ${FAIL_TAIL_LINES} lines:"
  tail -n "$FAIL_TAIL_LINES" "$BUN_INSTALL_LOG"
  exit 1
fi

if [ ! -d "node_modules" ] || [ -z "$(ls -A node_modules 2>/dev/null)" ]; then
  echo "❌ Dependency installation produced empty node_modules. Last ${FAIL_TAIL_LINES} lines:"
  tail -n "$FAIL_TAIL_LINES" "$BUN_INSTALL_LOG"
  exit 1
fi

echo "✅ Dependency installation complete"
if [ "$INSTALL_DEPS_VERBOSE" = "1" ]; then
  echo "📊 Total packages: $(ls node_modules 2>/dev/null | wc -l)"
  du -sh node_modules 2>/dev/null || true
fi

# No cache cleanup needed (--no-cache flag used)
