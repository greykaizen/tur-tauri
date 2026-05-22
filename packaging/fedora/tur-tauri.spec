Name:           tur-tauri
Version:        0.5.0
Release:        1%{?dist}
Summary:        Tur — A sleek, multi-engine download manager

License:        MIT
URL:            https://github.com/greykaizen/tur-tauri
Source0:        %{url}/archive/refs/tags/v%{version}.tar.gz

BuildRequires:  cargo
BuildRequires:  npm
BuildRequires:  nodejs
BuildRequires:  yarnpkg
BuildRequires:  webkit2gtk4.1-devel
BuildRequires:  gtk3-devel
BuildRequires:  libayatana-appindicator-devel
BuildRequires:  librsvg2-devel

Requires:       webkit2gtk4.1
Requires:       libayatana-appindicator

%description
Tur is a fast, multi-engine download manager featuring a modern UI powered by Tauri.
It supports resuming, segmented downloads, and rich integrations.

%prep
%setup -q

%build
yarnpkg install
yarnpkg tauri build --no-bundle

%install
rm -rf $RPM_BUILD_ROOT
install -D -m 755 src-tauri/target/release/tur-tauri $RPM_BUILD_ROOT%{_bindir}/tur-tauri
install -D -m 644 src-tauri/icons/512x512.png $RPM_BUILD_ROOT%{_datadir}/icons/hicolor/512x512/apps/tur-tauri.png

mkdir -p $RPM_BUILD_ROOT%{_datadir}/applications
cat > $RPM_BUILD_ROOT%{_datadir}/applications/tur-tauri.desktop <<EOF
[Desktop Entry]
Name=Tur
Comment=A sleek, multi-engine download manager
Exec=tur-tauri
Icon=tur-tauri
Terminal=false
Type=Application
Categories=Network;FileTransfer;
EOF

%files
%{_bindir}/tur-tauri
%{_datadir}/applications/tur-tauri.desktop
%{_datadir}/icons/hicolor/512x512/apps/tur-tauri.png

%changelog
* Fri May 22 2026 Kaizen <kaizen@example.com> - 0.5.0-1
- Initial release
