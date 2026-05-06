from piccolo.table import Table
from piccolo.utils.pydantic import create_pydantic_model

from src.pg import tables


def _generated_tables() -> dict[str, type[Table]]:
    return {
        name: value
        for name, value in vars(tables).items()
        if isinstance(value, type) and issubclass(value, Table) and value is not Table
    }


PYDANTIC_MODELS = {name: create_pydantic_model(table) for name, table in _generated_tables().items()}
