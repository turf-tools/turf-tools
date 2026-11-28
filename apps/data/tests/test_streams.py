"""Shared importer stream helpers."""

from __future__ import annotations

import zipfile

from src.importers.streams import is_zip_payload_member


def test_is_zip_payload_member_skips_macos_finder_junk() -> None:
    assert is_zip_payload_member(zipfile.ZipInfo("DAD_20260101.txt"))
    assert is_zip_payload_member(zipfile.ZipInfo("county/A-12634.csv"))
    assert not is_zip_payload_member(zipfile.ZipInfo("__MACOSX/._DAD_20260101.txt"))
    assert not is_zip_payload_member(zipfile.ZipInfo("._A-12634.csv"))
    assert not is_zip_payload_member(zipfile.ZipInfo("subdir/._nested.csv"))
    dir_info = zipfile.ZipInfo("folder/")
    dir_info.external_attr = 0x10 << 16
    assert not is_zip_payload_member(dir_info)
