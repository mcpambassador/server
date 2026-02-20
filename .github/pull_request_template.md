# Pull Request

## Summary
<!-- Brief description of what this PR does -->

## Type
- [ ] Feature
- [ ] Bug fix
- [ ] Refactor
- [ ] Documentation
- [ ] Test

## Changes
<!-- List the key changes -->

## Testing
- [ ] All existing tests pass (`pnpm test`)
- [ ] New tests added (if applicable)
- [ ] Manual testing performed

## Design System Compliance (UI changes only)
- [ ] No `backdrop-blur` anywhere
- [ ] No `bg-background/XX` opacity patterns
- [ ] No `shadow-lg` outside dialog content panels
- [ ] No gradient backgrounds
- [ ] `rounded-md` used (not `rounded-lg`) for new components
- [ ] CI check passes: `bash scripts/check-design-system.sh`

## Security (if applicable)
- [ ] No secrets or credentials exposed
- [ ] Error responses don't leak internal details
- [ ] Input validation present on all new endpoints

## Reviewer Checklist
- [ ] Code follows established patterns
- [ ] TypeScript compiles clean (`pnpm typecheck`)
- [ ] No unnecessary dependencies added
