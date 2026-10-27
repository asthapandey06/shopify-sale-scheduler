# PriceTide launch video (30 s, 1920×1080)

Source for the promo video: `launch.html` is a deterministic animation (`window.render(t)` draws the frame at
`t` seconds), `render.mjs` screenshots it at 30 fps, ffmpeg encodes the MP4. Product cards are illustrations,
not screenshots of the app (the frame says so). Edit text in `launch.html`, e.g. change
"Coming soon to the Shopify App Store" once the listing is live.

Render (outputs go next to these files; frames are ~130 MB, keep them out of git):

```bash
cd marketing/launch-video
export PLAYWRIGHT_CORE=$(ls -d ~/.npm/_npx/*/node_modules/playwright-core | head -1)/index.mjs
export CHROME=$(ls -d ~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome | head -1)
node render.mjs 5.5,15.8,23            # preview a few frames as preview-*.jpg
node render.mjs                        # all 900 frames into frames/
docker run --rm -v "$PWD":/w public.ecr.aws/docker/library/alpine:3.20 sh -c 'apk add --no-cache ffmpeg >/dev/null &&
  ffmpeg -y -framerate 30 -i /w/frames/f%04d.jpg -vf "fade=t=in:st=0:d=0.4,fade=t=out:st=29.4:d=0.6,format=yuv420p"
  -c:v libx264 -preset slow -crf 17 -profile:v high -movflags +faststart /w/PriceTide-launch-30s.mp4'
```

Timeline: 0–3.6 s hook · 3.6–7 s logo · 7–13 s create a sale · 13–19.5 s sale starts · 19.5–25.6 s sale ends
(edit kept, prices restored) · 25.6–30 s features + call to action.

The video is silent: add licensed music (e.g. from your editor's library) before publishing.
