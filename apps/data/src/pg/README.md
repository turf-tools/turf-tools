# PostgreSQL Database Types in Python

This file contains database types generated from the Drizzle schema.

To update them, have a local database running and run these commands from the root:

```bash
createdb field_tools_schema
DATABASE_URL="postgres://postgres@localhost:5432/field_tools_schema" pnpm data:pg-push
DATABASE_URL="postgres://postgres@localhost:5432/field_tools_schema" pnpm data:generate-pg-schema
dropdb field_tools_schema
```

This assumes you have PostgreSQL installed locally and a running server.
