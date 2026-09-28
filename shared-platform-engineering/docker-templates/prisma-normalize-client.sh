#!/bin/sh
set -e

PRISMA_EXPORT_GENERATED_CLIENT="${PRISMA_EXPORT_GENERATED_CLIENT:-1}"
PRISMA_DOT_DIR="node_modules/.prisma"
PRISMA_DOT_CLIENT="node_modules/.prisma/client"

# Normalize Prisma output for both import styles: ../generated-client and node_modules/.prisma/client
if [ ! -d "$PRISMA_DOT_CLIENT" ] && [ -d /app/node_modules/.prisma/client ]; then
  mkdir -p "$PRISMA_DOT_DIR"
  cp -R /app/node_modules/.prisma/client "$PRISMA_DOT_CLIENT"
fi

if [ "$PRISMA_EXPORT_GENERATED_CLIENT" = "1" ] && [ -d "$PRISMA_DOT_CLIENT" ] && [ ! -d generated-client ] && [ ! -f generated-client.ts ]; then
  printf "export * from './node_modules/.prisma/client/client';\n" > generated-client.ts
fi

mkdir -p "$PRISMA_DOT_CLIENT"
if [ -d generated-client ] && [ -z "$(ls -A "$PRISMA_DOT_CLIENT" 2>/dev/null)" ]; then
  cp -r generated-client/. "$PRISMA_DOT_CLIENT/"
fi

# Prisma v7 prisma-client may emit TS-only artifacts; add declaration/js entrypoints
if [ -f "$PRISMA_DOT_CLIENT/client.ts" ] && [ ! -f "$PRISMA_DOT_CLIENT/index.d.ts" ]; then
  printf "export * from './client';\n" > "$PRISMA_DOT_CLIENT/index.d.ts"
fi
if [ -f "$PRISMA_DOT_CLIENT/client.ts" ] && [ ! -f "$PRISMA_DOT_CLIENT/default.d.ts" ]; then
  printf "export * from './client';\n" > "$PRISMA_DOT_CLIENT/default.d.ts"
fi
if [ -f "$PRISMA_DOT_CLIENT/client.ts" ] && [ ! -f "$PRISMA_DOT_CLIENT/index.js" ]; then
  printf "export * from './client.js';\n" > "$PRISMA_DOT_CLIENT/index.js"
fi

# Prisma v7 may generate malformed package.json under Bun
if [ -f "$PRISMA_DOT_CLIENT/client.ts" ]; then
  echo '{"name":"prisma-client-generated","types":"index.d.ts","main":"index.js"}' > "$PRISMA_DOT_CLIENT/package.json"
fi

# Prisma v7: @prisma/client/default.js requires .prisma/client/default
if [ -d "$PRISMA_DOT_CLIENT" ] && [ ! -f "$PRISMA_DOT_CLIENT/default.js" ]; then
  printf "module.exports = require('./client.js');\n" > "$PRISMA_DOT_CLIENT/default.js"
fi

# Ensure @prisma/client package can resolve '.prisma/client/*' under Bun hoisting
if [ -d "$PRISMA_DOT_DIR" ]; then
  for pkg in node_modules/@prisma/client node_modules/.bun/@prisma+client*/node_modules/@prisma/client; do
    [ -d "$pkg" ] && ln -sfn "$(pwd)/$PRISMA_DOT_DIR" "$pkg/.prisma" || true
  done
fi

# Also fix corrupted package.json in .bun cache
for pkg in node_modules/.bun/@prisma+client*/node_modules/@prisma/client/package.json; do
  [ -f "$pkg" ] && echo '{"name":"@prisma/client","main":"index.js","types":"index.d.ts"}' > "$pkg" || true
done

test -f "$PRISMA_DOT_CLIENT/client.ts" -o -f "$PRISMA_DOT_CLIENT/index.d.ts" || true
