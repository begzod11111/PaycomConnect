#!/usr/bin/env bash
set -euo pipefail

# Configure git on the deployment VM so you can pull/push and rebuild the image.
#
# Typical first-time setup on the VM (run inside the repo directory):
#
#   GIT_USER_NAME="Deploy Bot" \
#   GIT_USER_EMAIL="deploy@paycom" \
#   GIT_REMOTE_URL="https://github.com/begzod11111/PaycomConnect.git" \
#   GIT_BRANCH="master" \
#   GITHUB_TOKEN="ghp_xxx"        # optional: PAT (repo scope) for HTTPS push/pull
#   ./deploy/setup-git.sh
#
# All variables are optional; only what you pass is changed. Re-running is safe.

REPO_DIR="${REPO_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
GIT_BRANCH="${GIT_BRANCH:-master}"
GIT_USER_NAME="${GIT_USER_NAME:-}"
GIT_USER_EMAIL="${GIT_USER_EMAIL:-}"
GIT_REMOTE_URL="${GIT_REMOTE_URL:-}"
GITHUB_TOKEN="${GITHUB_TOKEN:-}"

cd "$REPO_DIR"

echo "==> Repo: $REPO_DIR"

# 1) Trust the repo directory. Without this git refuses to operate when the
#    working copy is owned by a different user than the one running git
#    ("detected dubious ownership"), which is common on a shared VM.
git config --global --add safe.directory "$REPO_DIR" 2>/dev/null || true

# 2) Commit identity (needed for merges/rebases; harmless for pull-only use).
if [ -n "$GIT_USER_NAME" ]; then git config user.name "$GIT_USER_NAME"; fi
if [ -n "$GIT_USER_EMAIL" ]; then git config user.email "$GIT_USER_EMAIL"; fi

# 3) Safer pulls by default: fast-forward only (no surprise merge commits).
git config pull.ff only

# 4) Remote URL.
if [ -n "$GIT_REMOTE_URL" ]; then
  if git remote get-url origin >/dev/null 2>&1; then
    git remote set-url origin "$GIT_REMOTE_URL"
  else
    git remote add origin "$GIT_REMOTE_URL"
  fi
  echo "==> origin = $(git remote get-url origin)"
fi

# 5) Credentials for HTTPS push/pull (so you are not prompted every time).
if [ -n "$GITHUB_TOKEN" ]; then
  git config --global credential.helper store
  printf 'https://x-access-token:%s@github.com\n' "$GITHUB_TOKEN" > "$HOME/.git-credentials"
  chmod 600 "$HOME/.git-credentials"
  echo "==> Stored GitHub token in $HOME/.git-credentials (chmod 600)"
fi

# 6) Ensure we're on a real branch. Deployments frequently end up in a detached
#    HEAD (e.g. after checking out a specific commit), which breaks 'git pull'.
current_ref="$(git symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
if [ -z "$current_ref" ]; then
  echo "==> Detached HEAD detected; checking out '$GIT_BRANCH'"
  git fetch origin "$GIT_BRANCH" 2>/dev/null || true
  git checkout -B "$GIT_BRANCH" "origin/$GIT_BRANCH" 2>/dev/null \
    || git checkout "$GIT_BRANCH" 2>/dev/null \
    || echo "!! Could not switch to '$GIT_BRANCH' automatically — do it manually."
fi

echo
echo "==> Effective git config:"
git --no-pager config --list --show-origin \
  | grep -E 'user\.(name|email)|remote\.origin\.url|safe\.directory|pull\.ff|credential\.helper' \
  || true

echo
echo "==> Current branch / commit:"
git --no-pager log --oneline -1 2>/dev/null || echo "(no commits?)"

echo
echo "Done. You can now:  git pull   |   git push   |   ./deploy/deploy.sh"
