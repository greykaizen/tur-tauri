#!/bin/bash
set -e
cd /home/kaizen/Repo/download-manager/tur-tauri

cleanup_rofiles() {
  if [ -d ".flatpak-builder/rofiles" ]; then
    for mount in .flatpak-builder/rofiles/*; do
      [ -e "$mount" ] || continue
      fusermount -uz "$mount" >/dev/null 2>&1 || true
    done
  fi
}

cleanup_rofiles
rm -rf .flatpak-builder repo
rm -rf packaging/flatpak/_local_src
mkdir -p packaging/flatpak/_local_src

rsync -a --delete \
  --exclude '.flatpak-builder' \
  --exclude 'node_modules' \
  --exclude 'repo' \
  --exclude 'dist' \
  --exclude '.git' \
  --exclude 'src-tauri/target' \
  --exclude 'packaging/flatpak/_local_src' \
  ./ packaging/flatpak/_local_src/

# 1. Build the flatpak into a local repository (repo/) from the local checkout.
flatpak run --command=flathub-build org.flatpak.Builder packaging/flatpak/com.kaizen.tur.yml

# 2. Add the local repo and install the app
flatpak --user remote-add --if-not-exists --no-gpg-verify tur-repo repo
flatpak --user install -y --reinstall tur-repo com.kaizen.tur
