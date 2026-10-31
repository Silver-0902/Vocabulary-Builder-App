"""Build a fill-in-the-blank version of a card's example sentence.
Returns (sentence_with_blank, answer_as_written) or None when the headword
cannot be found in the example (the card then falls back to a normal flashcard)."""
import re

def _alts(en):
    out = []
    for part in re.split(r"\s*/\s*", en):
        p = re.sub(r"[…]|\.\.\.|\?|\+|\(.*?\)", " ", part)
        p = re.sub(r"\b(sb|sth|someone|something|one's|your)\b", " ", p, flags=re.I)
        p = re.sub(r"\s+", " ", p).strip(" ,.;")
        if len(p) >= 3:
            out.append(p)
    return out

def make_cloze(en, ex):
    if not ex:
        return None
    for alt in sorted(_alts(en), key=len, reverse=True):
        m = re.search(r"(?<![\w'])" + re.escape(alt) + r"(?![\w'])", ex, flags=re.I)
        if m:
            return ex[:m.start()] + "_____" + ex[m.end():], m.group(0)
    # inflected form: use the longest word of the headword as a stem
    for alt in _alts(en):
        words = sorted([w for w in re.split(r"[^A-Za-z']+", alt) if len(w) > 3], key=len, reverse=True)
        for w in words:
            stem = w[: max(4, len(w) - 3)]
            m = re.search(r"(?<![\w'])" + re.escape(stem) + r"\w*", ex, flags=re.I)
            if m:
                return ex[:m.start()] + "_____" + ex[m.end():], m.group(0)
    return None
