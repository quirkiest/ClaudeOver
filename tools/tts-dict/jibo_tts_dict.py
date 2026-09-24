#!/usr/bin/env python3
"""Jibo TTS dictionary tool (ClaudeOver).

Builds a larger pronunciation dictionary for Jibo's on-robot TTS by merging the
dictionary it loads (en_us_world.dictionary, ~29k words) with the unused Combilex
lexicon shipped alongside it (en_us_world.dictionary_full, ~197k entries), then
applies a small hand-checked fixes file (e.g. gills: "jills" -> "gills").

Standard library only. Run on the linux box against copies of the robot's files.

  python3 jibo_tts_dict.py build --voice-dir ./en_us_world --fixes fixes.txt --out en_us_world.dictionary.merged
  python3 jibo_tts_dict.py lookup --dict ./en_us_world/en_us_world.dictionary gills gill water
"""
import argparse
import collections
import hashlib
import sys

VERSION = "0.1.0"

SEP = " | "


def load_phones(path):
    """Phone symbols from <voice>.phones (first column of non-comment lines), lower-cased."""
    phones = set()
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            phones.add(line.split()[0].lower())
    return phones


def parse_line(line):
    """Return (word, pos, pron) in the loaded-dictionary format, or None for comments/blank.

    Loaded format:  word | POS | 1 w o|0 dt ah r
    Full format:    word | POS | 1 w o | 0 dt ah r   (spaces around the syllable bar)
    Both use ' | ' between fields, so split off word and POS first, then normalise the rest.
    """
    line = line.rstrip("\n")
    if not line.strip() or line.lstrip().startswith("#"):
        return None
    parts = line.split(SEP, 2)
    if len(parts) != 3:
        return None
    word, pos, pron = parts[0].strip(), parts[1].strip(), parts[2].strip()
    if not word or not pos or not pron:
        return None
    if pron != "G2P":
        pron = "|".join(seg.strip() for seg in pron.split("|"))
    return word, pos, pron


def valid_pron(pron, phones):
    """Each syllable must be '<stress 0-2> <phone> <phone> ...' using known phones."""
    if pron == "G2P":
        return True
    for syl in pron.split("|"):
        toks = syl.split()
        if len(toks) < 2 or toks[0] not in ("0", "1", "2"):
            return False
        if any(t not in phones for t in toks[1:]):
            return False
    return True


def read_dict(path, phones, stats, label):
    entries = collections.OrderedDict()
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            parsed = parse_line(line)
            if parsed is None:
                continue
            word, pos, pron = parsed
            if not valid_pron(pron, phones):
                stats[f"{label}_invalid"] += 1
                continue
            key = (word, pos)
            if key in entries:
                stats[f"{label}_duplicate"] += 1
                continue
            entries[key] = pron
    return entries


def read_fixes(path, phones):
    """Fixes file: same 'word | POS | pron' lines. They replace (or add) that word+POS."""
    fixes = collections.OrderedDict()
    with open(path, encoding="utf-8") as fh:
        for n, line in enumerate(fh, 1):
            parsed = parse_line(line)
            if parsed is None:
                continue
            word, pos, pron = parsed
            if not valid_pron(pron, phones):
                sys.exit(f"fixes line {n}: invalid pronunciation: {line.strip()}")
            fixes[(word, pos)] = pron
    return fixes


def md5(path):
    h = hashlib.md5()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def cmd_build(args):
    vd = args.voice_dir.rstrip("/")
    name = vd.split("/")[-1]
    phones = load_phones(f"{vd}/{name}.phones")
    stats = collections.Counter()
    loaded_path = args.base or f"{vd}/{name}.dictionary"
    main = read_dict(loaded_path, phones, stats, "loaded")
    full = read_dict(f"{vd}/{name}.dictionary_full", phones, stats, "full")
    fixes = read_fixes(args.fixes, phones) if args.fixes else {}

    merged = collections.OrderedDict(main)            # Jibo's curated entries win
    for key, pron in full.items():                    # add Combilex entries it lacks
        if key not in merged:
            merged[key] = pron
            stats["added_from_full"] += 1
    for key, pron in fixes.items():                   # hand-checked fixes win over both
        if merged.get(key) != pron:
            stats["fixes_applied"] += 1
        merged[key] = pron

    with open(args.out, "w", encoding="utf-8", newline="\n") as out:
        for (word, pos), pron in merged.items():
            out.write(f"{word}{SEP}{pos}{SEP}{pron}\n")

    words = {w for w, _ in merged}
    print(f"jibo_tts_dict {VERSION}")
    print(f"  base    {loaded_path}  md5 {md5(loaded_path)}  entries {len(main)}")
    print(f"  full    {vd}/{name}.dictionary_full  entries {len(full)}")
    print(f"  fixes   {args.fixes or '-'}  entries {len(fixes)}")
    print(f"  output  {args.out}  entries {len(merged)}  words {len(words)}  md5 {md5(args.out)}")
    for k in sorted(stats):
        print(f"  {k}: {stats[k]}")


def cmd_lookup(args):
    wanted = {w.lower() for w in args.words}
    with open(args.dict, encoding="utf-8") as fh:
        for line in fh:
            parsed = parse_line(line)
            if parsed and parsed[0].lower() in wanted:
                print(f"{parsed[0]}{SEP}{parsed[1]}{SEP}{parsed[2]}")


def main():
    ap = argparse.ArgumentParser(description=f"Jibo TTS dictionary tool {VERSION}")
    ap.add_argument("--version", action="version", version=VERSION)
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build", help="merge loaded + full dictionaries and apply fixes")
    b.add_argument("--voice-dir", required=True, help="copy of .../ttsservice/voices/en_us_world")
    b.add_argument("--base", help="dictionary to start from (default <voice>.dictionary)")
    b.add_argument("--fixes", help="hand-checked fixes file")
    b.add_argument("--out", required=True)
    b.set_defaults(func=cmd_build)
    lk = sub.add_parser("lookup", help="show entries for words")
    lk.add_argument("--dict", required=True)
    lk.add_argument("words", nargs="+")
    lk.set_defaults(func=cmd_lookup)
    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
