#!/bin/bash
set -e
# Собирает «Seedance Generator.app» в /Applications: иконка + launcher, запускающий локальный сервер.
PROJECT="/Users/dimonbogdanov/Downloads/seedance-generator"
APP_NAME="Seedance Generator"
APP="/Applications/${APP_NAME}.app"
PY="$HOME/ComfyUI/venv/bin/python"
BUILD="$PROJECT/build"
rm -rf "$BUILD"; mkdir -p "$BUILD"

echo "1/4 master icon…"
"$PY" "$PROJECT/scripts/make_icon.py" "$BUILD/icon_1024.png"

echo "2/4 iconset → icns…"
ICONSET="$BUILD/AppIcon.iconset"; mkdir -p "$ICONSET"
gen() { sips -z "$1" "$1" "$BUILD/icon_1024.png" --out "$ICONSET/$2" >/dev/null; }
gen 16   icon_16x16.png
gen 32   icon_16x16@2x.png
gen 32   icon_32x32.png
gen 64   icon_32x32@2x.png
gen 128  icon_128x128.png
gen 256  icon_128x128@2x.png
gen 256  icon_256x256.png
gen 512  icon_256x256@2x.png
gen 512  icon_512x512.png
cp "$BUILD/icon_1024.png" "$ICONSET/icon_512x512@2x.png"
iconutil -c icns "$ICONSET" -o "$BUILD/AppIcon.icns"

echo "3/4 bundle…"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BUILD/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>${APP_NAME}</string>
  <key>CFBundleDisplayName</key><string>${APP_NAME}</string>
  <key>CFBundleIdentifier</key><string>com.damon.seedancegenerator</string>
  <key>CFBundleVersion</key><string>1.0</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
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

# нативная оболочка на Swift (WKWebView): сама стартует node-сервер и показывает UI в своём окне
echo "    compiling native Swift shell…"
swiftc -O "$PROJECT/scripts/main.swift" -o "$APP/Contents/MacOS/launch" \
  -framework Cocoa -framework WebKit
chmod +x "$APP/Contents/MacOS/launch"

echo "4/4 register…"
touch "$APP"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP" 2>/dev/null || true

echo "DONE → $APP"
