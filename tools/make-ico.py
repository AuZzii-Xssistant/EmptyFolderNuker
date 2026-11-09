"""Packs the PNGs from make-icon.mjs into icons/icon.ico (PNG-compressed entries) and icon.png."""
import base64, json, struct, sys
pngs = {int(k): base64.b64decode(v) for k, v in json.load(open(sys.argv[1])).items()}
sizes = sorted(pngs)
out = struct.pack('<HHH', 0, 1, len(sizes))
off = 6 + 16 * len(sizes)
for s in sizes:
    out += struct.pack('<BBBBHHII', s % 256, s % 256, 0, 0, 1, 32, len(pngs[s]), off)
    off += len(pngs[s])
open('src-tauri/icons/icon.ico', 'wb').write(out + b''.join(pngs[s] for s in sizes))
open('src-tauri/icons/icon.png', 'wb').write(pngs[256])
