#!/bin/sh
set -e

# Fix Bun hoisted package symlinks that can break when copied across Docker stages.
for pkg in node_modules/.bun/*/node_modules/*; do
  [ -d "$pkg" ] || continue
  name=$(basename "$pkg")
  case "$name" in
    @*) continue ;;
  esac
  ln -sfn "$(pwd)/$pkg" "node_modules/$name"
done

for pkg in node_modules/.bun/*/node_modules/@*/*; do
  [ -d "$pkg" ] || continue
  scope=$(basename "$(dirname "$pkg")")
  name=$(basename "$pkg")
  if [ "$scope" = "@prisma" ] && [ "$name" = "engines" ]; then
    continue
  fi
  mkdir -p "node_modules/$scope"
  ln -sfn "$(pwd)/$pkg" "node_modules/$scope/$name"
done
