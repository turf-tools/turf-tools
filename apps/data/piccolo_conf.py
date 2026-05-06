from urllib.parse import urlparse

from piccolo.conf.apps import AppRegistry
from piccolo.engine.postgres import PostgresEngine

from src.settings import get_settings


def _postgres_config() -> dict[str, object]:
    database_url = get_settings().database_url
    if not database_url:
        raise RuntimeError("DATABASE_URL is required for Piccolo Postgres schema generation.")

    parsed = urlparse(database_url)
    return {
        "database": parsed.path.removeprefix("/"),
        "user": parsed.username,
        "password": parsed.password,
        "host": parsed.hostname,
        "port": parsed.port or 5432,
    }


DB = PostgresEngine(config=_postgres_config())
APP_REGISTRY = AppRegistry(apps=[])
