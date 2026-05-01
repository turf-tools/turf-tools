"""Criteria DSL — Pydantic mirror of `apps/web/src/lib/filters.ts`.

The TS side owns editor UI + types; this side owns the same types plus
SQL compilation. New filter types touch both sides; everything else
stays single-sourced.
"""
