# YouTube Music Studio

**English** · [Türkçe](README.tr.md)

YouTube Music Studio is a Windows program that turns `music.youtube.com` into a steampunk-styled desktop app and adds an **audio studio** on top. Besides listening to a song losslessly, you can:

- split a song into **vocals / drums / bass / other** and turn each one down, mute it, or listen to it alone,
- do **karaoke**, running your microphone through a professional **vocal chain** and recording it,
- change the song's **pitch (Key)** and **speed (Tempo)**,
- shape the sound with an **equalizer, enhancer, and limiter**,
- follow **synced lyrics** and click a line to jump the song to that spot,
- store your recordings in layers, then **mix them and export as MP3.**

Your account is your normal YouTube Music account; when you sign in, your library, playlists, and recommendations come through as they are. Audio processing happens **entirely on your own computer** (the AI models ship with the app, and no audio is sent to the internet).

> This project is not affiliated with YouTube or Google. It is designed for personal use with your own account only.

---

## Contents

1. [Installation](#1-installation)
2. [Updates](#2-updates)
3. [Getting to know the screen](#3-getting-to-know-the-screen)
4. [The Studio drawer](#4-the-studio-drawer)
5. [Modes: Listen, Listen with Stems, Karaoke](#5-modes)
6. [Stem separation (vocals, drums, bass, other)](#6-stem-separation)
7. [Karaoke step by step](#7-karaoke-step-by-step)
8. [Vocal Chain](#8-vocal-chain)
9. [Key & Tempo](#9-key--tempo)
10. [Equalizer](#10-equalizer)
11. [Enhancer](#11-enhancer)
12. [Output: master, limiter, and VU meters](#12-output)
13. [Recordings, Mixer, and export](#13-recordings-mixer-and-export)
14. [Lyrics](#14-lyrics)
15. [Video mode: the steampunk television](#15-video-mode-the-steampunk-television)
16. [Steampunk look](#16-steampunk-look)
17. [Privacy](#17-privacy)
18. [Troubleshooting](#18-troubleshooting)
19. [Running from source and development](#19-running-from-source-and-development)
20. [Publishing a new release](#20-publishing-a-new-release)

---

## 1. Installation

**Requirements:** Windows 10/11 (64-bit), about 700 MB of free disk space, 8 GB RAM (16 GB recommended for stem separation). For karaoke, a microphone and **headphones** (see [Karaoke](#7-karaoke-step-by-step)).

1. Download `YouTube-Music-Studio-Setup-<version>.exe` from the [Releases](../../releases) page.
2. Run it. You can choose the install path; desktop and Start menu shortcuts are created.
3. If Windows shows an "Unknown publisher" warning on first launch, choose **More info → Run anyway**. (The app is not digitally signed yet.)
4. Sign in to your Google account with the **Sign in** button at the top right. Your session is kept until the next launch.

The AI models (`htdemucs`, `umx-hq`) are included in the installer; you don't need to download them separately.

To uninstall, use Windows **Settings → Apps**. Your recordings and session stay in the `%APPDATA%\YTM-Audio-POC` folder; uninstalling does not delete them.

## 2. Updates

Shortly after the app opens (and every 4 hours after that), it checks GitHub **Releases**. If a newer version exists, a window like this appears:

> *A new version of YouTube Music Studio is available (1.2.0). Download now / Later*

- **Download now**: the version is downloaded in the background, with progress shown on the window's taskbar icon. When it finishes, it offers "Restart and install" (restart immediately and install) or "Install when I close the app" (install when you close the app).
- **Later**: nothing is downloaded; you will be asked again at the next check.

If the computer is not connected to the internet or GitHub cannot be reached, the check is skipped silently and shows no error. For a version to count as "published," a Release must be created on GitHub; simply pushing code (a commit) to the repository does not reach users as an update. See [section 20](#20-publishing-a-new-release) for details.

## 3. Getting to know the screen

The app is regular YouTube Music; the following has been added on top:

| Area | What's there |
|---|---|
| **Top bar** | Logo plate, search box, live **analog VU meters (L/R)**, brass **VOLUME** knob, cast, account picture, and **Sign in**. When the window is narrow, the VU meters are hidden and only the volume knob remains. If you like, the **graphic equalizer** strip also opens up here. |
| **Left panel** | Home / Explore / Library menu and your playlists. On the edge, the **RECORDINGS** tab (your recordings). |
| **Center area** | Home page shelves, album and playlist pages. Every song list sits inside a rust-textured plate. |
| **Right edge** | The **LYRICS** tab (lyrics panel). |
| **Bottom player bar** | Song title, artist, a progress bar with a **live spectrum waveform**, and play/pause/next/previous/shuffle/repeat buttons. You can navigate the song by clicking on the progress line. |
| **STUDIO tab** | Just above the bottom bar, in the center. Clicking it opens the **Studio drawer**. |

## 4. The Studio drawer

Click the **STUDIO ▲** tab at the bottom. A full-width drawer with a steampunk leather background slides up from the bottom of the screen. The top row, left to right:

**SESSION · KEY & TEMPO · MIXER · EQUALIZER · ENHANCER · OUTPUT**

The bottom row holds the **VOCAL CHAIN** modules, and at the very bottom is a **status strip** (separation model, capture status, "underruns" counter). When the drawer is closed, the Studio settings (EQ, Enhancer, Key, Output) keep working; they just disappear from the screen.

The valve, pipe wheels, capacitor lamps, and steam on the right side of the drawer are not decoration: they move **while the vocal chain is actually in use** (microphone on, karaoke, or mixer view). That way you can tell at a glance that the chain is running.

## 5. Modes

The **SESSION** section has three buttons. One is lit; pressing another releases it.

| Mode | What it does |
|---|---|
| **LISTEN** | Normal YouTube Music. There is no audio processing (only EQ/Enhancer run, if you want them). The program opens in this mode. |
| **LISTEN WITH STEMS** | Captures the song, splits it into stems with AI, and plays it from the mixer. You can turn the vocals down or mute the drums. At the start you see a **"BUFFERING, PLEASE WAIT n"** countdown in the middle of the screen (see [Stem separation](#6-stem-separation)). Press again to return to normal listening. |
| **KARAOKE** | Switches to karaoke mode; the music stops. Nothing is recorded until you press **START KARAOKE**. Details: [Karaoke](#7-karaoke-step-by-step). |

You can switch directly from any mode to any other; capture and the vocal chain turn off/on automatically during the switch.

The **ADVANCED** button opens a vertical form where you choose the separation model (for example, `htdemucs` is high quality but heavy, while `umx-hq` is fast and light).

## 6. Stem separation

The stems are: **Vocals**, **Drums**, **Bass**, and **Other** (other instruments). The MIXER section has **VOCALS** and **INSTR.** (instruments) channels plus a **KARAOKE MIC** channel; each has a fader, **SOLO**, and **MUTE**. In the full 5-channel mix (vocals, drums, bass, other, microphone) you can control each stem separately.

**Why the "BUFFERING" countdown?** To work in real time, the separation accumulates **about 10 seconds of buffer** from the song. For this reason, the separated audio arrives a few seconds behind the original. The program measures this and uses the delay for the following: lyrics, the karaoke countdown, and recording alignment. The "BUFFER x.x s" value on screen is the current buffer length.

Tips:

- On drums/percussion, pitch shifting (Key) may produce slight artifacts. This is due to the nature of the time-stretching/pitch-shifting algorithm.
- On heavily mastered songs, vocal leakage (ghost vocals) is normal; separation models are not 100% perfect.
- Separation uses the processor. If the **UNDERRUNS** counter in the status strip keeps rising, the computer can't keep up; choose a lighter model or close other heavy applications.

## 7. Karaoke step by step

1. **Put on headphones.** If your microphone hears the speaker, you get feedback (a howl) and the recording is ruined. The **USE HEADPHONES** warning in the chain is for this.
2. Press **SESSION → KARAOKE**. The music stops, and the screen reads *"PRESS START KARAOKE WHEN READY"*. The **Vocal Chain** section below appears.
3. Choose the song in YouTube Music (the song does not need to have started playing before you begin karaoke; the program starts the song **from the beginning**).
4. In the Vocal Chain's **INPUT** section, choose your microphone and adjust **LEVEL**. If you like, turn on **AUTO-TUNE** and the other modules (see [Vocal Chain](#8-vocal-chain)). Choosing a **chain preset** (e.g. *Clean Pop*) is the fastest way.
5. Press **START KARAOKE** (or **REC** in the chain). The program:
   - rewinds the song to the start and mutes the vocal stem (you hear the music as instruments only),
   - turns on the microphone and the vocal chain,
   - shows a **"BUFFERING, PLEASE WAIT n"** countdown in the middle of the screen (until the stem delay is filled),
   - when ready, **recording begins** and the lyrics start to flow.
6. Sing. In the lyrics panel (right edge), the lines scroll along; if you click a line, the song jumps there.
7. To finish, press **START KARAOKE / REC** again: **STOP & SAVE**. The recording is saved, the microphone and stems turn off, and the music stops. The mode stays ready as karaoke.

Recordings are stored in **layers**: vocals, drums, bass, other, microphone (processed), microphone (raw). That way you can remix each layer separately afterward ([Recordings](#13-recordings-mixer-and-export)).

**Trial without recording:** In Listen mode, the brass **ACTIVATE MIC** switch under the microphone channel turns on your microphone and the vocal chain without recording. It's ideal for trying effects and rehearsing.

## 8. Vocal Chain

The microphone signal passes through the following modules from left to right. **Each module has its own on/off LED**; a module that is off does not enter the sound at all. Under each module is a **preset** menu specific to that module, and at the top is a **whole-chain preset** menu.

| Order | Module | What it does |
|---|---|---|
| 1 | **INPUT** | Microphone selection, input level (LEVEL), sum to mono. In karaoke it goes equally to both ears. |
| 2 | **AUTO-TUNE** | Pulls the voice to the notes of the **Key** and **Scale** you choose (e.g. C / Major). **SPEED**: how quickly it corrects (low = natural, high = "robot" effect). **AMOUNT**: correction ratio. |
| 3 | **GATE** | Cuts the room noise that enters the microphone while you are silent. **THRESH** threshold: turns down sound below it. |
| 4 | **LOW CUT** | Cuts low frequencies (breath pops, desk noise). **FREQ** sets the cutoff point. |
| 5 | **EQ** | Vocal-specific low shelf (LOW) and "mud" (MUD) region adjustment: thins or fills out the voice. |
| 6 | **COMP** | Compressor: narrows the difference between loud and quiet sounds; the vocal comes forward. **AMOUNT** is the compression amount. The gain reduction (GR) bar shows how much is being suppressed. |
| 7 | **DE-ESS** | Softens the harshness of "S" and "Sh" sounds. Has a GR bar. |
| 8 | **PRESENCE** | Adds voice clarity/brightness (**AIR**). |
| 9 | **SATURATION** | Light tube/tape saturation (**DRIVE**) and its mix with the dry sound (**MIX**). Adds warmth to the voice. |
| 10 | **DOUBLER** | Doubles the voice with a short-delayed, slightly modulated copy; "two vocals" thickness and spread (**AMOUNT / WIDTH**). |
| 11 | **HARMONIZER** | Adds **harmony** on top of your voice: octave down, third (+3), fourth (+4), fifth (+5), octave up. **LEVEL** sets how audible it is. |
| 12 | **REVERB** | Echo/room effect. **SEND** is how much is sent, **DECAY** is the duration. |
| 13 | **DELAY** | Echo. **SEND** and **TIME**. |
| 14 | **OUTPUT** | **CHAIN ON** (the main switch of the whole chain) and **REC** (record). |

**Whole-chain presets:** *Flat (all neutral)*, *Clean Pop*, *Rock Edge*, *Hip-Hop*, *Ballad*, *Karaoke Fun*, *Radio / Lo-fi*, *Stadium*, *Harmony Stack*, *Podcast*. When you choose one, the chain turns on automatically; afterward you can play with the modules one by one.

**Tips**

- First choose a preset, then adjust only GATE and LEVEL; that is often enough.
- If you don't know the song's key, keep Auto-Tune's SPEED low (it intervenes less).
- Harmonizer and Doubler are clearly audible on wrong notes; add them little by little.
- The chain's effect on the microphone is **also applied in the Mixer after recording**; you don't have to settle for the settings used during recording, and you can change them afterward.

## 9. Key & Tempo

The **KEY & TEMPO** section works both in normal listening and in stem mode.

- **KEY** (−8 … +8 semitones): changes the song's pitch. The sound gets higher or lower, but the speed doesn't change. In karaoke it is used to move the song down or up to suit your voice. In stem mode, the pitch is also applied to the stem layers and to **recordings**; that is, your recording is stored in the key you sang in.
- **TEMPO** (50% … 150%): changes the song's speed **without distorting the pitch** (browser time-stretching). The lyrics and recording speed follow this value.
- **RESET**: returns both to their starting values (0 / 100%).

Pitch shifting is done with the high-quality **Signalsmith Stretch** algorithm. If you hear a deviation or an artifact, set KEY to 0 and try again.

## 10. Equalizer

There are two modes; **only one can be selected at a time**:

- **PARAMETRIC**: click and drag the numbered points (1–6) to set band type (bell, etc.), frequency, gain, and Q. A live spectrum appears in the graph.
- **GRAPHIC EQ**: a classic 10-band fader EQ (32 Hz – 16 kHz). The faders in the drawer are the same as the graphic equalizer in the top bar.

Both have an **EQ ON / OFF** switch, a **preset** menu, and **SAVE / DEL** for saving your own presets (type in the name box and press SAVE). The graphic EQ strip in the top bar also has ready-made settings such as *Loudness*.

## 11. Enhancer

Adds color and width to the sound. It is turned on with the **ENHANCER** switch. Four controls:

- **DRIVE**: harmonic richness.
- **WARMTH**: low-mid warmth.
- **AIR**: high-frequency brightness.
- **WIDTH**: stereo width.

At the bottom are the **ANALOG**, **VINYL**, and **TAPE** character buttons. While the Enhancer is on, the three wheels in the drawer also start turning.

## 12. Output

The **OUTPUT** section is the main output:

- **VU (L/R)**: the analog meter needles for the left and right channels.
- **MASTER**: the main volume knob.
- **THRESH + LIMITER**: a **limiter** so the output doesn't clip (so there's no crackle). THRESH is the level at which the limiter kicks in; it is turned on with the LIMITER button, and THRESH is dimmed while it is off.

If the sound distorts, first turn down MASTER and the Enhancer DRIVE, then turn on LIMITER.

## 13. Recordings, Mixer, and export

The **RECORDINGS** tab on the left edge lists the karaoke recordings you made with this app. You can select and play a recording. While a recording is loaded, the drawer switches to the **Mixer view**:

- **LAYERS** tab: you mix the vocals, drums, bass, other, microphone (processed), and microphone (raw) layers, each with its own fader / SOLO / MUTE.
- **MIXED** tab: the ready-made single-piece mix.
- **The vocal chain works here too**: you can apply and adjust the chain **afterward** on the raw microphone recording (micdry). That way you can change things like Auto-Tune, reverb, and compressor after recording.
- **MIC SHIFT**: fine-tunes the microphone's alignment with the music. Here you align a vocal that sits slightly behind/ahead because of the stem delay.
- **EXPORT**: processes the mix (chain included) offline and saves it to disk as **MP3**. The file name and location are asked for with a save dialog.

Recordings are saved to the `%APPDATA%\YTM-Audio-POC\recordings` folder, each in a `.layers` subfolder (layers as WAV). To back up, you can copy this folder.

## 14. Lyrics

Click the **LYRICS** tab on the right edge (it opens automatically when you enter karaoke; it is separate from YouTube Music's own *LYRICS* tab). In the panel, the artist, album, and song title appear at the top, and the lyrics below.

- If **synced lyrics** (timestamped) are available, the current line is highlighted and scrolls along.
- **Click a line**: the song jumps there and that line stays lit.
- **SYNC −/+ 0.5 s**: if the lyrics don't match the audio, you shift them forward/back by hand.
- Lyrics are aligned to the **song's actual sound**: the stem delay and the TEMPO setting are taken into account.

Lyrics are searched for in the following sources in order, and the first one that finds them is used: **LRCLIB → NetEase → Kugou → lyrics.ovh**. The first is the most reliable and is official; the others are unofficial endpoints and may stop working from time to time. For some songs, synced lyrics cannot be found; in that case, plain text may be shown, or no lyrics may appear at all.

## 15. Video mode: the steampunk television

On the player page (when you click the cover image while a song is playing), the video or album cover appears in the glass of a **steampunk television**:

- On the small plate at the top, the playing **song title and artist** scroll continuously from right to left in amber digital lettering (with faint scan lines and brief flicker).
- The **tube lamps** on both sides of the television glow and flicker slightly.
- With the **SONG** and **VIDEO** brass buttons below it, you switch between song and video; the selected one lights up amber.
- The television shrinks automatically to match the window size, so it always fits. If the video isn't 16:9 (4:3, square cover), both sides of the glass stay black.
- The **Up Next** panel on the right is also inside a rust-textured plate.

## 16. Steampunk look

The visual theme belongs entirely to this app and is drawn on top of YouTube Music:

- **Textures:** rusty leather, brass, riveted plates, chains, and gears. On the page edges there are two chains that move as you scroll, and gears that spin in the corners.
- **Living background:** flickering lamps, a spinning red valve, a needle gauge, and steam (kept light so it doesn't weigh down the background).
- **Shelf headings:** neon lettering on a filament-wire plate; the text appears with a short "spark" animation, and the wires carry electricity.
- **Song lists:** each list is chained up with a rust-textured plate and two clamps (including album and playlist pages). On album and playlist pages, the cover/title/buttons stay **fixed** in the left pane and don't stick when you scroll.
- **Top bar:** the logo "neon plate," brass oval search box, live VU meters, brass VOLUME knob.
- **Player bar:** dark background, progress line with a **live spectrum**, brass transport buttons.
- **Studio drawer:** leather background, brass buttons, analog VU meters, spinning wheels (Session/Key&Tempo/Enhancer/side column), cables, capacitor lamps, and steam. The wheels' direction and speed depend on the mode you choose and the KEY/TEMPO step.
- **Fonts:** Oswald, Barlow, Cinzel Decorative, Nixie One, VT323 (all SIL Open Font License; see `design/fonts/LICENSES.md`).

Visual effects use the processor; if your computer is struggling, making the window smaller or lightening the separation model helps.

## 17. Privacy

- **Audio does not leave your computer.** Stem separation, the vocal chain, recording, and export are entirely local.
- **Lyrics search** sends out only the **artist, song title, album, and duration** (LRCLIB, NetEase, Kugou, lyrics.ovh).
- **Your sign-in details** go to YouTube Music (Google); the app does not see or store your password, and session cookies are kept in the Chromium profile inside `%APPDATA%\YTM-Audio-POC`.
- **The update check** only requests version information from GitHub.
- Debug logs are in `%APPDATA%\YTM-Audio-POC\logs` and carry no audio content.

## 18. Troubleshooting

| Problem | Solution |
|---|---|
| In karaoke my own voice echoes / howls | Put on headphones. Karaoke can't be done with speakers. |
| "BUFFERING" takes very long / UNDERRUNS keeps rising | Lighten the separation model (ADVANCED) and close heavy background applications. |
| Lyrics don't match the audio | In the LYRICS panel, shift them with SYNC in ±0.5 s steps. |
| Microphone doesn't appear | Check that Windows **Privacy → Microphone** permission is on and that the right device is selected in INPUT. |
| Sound is clipping/distorting | Turn down MASTER, turn on LIMITER, reduce Enhancer DRIVE. |
| I can't sign in | Open YouTube Music in a browser and verify that your account works; close and reopen the app. |
| No update appears | The new version must be published on GitHub as a **Release**; a commit alone doesn't count as an update. |
| The display stutters | Make the window smaller, close the STUDIO drawer, close other heavy applications. |

If you still can't solve it, write on the [Issues](../../issues) page, attaching the latest log file from `%APPDATA%\YTM-Audio-POC\logs`.

## 19. Running from source and development

Requirements: **Node.js 24+**, Git, Windows.

```bash
git clone https://github.com/dhurakisra/YouTube-Music-Studio.git
cd YouTube-Music-Studio
npm install
# put the AI models in the models/ folder:
#   models/htdemucs_fp16.onnx
#   models/umx-hq-vocals.onnx
npm start          # open the app
npm run smoke      # startup test (doesn't try session/audio)
```

Important files:

| Path | Contents |
|---|---|
| `src/main.js` | Main process: window, IPC, recording, MP3 encoding, update installation |
| `src/preload.js` | Everything injected into the YouTube Music page: steampunk theme, Studio drawer, audio engine (vocal chain, EQ, Key/Tempo), lyrics panel, television |
| `src/stem-process.js` | Stem separation with HT-Demucs/UMX (separate process) |
| `src/lyrics-sources.js` | Lyrics sources |
| `src/updater.js` | GitHub version check |
| `design/tex`, `design/fonts` | Visual textures and fonts (used at runtime) |
| `design/tools/*.py` | Visual asset cutting/generation scripts (Python + Pillow) |
| `PLAN.md`, `CONTRACT.md` | Development notes and contracts |

Important development notes: `preload.js` is sandboxed (code cannot load local files with `require`); YouTube Music blocks `innerHTML` (Trusted Types), so the DOM is built with the `h()` helper.

## 20. Publishing a new release

The installer is built with **electron-builder**; updates are distributed through **GitHub Releases**. Users' apps only see that there is a new version **once a Release is published**.

```bash
# 1) Bump the "version" field in package.json (e.g. 1.0.0 -> 1.1.0)
# 2) In build.publish, fill in owner and repo with your own GitHub repository details (once)
# 3) Build the installer locally (without publishing):
npm run dist                 # dist/YouTube-Music-Studio-Setup-<version>.exe

# 4) Upload to a GitHub Release (requires the GH_TOKEN environment variable: a personal access token with "repo" permission):
set GH_TOKEN=ghp_...         # PowerShell: $env:GH_TOKEN="ghp_..."
npm run dist:publish
```

`dist:publish` uploads the installer and the update info files (`latest.yml`, `.blockmap`) to a GitHub Release. Apps detect the new version by looking at this file. The AI models (≈ 180 MB) are embedded in the installer, so the installer is about 325 MB and is not kept in Git repositories (`models/` is in `.gitignore`).

> Note: The installer is currently **unsigned**; Windows SmartScreen may show a warning. Signing requires a code-signing certificate.

---

*License and acknowledgments:* fonts under SIL OFL 1.1; pitch shifting by [Signalsmith Stretch](https://github.com/Signalsmith-Audio/signalsmith-stretch) (MIT); stem separation models HT-Demucs and Open-Unmix.
