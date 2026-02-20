#!/usr/bin/env bash

# ============================================================
# check-banned-tailwind.sh
# ============================================================
# Enforces design system consistency by detecting banned
# Tailwind CSS class patterns in the SPA.
#
# Banned patterns:
# - Arbitrary color values (use design tokens)
# - Arbitrary pixel font sizes (use typography scale)
# - Important overrides (!prefix)
# - Arbitrary spacing values (use standard scale)
#
# Exit codes:
#   0 = Clean (no violations)
#   1 = Violations found
# ============================================================

set -euo pipefail

# Colors for output
RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
NC='\033[0m' # No Color

SPA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$SPA_DIR"

echo "🔍 Checking for banned Tailwind CSS classes..."
echo "   Enforcing design system consistency"
echo ""

VIOLATIONS=0

# ============================================================
# Pattern 1: Arbitrary color values
# ============================================================

echo "📋 Checking for arbitrary color values (should use design tokens)..."

for pattern in 'bg-\[#[0-9a-fA-F]+\]' 'text-\[#[0-9a-fA-F]+\]' 'border-\[#[0-9a-fA-F]+\]' 'fill-\[#[0-9a-fA-F]+\]' 'stroke-\[#[0-9a-fA-F]+\]'; do
  matches=$(grep -rn --include="*.tsx" --include="*.ts" --include="*.jsx" --include="*.js" -E "$pattern" src/ 2>/dev/null || true)
  
  if [[ -n "$matches" ]]; then
    echo -e "${RED}❌ Found arbitrary color values:${NC}"
    echo "$matches"
    echo ""
    ((VIOLATIONS++))
  fi
done

# ============================================================
# Pattern 2: Arbitrary pixel font sizes  
# ============================================================

echo "📋 Checking for arbitrary pixel font sizes (use typography scale)..."

pattern='text-\[[0-9]+px\]'
matches=$(grep -rn --include="*.tsx" --include="*.ts" --include="*.jsx" --include="*.js" -E "$pattern" src/ 2>/dev/null || true)

if [[ -n "$matches" ]]; then
  echo -e "${RED}❌ Found arbitrary pixel font sizes:${NC}"
  echo "$matches"
  echo ""
  ((VIOLATIONS++))
fi

# ============================================================
# Pattern 3: Important overrides (!prefix)
# ============================================================

echo "📋 Checking for !important overrides..."

for pattern in '\!bg-' '\!text-' '\!p-' '\!m-' '\!border-' '\!w-' '\!h-'; do
  matches=$(grep -rn --include="*.tsx" --include="*.ts" --include="*.jsx" --include="*.js" -E "$pattern" src/ 2>/dev/null || true)
  
  if [[ -n "$matches" ]]; then
    echo -e "${RED}❌ Found !important overrides:${NC}"
    echo "$matches"
    echo ""
    ((VIOLATIONS++))
  fi
done

# ============================================================
# Pattern 4: Arbitrary spacing with px/rem units
# ============================================================

echo "📋 Checking for arbitrary spacing values (use standard scale)..."

for pattern in 'p-\[[0-9]+(px|rem)\]' 'm-\[[0-9]+(px|rem)\]' 'px-\[[0-9]+(px|rem)\]' 'py-\[[0-9]+(px|rem)\]' 'gap-\[[0-9]+(px|rem)\]'; do
  matches=$(grep -rn --include="*.tsx" --include="*.ts" --include="*.jsx" --include="*.js" -E "$pattern" src/ 2>/dev/null || true)
  
  if [[ -n "$matches" ]]; then
    echo -e "${RED}❌ Found arbitrary spacing values:${NC}"
    echo "$matches"
    echo ""
    ((VIOLATIONS++))
  fi
done

# ============================================================
# Pattern 5: Arbitrary width/height with px
# ============================================================

echo "📋 Checking for arbitrary width/height with px (consider using rem or design tokens)..."

for pattern in 'w-\[[0-9]+px\]' 'h-\[[0-9]+px\]' 'min-w-\[[0-9]+px\]' 'min-h-\[[0-9]+px\]' 'max-w-\[[0-9]+px\]' 'max-h-\[[0-9]+px\]'; do
  matches=$(grep -rn --include="*.tsx" --include="*.ts" --include="*.jsx" --include="*.js" -E "$pattern" src/ 2>/dev/null || true)
  
  if [[ -n "$matches" ]]; then
    echo -e "${YELLOW}⚠️  Found arbitrary width/height with px:${NC}"
    echo "$matches"
    echo ""
    # Note: These are warnings, not hard violations
  fi
done

# ============================================================
# Summary
# ============================================================

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [[ $VIOLATIONS -eq 0 ]]; then
  echo -e "${GREEN}✅ No banned Tailwind classes found!${NC}"
  echo ""
  exit 0
else
  echo -e "${RED}❌ Found $VIOLATIONS violation category(s)${NC}"
  echo ""
  echo "Design system guidance:"
  echo "  • Use color tokens: bg-primary, text-muted, border-input, etc."
  echo "  • Use typography scale: text-sm, text-base, text-lg, etc."
  echo "  • Use spacing scale: p-2, m-4, gap-6, etc."
  echo "  • Avoid !important; fix specificity instead"
  echo ""
  echo "See: packages/spa/src/index.css for design tokens"
  echo ""
  exit 1
fi
