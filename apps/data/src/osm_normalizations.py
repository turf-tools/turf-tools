"""OSM-specific street-name rewrites applied before tokenization.

Each entry is `(regex_pattern, replacement)`, applied as a chained
`regexp_replace` on the lowercased street string before
`osm._osm_raw_tokens` tokenizes it. Use this when OSM tags
a name in a form that won't tokenize the same way as TIGER's form
(after `address_tokens` equivalency expansion).

Convention: normalize the OSM string to **TIGER's form** — TIGER is
the source we can't change, and the voter side is already keyed off
TIGER's `street_name_tokens`. So "FDR Drive" (OSM) is rewritten to
"F D R Drive" because TIGER stores it as "F D R Dr" and the equivalency
table handles the `dr ↔ drive` part.

Add a new entry when you see voters falling back to `tiger_only` on a
specific named street where OSM clearly has the building tagged.
"""

OSM_STREET_REWRITES: list[tuple[str, str]] = [
    # FDR Drive: OSM uses "FDR Drive", "Fdr Drive Service Road West/East";
    # rare full-name variants "Franklin D Roosevelt Drive" / "Franklin
    # Delano Roosevelt Drive" also collapse to the same form.
    (r"\bfdr\b", "f d r"),
    (r"\bfranklin\s+d(?:elano)?\s+roosevelt\b", "f d r"),
]
