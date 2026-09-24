# Jibo TTS dictionary tool (v0.1.0)

This tool gives Jibo's on-robot text-to-speech a much bigger pronunciation dictionary.

## Why

The TTS service loads a single file: `voices/en_us_world/en_us_world.dictionary`. It holds about 29.5k words (46k entries), trimmed from the Combilex lexicon. Any other word falls to a rule-based guesser (G2P); examples include *colonel*, *yacht*, *island*, *debt*, *knight* and *psychology*.

The robot also ships `en_us_world.dictionary_full` (Combilex, about 131k words and 197k entries). It uses the same phone set and part-of-speech tags, but the TTS service never loads it.

`build` merges the two dictionaries. When both have the same word and part of speech, Jibo's curated entry wins. It then applies `fixes.txt`, a list of hand-checked corrections (for example *gills*, which Combilex pronounces "jills"). The output is about 203k entries, 131k words and 8 MB.

Every pronunciation is checked against `<voice>.phones` before it's written, and duplicate word + part-of-speech entries are dropped.

## Use (on the linux box)

```sh
python3 jibo_tts_dict.py build --voice-dir ~/jibo-tts/en_us_world --fixes fixes.txt --out ~/jibo-tts/en_us_world.dictionary.merged
python3 jibo_tts_dict.py lookup --dict ~/jibo-tts/en_us_world.dictionary.merged gills colonel
```

The build needs these three files in `--voice-dir`:

- `en_us_world.dictionary`
- `en_us_world.dictionary_full`
- `en_us_world.phones`

## Fixes file

Each line is `word | POS | stress phones|stress phones`, in the same format as the dictionary.

- Each syllable is a stress digit (0, 1 or 2) followed by phones from the `.phones` file.
- Syllables are separated by `|` with no spaces around it.
- A fix line replaces the entry for that word + POS, or adds it if there isn't one.

Example: `gills | NNS | 1 g iy lf z`

## Install and roll back

See the steps in handoff v8.1+. In short:

1. Back up the robot's dictionary.
2. Copy the merged file over it with `cp`, which keeps the file's owner and mode.
3. Reboot.

To roll back, restore the backup and reboot.
