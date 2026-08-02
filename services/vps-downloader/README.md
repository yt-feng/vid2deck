# Vid2PPT VPS downloader

Small authenticated service that runs `yt-dlp` on the Vultr fixed IP. It accepts
only canonical YouTube video URLs and returns the downloaded media file.

Required environment variable:

- `DOWNLOADER_API_TOKEN`: a long random bearer token shared only with the Vercel function.

Optional environment variables:

- `VID2PPT_CLOUD_MAX_DOWNLOAD_MB` (default `180`)
- `MAX_ACTIVE_DOWNLOADS` (default `2`)
- `VID2PPT_CLOUD_YTDLP_FORMAT`
- `YOUTUBE_COOKIES_NETSCAPE_B64`
- `VID2PPT_YOUTUBE_PLAYER_CLIENTS`
- `CORS_ORIGINS` (default `https://vid2ppt.com,https://www.vid2ppt.com`)

The host also needs `ffmpeg` plus a supported yt-dlp JavaScript runtime. This
service uses Deno, which yt-dlp currently recommends; install Deno 2.3 or newer
and make sure `deno` is on the systemd service's `PATH`.

The default image contains only the fixed-IP yt-dlp path. If that path still
hits YouTube verification, build `Dockerfile.full` and set
`HENGHENGMAO_USERNAME` and `HENGHENGMAO_PASSWORD`; the service will then try the
MeowLoad browser flow after yt-dlp. Mount `/data/henghengmao-profile` so its
login session persists. TikHub is intentionally not invoked by this service.

Build and run:

```sh
docker build -t vid2ppt-downloader .
docker run -d --restart unless-stopped \
  --name vid2ppt-downloader \
  -p 127.0.0.1:8787:8787 \
  -e DOWNLOADER_API_TOKEN='replace-with-a-long-random-token' \
  vid2ppt-downloader
```

Optional MeowLoad image:

```sh
docker build -f Dockerfile.full -t vid2ppt-downloader:full .
```

Put the service behind the VPS's existing HTTPS reverse proxy. Configure Vercel
with that HTTPS `/download` URL and the same bearer token. The Vercel function
uses the token to sign a URL-bound five-minute redirect, so video bytes travel
directly from the VPS to the browser and the bearer token stays server-side.
