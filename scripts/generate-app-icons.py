"""Generate application branding from the canonical SVG.

Run: uv run --with pillow scripts/generate-app-icons.py
Requires pnpm and the project's installed Tauri CLI.
"""

from pathlib import Path
import shutil
import subprocess

from PIL import Image


ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "src/assets/margin-app-icon.svg"
ICONS = ROOT / "src-tauri/icons"

subprocess.run(
    [shutil.which("pnpm.cmd") or shutil.which("pnpm") or "pnpm", "tauri", "icon", str(SOURCE), "--output", str(ICONS), "--ios-color", "#F8FAFD"],
    cwd=ROOT,
    check=True,
)
shutil.copyfile(SOURCE, ROOT / "docs/assets/margin-app-icon.svg")

# With native mobile projects present, Tauri writes there instead of icons/ios
# and icons/android. Keep the bundle's referenced fallback copies in sync too.
apple = ROOT / "src-tauri/gen/apple/Assets.xcassets/AppIcon.appiconset"
if apple.is_dir():
    (ICONS / "ios").mkdir(exist_ok=True)
    for image in apple.glob("*.png"):
        shutil.copyfile(image, ICONS / "ios" / image.name)
android = ROOT / "src-tauri/gen/android/app/src/main/res"
if android.is_dir():
    for mipmap in android.glob("mipmap-*"):
        shutil.copytree(mipmap, ICONS / "android" / mipmap.name, dirs_exist_ok=True)
    background = android / "values/ic_launcher_background.xml"
    if background.is_file():
        (ICONS / "android/values").mkdir(parents=True, exist_ok=True)
        shutil.copyfile(background, ICONS / "android/values" / background.name)

# NSIS expects a 164 × 314, 24-bit BMP rather than an application icon.
sidebar = Image.new("RGB", (164, 314), "#FAF8F4")
with Image.open(ICONS / "icon.png") as image:
    emblem = image.convert("RGBA").resize((148, 148), Image.Resampling.LANCZOS)
sidebar.paste(emblem, (8, 72), emblem)
sidebar.save(ICONS / "nsis-sidebar.bmp", format="BMP")
