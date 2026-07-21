#!/usr/bin/env bash
# Build and push the web and data images.
#
#   pnpm images:push                    # tags :latest and :sha-<commit>
#   pnpm images:push:web                # just the web image
#   pnpm images:push --tag my-feature   # tags :my-feature and :sha-<commit>
#   pnpm images:push --no-push          # build only
#
# Uses Depot when DEPOT_PROJECT_ID is set, otherwise docker buildx. Both target
# linux/amd64 because deployments are x86 — a native-arch image built on an ARM
# laptop will not run there.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REGISTRY="${REGISTRY:-ghcr.io/turf-tools}"
PLATFORM="linux/amd64"

TAG=""
PUSH=1
ONLY=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag) TAG="$2"; shift 2 ;;
    --only) ONLY="$2"; shift 2 ;;
    --no-push) PUSH=0; shift ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
done
if [[ -n "$ONLY" && "$ONLY" != "web" && "$ONLY" != "data" ]]; then
  echo "--only takes 'web' or 'data'" >&2; exit 1
fi

cd "$REPO_ROOT"
COMMIT="$(git rev-parse HEAD)"
SHORT="$(git rev-parse --short HEAD)"
# A dirty tree means the sha tag would name a commit this image isn't.
[[ -n "$(git status --porcelain)" ]] && SHORT="${SHORT}-dirty"
SHA_TAG="sha-${SHORT}"
MOVING_TAG="${TAG:-latest}"

# Inlined into the client bundle at build time; without it the map renders blank
# with no error.
MAPTILER_KEY="${VITE_MAPTILER_KEY:-}"
if [[ -z "$MAPTILER_KEY" && -f apps/web/.env ]]; then
  MAPTILER_KEY="$(grep -E '^VITE_MAPTILER_KEY=' apps/web/.env | cut -d= -f2- || true)"
fi
if [[ -z "$MAPTILER_KEY" && "$ONLY" != "data" ]]; then
  echo "warning: no VITE_MAPTILER_KEY; the map will be blank" >&2
fi

# Depot builds natively on x86; the local fallback emulates it through QEMU and
# pushes from here, which is minutes slower.
# The build context is source only; anything large means a .dockerignore entry
# has gone stale (a renamed directory silently stops matching) and hundreds of
# MB are about to be uploaded and baked into the image.
MAX_CONTEXT_MB="${MAX_CONTEXT_MB:-50}"
context_mb() {
  # `docker build --dry-run` isn't universally available, so measure the way
  # Docker does: every file not excluded by .dockerignore.
  python3 - "$MAX_CONTEXT_MB" <<'PY'
import fnmatch, os, sys
patterns = [l.strip() for l in open(".dockerignore") if l.strip() and not l.startswith(("#", "!"))]
def ignored(rel):
    for p in patterns:
        bare = p[3:] if p.startswith("**/") else p
        if fnmatch.fnmatch(rel, p) or fnmatch.fnmatch(rel, p + "/*") or rel.startswith(p.rstrip("/") + "/"):
            return True
        if any(fnmatch.fnmatch(part, bare) for part in rel.split("/")):
            return True
    return False
total, biggest = 0, {}
for root, dirs, files in os.walk("."):
    rel_root = os.path.relpath(root, ".").replace("./", "")
    if rel_root != "." and ignored(rel_root):
        dirs[:] = []
        continue
    for f in files:
        rel = os.path.join(rel_root, f) if rel_root != "." else f
        if ignored(rel):
            continue
        try:
            size = os.path.getsize(os.path.join(root, f))
        except OSError:
            continue
        total += size
        key = "/".join(rel.split("/")[:2])
        biggest[key] = biggest.get(key, 0) + size
limit = int(sys.argv[1]) * 1_000_000
if total > limit:
    print(f"build context is {total/1e6:.0f} MB, over the {sys.argv[1]} MB limit.", file=sys.stderr)
    print("largest paths not excluded by .dockerignore:", file=sys.stderr)
    for k, v in sorted(biggest.items(), key=lambda kv: -kv[1])[:5]:
        print(f"  {v/1e6:8.1f} MB  {k}", file=sys.stderr)
    sys.exit(1)
print(f"{total/1e6:.1f} MB")
PY
}
if ! size=$(context_mb); then
  echo "aborting: fix .dockerignore, or raise MAX_CONTEXT_MB to override." >&2
  exit 1
fi
echo "build context: ${size}"

if [[ -n "${DEPOT_PROJECT_ID:-}" ]]; then
  echo "builder: depot (project ${DEPOT_PROJECT_ID})"
  BUILD=(depot build --project "$DEPOT_PROJECT_ID" --platform "$PLATFORM")
else
  echo "builder: local docker buildx — slow (emulated). Set DEPOT_PROJECT_ID to use Depot."
  BUILD=(docker buildx build --platform "$PLATFORM")
fi
[[ $PUSH -eq 1 ]] && BUILD+=(--push)

# Every label a base image sets is inherited unless overwritten, so all of these
# are set explicitly — otherwise an image inherits its base's identity, and
# GitHub links the package to whatever repo `image.source` names.
build_image() {
  local name="$1" dockerfile="$2"; shift 2
  echo "==> ${name}:${MOVING_TAG} (${SHA_TAG})"
  "${BUILD[@]}" \
    -f "$dockerfile" \
    -t "${REGISTRY}/turf-tools-${name}:${MOVING_TAG}" \
    -t "${REGISTRY}/turf-tools-${name}:${SHA_TAG}" \
    --label "org.opencontainers.image.title=turf-tools-${name}" \
    --label "org.opencontainers.image.description=Turf Tools ${name}" \
    --label "org.opencontainers.image.source=https://github.com/turf-tools/turf-tools" \
    --label "org.opencontainers.image.url=https://github.com/turf-tools/turf-tools" \
    --label "org.opencontainers.image.revision=${COMMIT}" \
    --label "org.opencontainers.image.version=${SHA_TAG}" \
    --label "org.opencontainers.image.licenses=MIT" \
    "$@" .
}

[[ "$ONLY" == "web" ]] || build_image data apps/data/Dockerfile
[[ "$ONLY" == "data" ]] || build_image web apps/web/Dockerfile --build-arg "VITE_MAPTILER_KEY=${MAPTILER_KEY}"

echo
echo "built ${SHA_TAG}"
if [[ $PUSH -eq 1 ]]; then
  echo "to deploy it, either keep :${MOVING_TAG} in the deployment's env file, or pin:"
  [[ "$ONLY" == "data" ]] || echo "  WEB_IMAGE=${REGISTRY}/turf-tools-web:${SHA_TAG}"
  [[ "$ONLY" == "web" ]] || echo "  DATA_IMAGE=${REGISTRY}/turf-tools-data:${SHA_TAG}"
fi
