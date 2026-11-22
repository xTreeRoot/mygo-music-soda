"""Package only the plugin and public documentation."""
import json
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

root = Path(__file__).resolve().parent
manifest = json.loads((root / "plugin.json").read_text())
destination = root / "dist" / f"soda-{manifest['version']}.zip"
destination.parent.mkdir(exist_ok=True)
with ZipFile(destination, "w", compression=ZIP_DEFLATED) as archive:
    for name in ("plugin.json", "index.js", "playback.js", "login-page.js", "login-verification.js", "vendor/qr-source.js", "vendor/verification-runtime.js", "vendor/LICENSE-react", "LICENSE", "THIRD_PARTY_NOTICES.md", "README.md"):
        archive.write(root / name, name)
print(destination)
