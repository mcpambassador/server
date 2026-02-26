#!/usr/bin/env bash
# =============================================================================
# Enable Branch Protection for MCP Ambassador Repos
# =============================================================================
# Run this AFTER making repos public (free org plan requires public repos for
# branch protection rules).
#
# Prerequisites:
#   - gh CLI authenticated with admin access
#   - Repos are PUBLIC
#
# Usage: ./scripts/enable-branch-protection.sh
# =============================================================================

set -euo pipefail

ORG="mcpambassador"
REPOS=("server" "client" "community-registry")

# Required status checks per repo
declare -A STATUS_CHECKS
STATUS_CHECKS[server]="ci"
STATUS_CHECKS[client]="ci"
STATUS_CHECKS[community-registry]="validate"

echo "=== MCP Ambassador Branch Protection Setup ==="
echo ""

for REPO in "${REPOS[@]}"; do
  echo "--- Configuring ${ORG}/${REPO} ---"

  # Check repo visibility first
  VISIBILITY=$(gh api "repos/${ORG}/${REPO}" --jq '.visibility' 2>/dev/null || echo "unknown")
  if [[ "$VISIBILITY" != "public" ]]; then
    echo "  ⚠️  Repo is '${VISIBILITY}' — branch protection on free org requires public repos."
    echo "  Skipping. Make the repo public first, then re-run."
    echo ""
    continue
  fi

  # Apply branch protection ruleset via REST API
  # Using rulesets (newer API) which works better with free plans
  echo "  → Creating branch protection ruleset for 'main'..."

  gh api "repos/${ORG}/${REPO}/rulesets" \
    --method POST \
    --input - <<EOF
{
  "name": "main-protection",
  "target": "branch",
  "enforcement": "active",
  "conditions": {
    "ref_name": {
      "include": ["refs/heads/main"],
      "exclude": []
    }
  },
  "rules": [
    {
      "type": "pull_request",
      "parameters": {
        "required_approving_review_count": 1,
        "dismiss_stale_reviews_on_push": true,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": false
      }
    },
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": false,
        "required_status_checks": [
          {
            "context": "${STATUS_CHECKS[$REPO]}",
            "integration_id": null
          }
        ]
      }
    },
    {
      "type": "deletion"
    },
    {
      "type": "non_fast_forward"
    }
  ],
  "bypass_actors": []
}
EOF

  echo "  ✅ Branch protection enabled for ${ORG}/${REPO}"
  echo ""
done

echo "=== Done ==="
echo ""
echo "Rules applied:"
echo "  • Require 1 PR approval"
echo "  • Dismiss stale reviews on new push"
echo "  • Require CI status check to pass"
echo "  • Block force push"
echo "  • Block branch deletion"
echo "  • No bypass actors (admins included)"
