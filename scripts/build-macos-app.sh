#!/bin/bash
set -e
# Собирает «Damon Videogen.app» в /Applications: WKWebView-обёртка, которая запускает
# локальный node-сервер прямо из ЭТОЙ git-папки (scripts/main.swift → PROJECT) и показывает UI.
# Иконку берём готовую (scripts/AppIcon.icns), чтобы сборка не зависела от Python/PIL.
# Пересборка нужна ТОЛЬКО при смене имени/иконки/оболочки — правки кода подхватываются сами при запуске.

HERE="$(cd "$(dirname "$0")" && pwd)"
PROJECT="$(cd "$HERE/.." && pwd)"
APP_NAME="Damon Videogen"
BUNDLE_ID="com.damon.videogen"
APP="/Applications/${APP_NAME}.app"
ICNS="$HERE/AppIcon.icns"
# версия — единый источник из package.json
APP_VERSION="$(node -p "require('$PROJECT/package.json').version" 2>/dev/null || echo 1.0)"

[ -f "$ICNS" ] || { echo "нет иконки: $ICNS"; exit 1; }
[ -f "$HERE/main.swift" ] || { echo "нет main.swift"; exit 1; }

echo "1/3 bundle → $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$ICNS" "$APP/Contents/Resources/AppIcon.icns"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>${APP_NAME}</string>
  <key>CFBundleDisplayName</key><string>${APP_NAME}</string>
  <key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
  <key>CFBundleVersion</key><string>${APP_VERSION}</string>
  <key>CFBundleShortVersionString</key><string>${APP_VERSION}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>launch</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>LSApplicationCategoryType</key><string>public.app-category.video</string>
  <key>NSAppTransportSecurity</key>
  <dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict>
</plist>
PLIST

echo "2/3 compiling native Swift shell…"
swiftc -O "$HERE/main.swift" -o "$APP/Contents/MacOS/launch" \
  -framework Cocoa -framework WebKit
chmod +x "$APP/Contents/MacOS/launch"

echo "3/3 register with LaunchServices…"
touch "$APP"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP" 2>/dev/null || true

echo "DONE → $APP  (сервер стартует из: $PROJECT)"
