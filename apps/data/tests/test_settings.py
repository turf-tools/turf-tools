"""Where the dev DuckLake catalogs live."""

from __future__ import annotations

import pytest

from src.settings import Settings

EXTERNAL = "postgres://me:secret@db.example.com:5432/turf"


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch) -> None:
    for name in ("DATABASE_URL", "NODE_ENV", "DUCKLAKE_METADATA_POSTGRES_URL", "DUCKLAKE_GEO_METADATA_POSTGRES_URL"):
        monkeypatch.delenv(name, raising=False)


def _catalogs(settings: Settings) -> tuple[str | None, str | None]:
    return settings.ducklake_metadata_postgres_url, settings.ducklake_geo_metadata_postgres_url


def test_dev_catalogs_follow_a_shell_database_url(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("DATABASE_URL", EXTERNAL)
    assert _catalogs(Settings(_env_file=tmp_path / "none.env")) == (EXTERNAL, EXTERNAL)


def test_dev_catalogs_follow_a_database_url_in_env_file(tmp_path) -> None:
    env = tmp_path / ".env"
    env.write_text(f"DATABASE_URL={EXTERNAL}\n")
    assert _catalogs(Settings(_env_file=env)) == (EXTERNAL, EXTERNAL)


def test_dev_catalogs_default_to_the_docker_database(tmp_path) -> None:
    settings = Settings(_env_file=tmp_path / "none.env")
    assert _catalogs(settings) == (settings.database_url, settings.database_url)
    assert "127.0.0.1" in settings.database_url


def test_an_explicit_catalog_url_wins(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("DATABASE_URL", EXTERNAL)
    monkeypatch.setenv("DUCKLAKE_METADATA_POSTGRES_URL", "postgres://catalog")
    assert _catalogs(Settings(_env_file=tmp_path / "none.env")) == ("postgres://catalog", EXTERNAL)


def test_production_leaves_unset_catalogs_unset(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("NODE_ENV", "production")
    monkeypatch.setenv("DATABASE_URL", EXTERNAL)
    assert _catalogs(Settings(_env_file=tmp_path / "none.env")) == (None, None)
