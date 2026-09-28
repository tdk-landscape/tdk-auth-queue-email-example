#!/bin/sh
set -e

# Fix Bun module resolution: .prisma/client must be reachable from .bun linker paths.
for dir in node_modules/.bun/@prisma+client*/node_modules; do
  [ -d "$dir" ] && ln -sf "$(pwd)/node_modules/.prisma" "$dir/.prisma" || true
done

# Also fix malformed @prisma/client package.json in Bun cache if present.
for pkg in node_modules/.bun/@prisma+client*/node_modules/@prisma/client/package.json; do
  [ -f "$pkg" ] && echo '{"name":"@prisma/client","main":"index.js","types":"index.d.ts"}' > "$pkg" || true
done
