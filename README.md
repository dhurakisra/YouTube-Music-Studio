# YTM Audio POC

Requires Node.js 24 or newer. Run `npm install`, then `npm start` to open the persistent `music.youtube.com` session. Use the **Start capture** button in the page after playback has begun; metrics and errors are written to `logs/*.jsonl`. The capture graph temporarily routes the selected media element through an AudioWorklet to the normal audio output.

`npx electron . --smoke` opens the page, logs a successful main-frame load, and exits (or exits after 10 seconds with a timeout log). This smoke mode does not test sign-in or audio playback.
