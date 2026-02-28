# check-banned-tailwind.sh

Enforces design system consistency by detecting banned Tailwind CSS class patterns.

## Usage

```bash
# Via npm script (recommended)
npm run lint:tailwind

# Direct execution
bash scripts/check-banned-tailwind.sh
```

## What It Checks

### Hard Violations (exit 1)

1. **Arbitrary color values** — `bg-[#hex]`, `text-[#hex]`, `border-[#hex]`
   - Use design tokens: `bg-primary`, `text-muted`, `border-input`

2. **Arbitrary pixel font sizes** — `text-[16px]`
   - Use typography scale: `text-sm`, `text-base`, `text-lg`

3. **Important overrides** — `!bg-*`, `!text-*`, `!p-*`
   - Fix CSS specificity instead

4. **Arbitrary spacing** — `p-[12px]`, `m-[24px]`, `gap-[16px]`
   - Use spacing scale: `p-3`, `m-6`, `gap-4`

### Warnings Only (exit 0)

5. **Arbitrary width/height with px** — `w-[420px]`, `h-[80px]`
   - Shows warning but doesn't fail
   - Acceptable for precise UI components (separators, fixed-size containers)

## Design System

Design tokens are defined in `src/index.css`:

```css
@theme {
  --color-primary: 175 84% 26%;
  --color-secondary: 240 5% 96%;
  --color-muted: 240 5% 96%;
  --color-accent: 175 50% 93%;
  --color-destructive: 0 84% 60%;
  --color-border: 240 6% 90%;
  --radius: 0.375rem;
}
```

## Example Violations

❌ **Don't:**

```tsx
<div className="bg-[#1a1a1a] text-[14px] p-[12px] !m-4">
```

✅ **Do:**

```tsx
<div className="bg-primary text-sm p-3 m-4">
```

## Exit Codes

- **0** — Clean (no violations found)
- **1** — Violations found (see output for details)

## CI Integration

Add to your CI pipeline:

```yaml
- name: Lint Tailwind Classes
  run: npm run lint:tailwind
```

## Performance

Scans entire SPA (`packages/spa/src/`) in < 1 second.

## Modifying Patterns

Edit `check-banned-tailwind.sh` and add patterns to the relevant section:

```bash
# Add new color pattern
for pattern in 'bg-\[#[0-9a-fA-F]+\]' 'YOUR_NEW_PATTERN'; do
  ...
done
```

## Why Bash?

- **Fast:** < 1s for full SPA scan
- **Simple:** Easy to understand and modify
- **Maintainable:** No plugin dependencies
- **Project-specific:** Knows your design tokens

---

**Created:** February 20, 2026  
**Author:** Lead Developer  
**Related:** [Design System](../src/index.css), [M32.10 Completion](../../../mcpambassador_docs/m32-10-tailwind-linter-completion.md)
