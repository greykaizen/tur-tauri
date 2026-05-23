COPR notes for `tur-tauri`

This package is set up for COPR/mock builds that do not have network access.
It expects two extra source archives in dist-git:

- `cargo-vendor-<version>.tar.zst`
- `web-dist-<version>.tar.zst`

Build sources:

1. Run `packaging/fedora/make-sources.sh`
2. Upload both generated archives to your COPR dist-git sources
3. Keep `Source0` pointed at the GitHub release tarball

Why `web-dist` is prebuilt:

- COPR source builds should not pull Node dependencies from the network
- the Rust/Tauri build only needs `dist/` present at build time
- this keeps the RPM buildroot free of npm/yarn traffic
