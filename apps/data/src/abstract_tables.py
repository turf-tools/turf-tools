"""Abstract table catalog + placeholder substitution.

Endpoint SQL templates reference logical table names like
`{persons_geocoded}` instead of hard-coded FQNs. Resolution to the real
DuckLake fully-qualified name (e.g. `ducklake.main.default_persons_geocoded`)
happens at execution time, per-tenant, via `resolve(sql, slug)`.

This is the only place that knows what's attached and how. Endpoints
build SQL, call `resolve`, and execute — never spelling out catalog or
schema names directly.
"""

import re

# Maps abstract table names to FQN templates. `{slug}` is filled per-tenant.
# Add new entries here as new abstract tables are exposed to web's queries.
ABSTRACT_TABLES: dict[str, str] = {
    "persons_geocoded": "ducklake.main.{slug}_persons_geocoded",
    "buildings_geocoded": "ducklake.main.{slug}_buildings_geocoded",
    "doors_geocoded": "ducklake.main.{slug}_doors_geocoded",
}

# Matches `{abstract_name}` where `abstract_name` is lowercase letters
# and underscores. Anchored on `{...}` so it can't accidentally match
# bare column names or string literals.
_PLACEHOLDER_RE = re.compile(r"\{([a-z_]+)\}")


class UnknownAbstractTableError(KeyError):
    """A placeholder referenced an abstract table not in the catalog."""


def resolve(sql: str, slug: str) -> str:
    """Replace `{abstract_name}` placeholders in `sql` with the resolved
    FQN for `slug`. Raises `UnknownAbstractTableError` if any placeholder
    isn't in the catalog — fail loud rather than silently leave a
    `{...}` token in the executed SQL.
    """

    def _replace(m: re.Match[str]) -> str:
        name = m.group(1)
        template = ABSTRACT_TABLES.get(name)
        if template is None:
            raise UnknownAbstractTableError(name)
        return template.format(slug=slug)

    return _PLACEHOLDER_RE.sub(_replace, sql)
