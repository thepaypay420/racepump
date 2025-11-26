Pump Racers Audio Assets
========================

Drop your audio files in this folder to enable real sounds in the app.

Expected filenames
------------------

- lobby.mp3 (and optionally lobby.ogg) — Loopable lobby background music
- cash-register.ogg and cash-register.mp3 — Short cash register “cha-ching” sound for successful bet placement

Notes
-----

- Files are served from /audio/*. The app will automatically use these if present.
- If a file is missing, the app falls back to synthesized tones via the Web Audio API.
- Keep the lobby track reasonably small (<3–5 MB) and mastered for looping (trim silence at start/end).
- Prefer OGG/MP3 at 128–192 kbps for a balance of quality and size.
- Safari/iOS does not reliably play OGG. Provide an MP3 alongside OGG with the exact filenames above.

Suggestions (ensure proper license)
-----------------------------------

- Lobby music: light/elevator, lo-fi, synthwave, or chill house works well.
- Cash register SFX: a short “ka-ching” with good transient, ~0.2–0.6s.

Reminder: Verify license terms (CC0/public domain ideal). If attribution is required (e.g. CC BY), add it to your project README.

