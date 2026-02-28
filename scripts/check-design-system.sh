#!/usr/bin/env bash
# M30.5: Design System Compliance Check
# Checks for banned CSS patterns in SPA component files.
# Run this in CI to prevent design system violations from merging.
#
# Usage: ./scripts/check-design-system.sh
# Exit code: 0 = pass, 1 = violations found

set -euo pipefail

SPA_SRC="packages/spa/src"
VIOLATIONS=0

echo "=== Design System Compliance Check ==="
echo ""

# 1. Check for backdrop-blur (banned everywhere)
echo "Checking for backdrop-blur..."
if grep -rn "backdrop-blur" "$SPA_SRC" 2>/dev/null; then
  echo "  ❌ VIOLATION: backdrop-blur found (banned by design system)"
  VIOLATIONS=$((VIOLATIONS + 1))
else
  echo "  ✅ No backdrop-blur found"
fi

echo ""

# 2. Check for bg-background/80 (glassmorphism opacity pattern)
echo "Checking for glassmorphism opacity patterns..."
if grep -rn "bg-background/[0-9]" "$SPA_SRC" 2>/dev/null; then
  echo "  ❌ VIOLATION: bg-background opacity found (glassmorphism)"
  VIOLATIONS=$((VIOLATIONS + 1))
else
  echo "  ✅ No glassmorphism opacity patterns found"
fi

echo ""

# 3. Check for shadow-lg outside of dialog/alert-dialog content panels
echo "Checking for shadow-lg..."
SHADOW_LG_HITS=$(grep -rn "shadow-lg" "$SPA_SRC" 2>/dev/null || true)
if [ -n "$SHADOW_LG_HITS" ]; then
  # Filter out allowed locations: dialog.tsx and alert-dialog.tsx (content panels use shadow-lg per design system)
  VIOLATIONS_FOUND=$(echo "$SHADOW_LG_HITS" | grep -v "/ui/dialog.tsx:" | grep -v "/ui/alert-dialog.tsx:" || true)
  if [ -n "$VIOLATIONS_FOUND" ]; then
    echo "$VIOLATIONS_FOUND"
    echo "  ❌ VIOLATION: shadow-lg found outside dialog content panels"
    VIOLATIONS=$((VIOLATIONS + 1))
  else
    echo "  ✅ shadow-lg only in allowed locations (dialog content panels)"
  fi
else
  echo "  ✅ No shadow-lg found"
fi

echo ""

# 4. Check for gradient backgrounds (banned)
echo "Checking for gradient backgrounds..."
if grep -rn "bg-gradient\|from-.*to-.*gradient" "$SPA_SRC" 2>/dev/null; then
  echo "  ❌ VIOLATION: Gradient backgrounds found (banned by design system)"
  VIOLATIONS=$((VIOLATIONS + 1))
else
  echo "  ✅ No gradient backgrounds found"
fi

echo ""

# 5. Check for rounded-lg (should be rounded-md per design system)
echo "Checking for rounded-lg (should be rounded-md)..."
if grep -rn "rounded-lg" "$SPA_SRC" 2>/dev/null; then
  echo "  ⚠️  WARNING: rounded-lg found (design system specifies rounded-md)"
  # Warning only — not blocking
else
  echo "  ✅ No rounded-lg found"
fi

echo ""
echo "=== Results ==="
if [ "$VIOLATIONS" -gt 0 ]; then
  echo "❌ $VIOLATIONS violation(s) found. Fix before merging."
  exit 1
else
  echo "✅ All design system checks passed."
  exit 0
fi
