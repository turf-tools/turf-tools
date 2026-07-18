"""Importer registry — maps a dataset's `importer` name to its class.

Kept in its own module (not `importers/__init__`) so importing the base contract
doesn't pull in every concrete importer, which would cycle back through
`src.tables`. The import job and seed CLI resolve importers through here.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from src.importers.nys_voter_file import NysVoterFileImporter

if TYPE_CHECKING:
    from src.importers.base import Importer

IMPORTERS: dict[str, type[Importer]] = {
    NysVoterFileImporter.name: NysVoterFileImporter,
}


def get_importer(name: str) -> type[Importer]:
    """Resolve an importer name (as stored on `datasets.importer`) to its class."""
    importer = IMPORTERS.get(name)
    if importer is None:
        raise ValueError(f"Unknown importer: {name!r} (known: {sorted(IMPORTERS)})")
    return importer
