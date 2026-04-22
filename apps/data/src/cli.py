"""CLI entrypoints for the data package."""

from pathlib import Path

from hamilton import driver

from src.dags import geocode, quickwit, tiger, voter_file_loader


def _render(dr: driver.Driver, filename: str) -> None:
    docs = Path(__file__).resolve().parent.parent / "docs"
    docs.mkdir(exist_ok=True)
    path = str(docs / filename)
    dr.display_all_functions(path)
    print(f"Wrote {path}")


def update_visualizations() -> None:
    """Render all Hamilton graph visualizations into docs/."""
    _render(driver.Builder().with_modules(voter_file_loader).build(), "voter_file_loader_graph.png")
    _render(driver.Builder().with_modules(tiger).build(), "tiger_graph.png")
    _render(driver.Builder().with_modules(geocode).build(), "geocode_graph.png")
    _render(driver.Builder().with_modules(quickwit).build(), "quickwit_graph.png")
    _render(
        driver.Builder().with_modules(voter_file_loader, tiger, geocode, quickwit).build(),
        "pipeline_graph.png",
    )
