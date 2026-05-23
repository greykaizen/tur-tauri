%undefine __brp_mangle_shebangs

Name:           tur-tauri
Version:        0.5.1
Release:        1%{?dist}
Summary:        Tur — A sleek, multi-engine download manager

License:        GPL-3.0-or-later
URL:            https://github.com/greykaizen/tur-tauri
Source0:        %{url}/archive/refs/tags/v%{version}/tur-tauri-%{version}.tar.gz
Source1:        cargo-vendor-%{version}.tar.zst
Source2:        web-dist-%{version}.tar.zst

BuildRequires:  cargo
BuildRequires:  gcc
BuildRequires:  rust
BuildRequires:  desktop-file-utils
BuildRequires:  webkit2gtk4.1-devel
BuildRequires:  gtk3-devel
BuildRequires:  libayatana-appindicator-gtk3-devel
BuildRequires:  librsvg2-devel
BuildRequires:  openssl-devel

Requires:       webkit2gtk4.1
Requires:       libayatana-appindicator-gtk3
Requires:       gtk3

%description
Tur is a fast, multi-engine download manager featuring a modern UI powered by Tauri.
This is the official native GUI frontend for the tur-rs Rust engine.

%prep
%autosetup -n tur-tauri-%{version}
tar --zstd -xf %{SOURCE1}
tar --zstd -xf %{SOURCE2}

# Prevent Tauri from attempting to run yarn during the offline cargo build
sed -i 's/"beforeBuildCommand": "yarn run web:build",/"beforeBuildCommand": "",/' src-tauri/tauri.conf.json
mkdir -p .cargo
cat > .cargo/config.toml <<'EOF'
[source.crates-io]
replace-with = "vendored-sources"

[source."git+https://github.com/greykaizen/tur-rs"]
git = "https://github.com/greykaizen/tur-rs"
replace-with = "vendored-sources"

[source.vendored-sources]
directory = "vendor"
EOF

%build
cargo build --release --locked --frozen --offline --manifest-path src-tauri/Cargo.toml

%install
install -D -m 0755 src-tauri/target/release/tur %{buildroot}%{_bindir}/tur-tauri
install -D -m 0644 src-tauri/icons/icon.png %{buildroot}%{_datadir}/icons/hicolor/512x512/apps/io.github.greykaizen.tur.png
install -D -m 0644 packaging/fedora/io.github.greykaizen.tur.desktop %{buildroot}%{_datadir}/applications/io.github.greykaizen.tur.desktop
install -D -m 0644 packaging/flatpak/io.github.greykaizen.tur.metainfo.xml %{buildroot}%{_datadir}/metainfo/io.github.greykaizen.tur.metainfo.xml

desktop-file-validate %{buildroot}%{_datadir}/applications/io.github.greykaizen.tur.desktop

%files
%license LICENSE
%doc README.md
%{_bindir}/tur-tauri
%{_datadir}/applications/io.github.greykaizen.tur.desktop
%{_datadir}/icons/hicolor/512x512/apps/io.github.greykaizen.tur.png
%{_datadir}/metainfo/io.github.greykaizen.tur.metainfo.xml

%changelog
* Fri May 22 2026 Kaizen <kaizen@example.com> - 0.5.0-1
- Initial COPR package
