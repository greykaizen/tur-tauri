#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

version="$(sed -n 's/^version = "\(.*\)"/\1/p' src-tauri/Cargo.toml | head -n1)"
out_dir="packaging/fedora"
vendor_dir="$out_dir/vendor"
cargo_archive="$out_dir/cargo-vendor-$version.tar.zst"
web_archive="$out_dir/web-dist-$version.tar.zst"

# npm install
# npm run web:build

rm -rf "$vendor_dir"
cargo vendor --locked "$vendor_dir" --manifest-path src-tauri/Cargo.toml >/dev/null

tar --zstd -cf "$cargo_archive" -C "$out_dir" vendor
tar --zstd -cf "$web_archive" dist

printf 'Wrote %s\n' "$cargo_archive"
printf 'Wrote %s\n' "$web_archive"
