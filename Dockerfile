FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg python3 python3-venv ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && python3 -m venv /opt/yt-dlp \
 && /opt/yt-dlp/bin/pip install --no-cache-dir -U "yt-dlp[default]"

ENV NODE_ENV=production \
    YTDLP_BIN=/opt/yt-dlp/bin/yt-dlp

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
COPY docker-entrypoint.sh ./

VOLUME /app/data
ENTRYPOINT ["sh", "/app/docker-entrypoint.sh"]
