#!/usr/bin/env bash
set -euo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
arch='' image='' tag='' output_dir='' base_image='' interactive=1 export_image=1 dry_run=0
usage() {
  echo 'Usage: bash scripts/build-docker.sh [--arch amd64|arm64] [--image NAME] [--tag TAG]'
  echo '       [--base-image NODE_IMAGE] [--output-dir DIR] [--non-interactive] [--no-export] [--dry-run]'
}
while [[ $# -gt 0 ]]; do
  case "$1" in
    --arch|--image|--tag|--output-dir|--base-image)
      [[ $# -ge 2 && -n "$2" ]] || { echo "Missing value for $1" >&2; exit 1; }
      case "$1" in --arch) arch="$2";; --image) image="$2";; --tag) tag="$2";; --output-dir) output_dir="$2";; --base-image) base_image="$2";; esac
      shift 2 ;;
    --non-interactive) interactive=0; shift ;;
    --no-export) export_image=0; shift ;;
    --dry-run) dry_run=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage; echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done
prompt() {
  local answer=''
  if [[ "$interactive" == 1 ]]; then read -r -p "$1 [$2]: " answer; fi
  printf '%s' "${answer:-$2}"
}
echo '=== Jinhua Docker packaging wizard ==='
if [[ -z "$arch" ]]; then arch="$(prompt 'Architecture: 1 = AMD64 (Intel/AMD), 2 = ARM64' '1')"; fi
case "$arch" in
  1|amd|amd64) arch=amd64 ;;
  2|arm|arm64) arch=arm64 ;;
  *) echo 'Choose 1/amd64 or 2/arm64.' >&2; exit 1 ;;
esac
if [[ -z "$image" ]]; then image="$(prompt 'Image repository' 'zhajinhua')"; fi
if [[ -z "$tag" ]]; then tag="$(prompt 'Image tag (used exactly as entered)' "latest-$arch")"; fi
if [[ -z "$base_image" ]]; then base_image="$(prompt 'Node 24 base image (Docker official image via AWS ECR)' 'public.ecr.aws/docker/library/node:24-bookworm-slim')"; fi
if [[ ! "$image" =~ ^([a-z0-9.-]+(:[0-9]+)?/)?[a-z0-9]+(([._]|__|-+)[a-z0-9]+)*(/[a-z0-9]+(([._]|__|-+)[a-z0-9]+)*)*$ ]]; then echo 'Invalid repository; specify tag separately.' >&2; exit 1; fi
if [[ ! "$tag" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]]; then echo 'Invalid image tag.' >&2; exit 1; fi
ref="${image}:${tag}"; archive=''
if [[ "$export_image" == 1 ]]; then
  if [[ -z "$output_dir" ]]; then output_dir="$(prompt 'Archive directory (.tar.gz; local time)' "$root/dist")"; fi
  safe_image="$(printf '%s' "$image" | tr '/:' '__')"
  archive="$output_dir/${safe_image}_${tag}_${arch}_$(date '+%Y%m%d-%H%M%S').tar.gz"
fi
printf 'Platform: linux/%s\nImage: %s\nBase: %s\n' "$arch" "$ref" "$base_image"
if [[ -n "$archive" ]]; then printf 'Archive: %s\n' "$archive"; fi
if [[ "$dry_run" == 1 ]]; then printf 'Build: '; printf '%q ' docker buildx build --platform "linux/$arch" --build-arg "NODE_IMAGE=$base_image" --tag "$ref" --load --file "$root/Dockerfile" "$root"; printf '\n'; exit 0; fi
command -v docker >/dev/null || { echo 'Install Docker Desktop or Engine + Buildx: https://docs.docker.com/get-started/get-docker/' >&2; exit 1; }
[[ "$(docker info --format '{{.OSType}}')" == linux ]] || { echo 'Start Docker with Linux containers first.' >&2; exit 1; }
docker buildx version
if [[ "$export_image" == 1 ]]; then
  command -v gzip >/dev/null || { echo 'Install gzip first.' >&2; exit 1; }
  if ! command -v sha256sum >/dev/null && ! command -v shasum >/dev/null; then echo 'Install sha256sum or shasum first.' >&2; exit 1; fi
fi
if [[ "$interactive" == 1 ]]; then
  confirm="$(prompt 'Build and package now? Y/n' 'Y')"
  case "$confirm" in y|Y|yes|YES) ;; *) echo 'Cancelled.'; exit 0;; esac
fi
docker buildx build --platform "linux/$arch" --build-arg "NODE_IMAGE=$base_image" --tag "$ref" --load --file "$root/Dockerfile" "$root"
if [[ "$export_image" == 1 ]]; then
  mkdir -p -- "$output_dir"
  [[ ! -e "$archive" ]] || { echo "Archive already exists: $archive" >&2; exit 1; }
  partial="$(mktemp "$output_dir/.jinhua-XXXXXXXX")"
  trap 'rm -f -- "$partial"' EXIT
  echo 'Exporting and compressing image (gzip)...'
  docker image save "$ref" | gzip > "$partial"
  ln -- "$partial" "$archive"
  rm -f -- "$partial"
  trap - EXIT
  (cd -- "$output_dir"; if command -v sha256sum >/dev/null; then sha256sum "$(basename -- "$archive")"; else shasum -a 256 "$(basename -- "$archive")"; fi) > "$archive.sha256"
  printf 'Archive: %s\nImport: docker load --input "%s"\n' "$archive" "$archive"
fi
printf 'Built: %s (linux/%s)\n' "$ref" "$arch"
printf 'Run: docker run -d --init --name jinhua -p 3001:3000 --env-file .env -v jinhua-data:/app/data %s\n' "$ref"
echo 'Initialize admin (if needed): docker exec -it jinhua node docker/setup-admin.mjs'
