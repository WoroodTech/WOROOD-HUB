#!/usr/bin/env bash
#
# Push this consolidated repository to WoroodTech/WOROOD-HUB.
#
# Run this from your own machine, from inside the unzipped repository. It exists
# because the cloud session that produced these commits cannot reach the repo:
# its network is proxied and substitutes its own GitHub credentials, so a token
# pasted into the chat is never actually used.
#
#   export GH_PAT=github_pat_...        # fine-grained, Contents: read & write
#   bash scripts/push-to-github.sh
#
# The push is a fast-forward if the remote is still at 0bfcd06 (the commit this
# work was built on). If someone has pushed since, the script stops and tells
# you rather than guessing -- rebase, then run it again.

set -euo pipefail

REPO="${REPO:-WoroodTech/WOROOD-HUB}"
BRANCH="${BRANCH:-main}"

if [[ -z "${GH_PAT:-}" ]]; then
  echo "GH_PAT is not set. Export a fine-grained token with Contents: read & write." >&2
  exit 1
fi

git remote remove origin 2>/dev/null || true
git remote add origin "https://x-access-token:${GH_PAT}@github.com/${REPO}.git"

echo "Fetching ${REPO}…"
git fetch origin "${BRANCH}" || {
  echo "Branch ${BRANCH} does not exist on the remote yet -- pushing it fresh."
  git push -u origin "${BRANCH}"
  exit 0
}

# Refuse to clobber. If the remote has moved on, that is a rebase, not a push.
if ! git merge-base --is-ancestor "origin/${BRANCH}" HEAD; then
  echo
  echo "origin/${BRANCH} has commits this branch does not contain." >&2
  echo "Rebase onto it first, then run this again:" >&2
  echo "    git rebase origin/${BRANCH}" >&2
  exit 1
fi

git push -u origin "${BRANCH}"

# Leave no credential behind in .git/config.
git remote set-url origin "https://github.com/${REPO}.git"
echo
echo "Pushed. The remote URL has been rewritten without the token."
