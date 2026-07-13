"""The NYS voter-file importer package.

Convention: each importer package defines its `Importer` in `importer.py`;
supporting stages (`decode`, `transform`, `voting_history`, `manifest`) live in
sibling modules. This `__init__` just re-exports the importer class.
"""

from src.importers.nys_voter_file.importer import NysVoterFileImporter

__all__ = ["NysVoterFileImporter"]
