# Sound effects

Unmodified samples from the user's local Lila checkout's `public/sound/standard`
theme: `Move.mp3`, `Capture.mp3`, and `GenericNotify.mp3`. These are byte-for-byte
identical to Infinite Chess's `dev-utils/sounds/lichess` samples (`move.mp3`,
`capture.mp3`, and `notify.mp3`).

Source: [Lila standard sounds](https://github.com/lichess-org/lila/tree/master/public/sound/standard).
Lila's [copying notice](https://github.com/lichess-org/lila/blob/master/COPYING.md)
excludes these standard sounds from its AGPL grant; Infinite Chess also records
their license as unknown. No AGPL license is claimed for these audio files.

Castling plays the move sample twice, 80 ms apart. Game start and result cues
use GenericNotify, matching the standard theme's result aliases. Check is silent,
matching the standard theme's Check alias to Silence.mp3.
