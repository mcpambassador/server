
---

## February 20, 2026 — Phase 3 Catalyst Migration: Form Components

### What We Learned

1. **Catalyst form components are simpler but require pattern changes.** Checkbox requires wrapping in CheckboxField for proper label association (replaces id/htmlFor pairing). Select is a styled native HTML select (not a custom dropdown), which simplifies code but has a different visual. These aren't better or worse, just different — migrating means accepting those differences.

2. **Headless UI uses standard onChange for booleans.** ShadCN's `onCheckedChange={(checked) => handler(checked as boolean)}` requires casting because it uses Radix primitives. Catalyst's Checkbox is based on Headless UI Switch, which passes boolean directly to `onChange`. This reduces type ceremony: `onChange={(checked) => handler(checked)}` just works.

3. **CheckboxField removes id/htmlFor ceremony.** The old pattern (`<Checkbox id="field" />` + `<Label htmlFor="field">`) required manual ID management. Catalyst's `<CheckboxField>` component handles association automatically through React context, like Headless UI's Field groups. This is cleaner but requires wrapping every checkbox-label pair.

4. **Native selects are simpler but less flexible.** ShadCN's Select was a custom dropdown with SelectTrigger/SelectContent/SelectItem/SelectValue — full control over appearance but verbose. Catalyst's Select is a styled `<select>` with plain `<option>` children — less code, but limited customization (can't add icons, descriptions). For typical form fields, the simplicity wins.

5. **Textarea is nearly drop-in between ShadCN and Catalyst.** Both are forwardRef components wrapping native `<textarea>`. The only differences: Catalyst adds a `resizable` prop (default true) and wraps in a span with focus ring styling. Migration is just changing the import path — no API changes needed.

6. **Batch replacements are efficient for consistent patterns.** Using `multi_replace_string_in_file` to handle 6 files simultaneously (3 replacements per file) was faster and less error-prone than sequential edits. The key is ensuring each pattern is truly consistent across files before batching.

7. **Verification is cheap insurance.** Running `grep -rn "from '@/components/ui/checkbox\|from '@/components/ui/select\|from '@/components/ui/textarea'"` after migration takes 2 seconds and provides 100% confidence that no old imports remain. Always verify zero results before committing.

### Recommendation

When migrating form components between UI libraries, expect API differences even for "similar" components. CheckboxField, native Select, and slight Textarea differences are all examples where Catalyst chose different patterns than ShadCN. Accept those differences rather than fighting them — the new library's patterns exist for reasons (usually simplicity or accessibility).


## Phase 4: Gap Components & Toast Migration (2026-02-20)

### Bulk String Replacement Strategy
**Lesson:** For simple import path changes, sed/find is extremely efficient for bulk operations.
- Updated 35+ files in seconds with single command
- Pattern: `sed -i "s|old|new|g"` across multiple files
- **Benefit:** Avoided 35 individual file read/write operations

### Regular Expression Limitations
**Issue:** Python regex couldn't handle all toast call patterns due to parameter ordering variations.
- `addToast({ variant, title, description })` vs. `{ title, description, variant }`
- Required manual fix for GlobalErrorHandler
**Solution:** Combine automated regex for common patterns + manual review for edge cases.

### Component Naming Strategy
**Lesson:** Explicit naming prevents confusion when similar concepts exist.
- Created `InlineAlert` (banners) vs. `Alert` (dialog) to avoid name collision
- Clear distinction prevents developer confusion
- **Pattern:** If two components serve different UX patterns, give them distinct names even if semantically related

### API Compatibility Design
**Success:** Matching ShadCN APIs exactly enabled true drop-in replacement.
- Card, Skeleton: Zero JSX changes required in 35 files
- Only import paths needed updating
- **Pattern:** When building custom components to replace existing ones, match the API signature exactly unless you have strong reason to change

### Headless UI Tabs Pattern
**Lesson:** Different libraries have fundamentally different APIs — understand before migrating.
- Radix → string-based value matching
- Headless UI → positional index matching
- Required structural JSX changes (`TabsPanels` wrapper)
- **Takeaway:** Not all component migrations are just import swaps; budget time for API translation

### Toast Migration Success
**Pattern:** Converting from hook-based to function-based API was clean:
```tsx
// Hook pattern (Radix/ShadCN)
const { addToast } = useToast();
addToast({ title, description, variant });

// Function pattern (Sonner)
import { toast } from 'sonner';
toast.error(title, { description });
```
- Function imports are simpler than hook patterns
- No React lifecycle concerns
- Easier to test

### Verification Strategy
**Success:** Multiple verification layers caught all edge cases:
1. Grep for remaining old imports → found 0
2. Grep for remaining old hooks → found 1 (the Mcps.tsx edge case)
3. Build check → validates TypeScript correctness
4. Visual inspection of git diff
**Takeaway:** Automated checks + build + manual review = confidence

### Git Commit Granularity
**Pattern:** Committed entire phase as single logical unit:
- 4 new components
- 50 file updates
- Toast system replacement
**Benefit:** Single revert point if issues arise; single PR for review; clear atomic feature boundary.

---

## February 20, 2026 — Catalyst Migration Phase 6: Cleanup & Artifact Removal

### Context
Final phase of the Catalyst UI migration. After all components and pages were migrated in Phases 1-5, Phase 6 removed all ShadCN/Radix artifacts: deleted 19 component files, removed 13 dependencies, simplified utilities, and cleaned up CSS tokens.

### What We Learned

#### 1. Verify Before Delete
**Pattern:** Triple-check for external references before deleting source directories.
- Used `grep -rn "from '@/components/ui/'" --include="*.tsx" --include="*.ts" | grep -v 'src/components/ui/'`
- Returned empty result → safe to delete
**Benefit:** Zero breakage. Build succeeded on first attempt after deletion.
**Lesson:** The time spent verifying (2 minutes) prevented hours of debugging broken imports.

#### 2. Dependency Removal is Satisfying but Requires Lock File Regeneration
**Process:**
- `pnpm remove` 13 packages in single command
- All packages removed successfully
- `pnpm-lock.yaml` automatically updated
**Result:** Dependencies: 25 → 12 (52% reduction)
**Lesson:** Batch dependency removals when possible. Single pnpm transaction is faster and cleaner than 13 individual removals.

#### 3. CSS Token Cleanup Requires Usage Audit
**Issue:** index.css had ~130 ShadCN HSL custom properties. Couldn't blindly delete without verifying usage.
**Process:**
1. Grepped for `var(--color-*` and `var(--radius)` outside index.css
2. Found references in:
   - `components/ui/badge.tsx` (semantic colors: success, warning, info)
   - `components/catalyst/button.tsx` (but these were Tailwind tokens, not ShadCN)
3. Since we're deleting `components/ui/`, all ShadCN token references would be gone
**Result:** Safe to remove all 130 tokens. Replaced with minimal 55-line Tailwind v4 setup.
**Lesson:** CSS token cleanup is a two-step process: (1) verify usage, (2) delete unused. Don't skip step 1.

#### 4. Tailwind v4 Doesn't Need Custom HSL Tokens
**Discovery:** Catalyst components use Tailwind's native color system (`zinc-*`, `indigo-*`, `red-*`) with CSS variables like `--color-zinc-500`. These are automatically provided by Tailwind v4.
**Before:** 130 custom HSL tokens in @theme block (178 lines of CSS)
**After:** Zero custom tokens, just base layer styles (55 lines of CSS)
**Result:** 69% CSS reduction, simpler dark mode (just `dark:` modifier), no token maintenance burden
**Lesson:** Modern CSS frameworks provide enough primitives. Custom tokens are tech debt unless you have a true design system requirement.

#### 5. cn() Utility Can Be Simplified When tailwind-merge is Removed
**Context:** ShadCN's `cn()` uses `twMerge(clsx(inputs))` to handle conflicting Tailwind classes.
**Issue:** After removing tailwind-merge dependency, `cn()` broke.
**Fix:** Simplified to `clsx(inputs)` only.
**Risk Assessment:** tailwind-merge prevented class conflicts like `bg-red-500 bg-blue-500` → keeps only `bg-blue-500`. Without it, both classes apply (last one wins via CSS specificity, not guaranteed order).
**Mitigation:** Catalyst components don't dynamically merge conflicting classes. Their APIs use variants, not className overrides.
**Result:** Zero issues in build. Simpler utility, one less dependency.
**Lesson:** Utility libraries exist to solve specific problems. When the problem is removed (conflicting class merging), remove the utility.

#### 6. Always Build After Major Deletions
**Process:**
- Deleted 19 files
- Removed 13 dependencies
- Modified 3 files (utils.ts, index.css, package.json)
- Ran `pnpm run -C packages/spa build`
**Result:** ✅ SUCCESS (2.35s, zero errors)
**Benefit:** Immediate confidence that nothing broke. No hidden import references. No missing types.
**Lesson:** Build validation is non-negotiable after deletions. TypeScript will catch 99% of issues before runtime.

#### 7. Git Commit Granularity for Cleanup Phases
**Pattern:** Single atomic commit for entire cleanup phase.
- 23 files changed: 19 deleted, 3 modified, 1 lockfile updated
- -2,525 lines deleted, +185 added (net -2,340)
**Benefit:** 
- Clear revert point if issues arise
- Single PR for review
- Audit trail: "Phase 6 complete" → one commit hash
**Alternative Considered:** Separate commits for (1) delete components, (2) remove deps, (3) CSS cleanup.
**Rejected Because:** All three changes are interdependent. Deleting components REQUIRES removing deps. Removing deps REQUIRES updating lockfile. CSS tokens are only safe to remove AFTER components are deleted. Splitting would create broken intermediate states.
**Lesson:** Cleanup phases should be single atomic commits. Migration phases (Phases 2-4) benefit from multiple commits per component, but cleanup is all-or-nothing.

### Metrics That Matter

| Metric | Value | Why It Matters |
|---|---|---|
| **Files deleted** | 19 | Zero remaining ShadCN components |
| **Dependencies removed** | 13 | Reduced bundle size, fewer supply chain risks |
| **Dependency count** | 25 → 12 | 52% reduction in runtime dependencies |
| **CSS lines** | 178 → 55 | 69% reduction, simpler mental model |
| **Code deleted** | -2,525 lines | Less code = less maintenance burden |
| **Build time** | 2.35s | Unchanged (removal didn't slow build) |
| **TypeScript errors** | 0 | Clean migration, no regressions |

### Acceptance Criteria as Regression Prevention

**Phase 6 AC List:**
- [ ] components/ui/ directory deleted (0 files)
- [ ] All 13 Radix/ShadCN packages removed from package.json
- [ ] cn() simplified to clsx() (no tailwind-merge)
- [ ] CSS tokens cleaned (no ShadCN HSL tokens)
- [ ] pnpm run build succeeds
- [ ] Zero imports from @/components/ui/ anywhere
- [ ] Git commit on feat/catalyst-migration

**Usage Pattern:**
1. Execute task steps
2. Check each AC box
3. If any AC fails, stop and fix before proceeding
4. All boxes checked → commit and move to next phase

**Benefit:** AC list served as both validation checklist and regression test spec. Each item is verifiable via grep, build, or file listing.

**Lesson:** Write acceptance criteria BEFORE starting work. Use them as a to-do list during execution. If you can't verify an AC, it's too vague.

### Recommendations

1. **Always verify before deleting** — 2 minutes of grep saves hours of debugging
2. **Batch dependency removals** — single pnpm transaction is cleaner
3. **Audit CSS token usage before cleanup** — don't blindly delete custom properties
4. **Build after every major deletion** — TypeScript catches 99% of issues
5. **Use AC lists as regression tests** — each item should be verifiable via command or inspection
6. **Commit cleanup phases atomically** — interdependent changes should be single commits

### Migration Complete

**Total effort:** 6 phases over 2 days (~12 hours)  
**Total commits:** 7 commits on feat/catalyst-migration  
**Net change:** -2,525 lines, -13 dependencies, -19 component files  
**Result:** Modern UI foundation (Catalyst + Tailwind v4), zero ShadCN/Radix debt  
**Status:** Ready for code review and merge to main

---

## Admin MCPs Page Rebuild — February 20, 2026

**File:** `packages/spa/src/pages/admin/Mcps.tsx`  
**Pattern:** Tables with inline filtering, multi-action rows, and conditional buttons

### Key Patterns Applied

1. **Inline native selects for filters** — Used styled native `<select>` with Catalyst selectmenu pattern (rounded-lg, border-none, ring-1 ring-zinc-950/10, focus:ring-2). Simpler than custom dropdown components and provides built-in accessibility.

2. **Conditional action button rendering** — Each table row shows different actions based on MCP status and validation state:
   - View (always)
   - Validate (always)
   - Publish (only if draft + valid)
   - Archive (only if published)
   - Delete (only if draft)
   
   This pattern scales well — each condition is explicit and self-documenting.

3. **Monospace code display for identifiers** — Internal names shown as `<code className="rounded bg-zinc-100 px-1.5 py-0.5 text-sm font-mono text-zinc-900">` for visual distinction from display names.

4. **Multi-badge status columns** — Two badge columns (Status, Validation) with different color schemes. Status uses zinc/green, Validation uses green/red/zinc. Clear visual hierarchy.

5. **Loading state with animate-pulse** — 5 skeleton rows during fetch, each cell with appropriate width mockup (h-4 w-* rounded bg-zinc-200). More realistic than solid placeholders.

### Migration Notes

- Badge color mapping changed from `teal` (ShadCN) to `green` (Catalyst) for published/valid states
- Alert actions now use `color="red"` prop instead of className for destructive buttons
- All plain buttons properly marked with `plain` prop (not `variant="ghost"`)
- Status filter dropdown uses same styling as form selects for consistency

---

---

## February 20, 2026 — Kill Switches Page Catalyst Rebuild

### What We Learned

1. **Loading states with animate-pulse divs are more polished than text messages.** The old pattern `<p className="text-sm text-muted-foreground">Loading clients...</p>` was functional but unpolished. The new pattern renders 3 skeleton rows with `animate-pulse` and `bg-zinc-200` mimicking the actual content layout. This is the Catalyst Application UI block pattern and provides better visual feedback during load.

2. **Confirmation dialogs should use semantic color props, not custom className overrides.** The old Alert had `className="bg-destructive text-destructive-foreground hover:bg-destructive/90"` on the confirm button. This violated the design system by using old CSS variables. Catalyst's `color="red"` prop handles all styling semantically and works with the light theme.

3. **Empty state messages should be consistently styled.** Changed from `text-muted-foreground` to `text-zinc-500` for "No clients found" / "No MCPs found" messages. This aligns with the light theme design system and removes CSS variable dependencies.

4. **Icon slot convention improves Catalyst Button consistency.** Power icons now use `<Power data-slot="icon" />` instead of manual className sizing and margins (`className="mr-2 h-4 w-4"`). This delegates sizing and spacing to Catalyst's internal slot system and ensures consistent button layouts across the app.

5. **Warning banners should use Tailwind color utilities for color theming.** The red warning banner now uses `bg-red-50`, `ring-red-200`, `text-red-600`, `text-red-900`, and `text-red-700` for a cohesive red theme. This is more maintainable than referencing a `destructive` CSS variable that may change meaning or not exist in the light theme.

### Recommendation

When rebuilding pages with Catalyst Application UI blocks, prioritize proper loading states (skeleton UIs) and semantic color props over custom className overrides. The icon slot convention (`data-slot="icon"`) should be adopted project-wide for all Catalyst Button usage.

