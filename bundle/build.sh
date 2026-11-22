#!/bin/sh
# Build the bundle image locally under its final name.
#
#   bundle/build.sh <n>        tags <upstream version>-jdt.<n>, e.g. bundle/build.sh 1
#
# Reads bundle/UPSTREAM for the upstream repository and commit, takes the
# upstream version from package.json and the fork commit from HEAD. Refuses a
# dirty working tree, so the fork commit in the labels is what was built.
# Nothing is pushed. The CI workflow passes the same build arguments.
set -eu
cd "$(dirname "$0")/.."
[ $# -eq 1 ] || { echo "usage: bundle/build.sh <n>   (image tag <upstream version>-jdt.<n>)" >&2; exit 2; }
. ./bundle/UPSTREAM
if [ -n "$(git status --porcelain)" ]; then
  echo "working tree is not clean; commit first so the image labels name what was built" >&2
  exit 1
fi
if ! git merge-base --is-ancestor "$UPSTREAM_COMMIT" HEAD 2>/dev/null; then
  echo "bundle/UPSTREAM names $UPSTREAM_COMMIT, which is not an ancestor of HEAD" >&2
  exit 1
fi
node bundle/check-links.mjs
upstream_version=$(node -p "require('./package.json').version")
version="$upstream_version-jdt.$1"
docker build \
  --build-arg VERSION="$version" \
  --build-arg UPSTREAM_VERSION="$upstream_version" \
  --build-arg UPSTREAM_COMMIT="$UPSTREAM_COMMIT" \
  --build-arg UPSTREAM_REPO="$UPSTREAM_REPO" \
  --build-arg FORK_REPO="$FORK_REPO" \
  --build-arg FORK_COMMIT="$(git rev-parse HEAD)" \
  -t "$IMAGE:$version" .
echo "built $IMAGE:$version"
