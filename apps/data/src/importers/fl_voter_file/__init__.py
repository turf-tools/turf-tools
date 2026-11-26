"""The Florida voter-file importer package.

Convention: each importer package defines its `Importer` in `importer.py`;
supporting stages (`decode`, `transform`, `manifest`) live in sibling modules.
This `__init__` just re-exports the importer class.
"""

from src.importers.fl_voter_file.importer import FlVoterFileImporter

__all__ = ["FlVoterFileImporter"]
