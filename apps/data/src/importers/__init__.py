"""Dataset importers.

An importer turns a source (a raw state voter-file distribution, an uploaded
CSV/parquet roster, …) into two things: the canonical ``persons_validated``
table and the field ``Manifest`` describing what's filterable/zonable in it.

The seam: everything *up to* ``persons_validated`` is importer-specific (source
decode, transform to the canonical `Person` schema, value canonicalization);
everything *below* it (geocode → matching → assembly → aggregate) is the shared
pipeline that doesn't care where the data came from.

Curated known-format importers (``nys_voter_file``, future state files) are the
premium tier — they bake the manifest and canonicalize values. The generic
mapping-driven importer is the coverage floor. Both emit the one `Manifest` the
rest of the app reads.
"""

from src.importers.base import EnumValue, FieldDef, FilterKind, Importer, Manifest

__all__ = ["EnumValue", "FieldDef", "FilterKind", "Importer", "Manifest"]
