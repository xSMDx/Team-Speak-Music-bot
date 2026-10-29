#!/bin/sh
# YouTube changes often; keep yt-dlp fresh on every start (ignored if offline)
echo "[entrypoint] updating yt-dlp..."
timeout 90 /opt/yt-dlp/bin/pip install -q -U "yt-dlp[default]" >/dev/null 2>&1 || echo "[entrypoint] yt-dlp update skipped"
echo "[entrypoint] yt-dlp $(/opt/yt-dlp/bin/yt-dlp --version)"
exec node src/index.js
