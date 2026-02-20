
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
