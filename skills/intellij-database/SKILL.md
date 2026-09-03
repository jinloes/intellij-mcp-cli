---
name: intellij-database
description: Use ijctl for IntelliJ database connection and schema discovery, defaulting to read-only SQL and requiring explicit authorization for every database mutation.
---

Use this skill after `intellij-mcp-tools` has selected the project and server.
Keep the same `--project` and `--server` values.

## Read first

List connections before querying:

```sh
ijctl --project PROJECT --server SERVER database connections
```

Use `tools --query database` and `describe TOOL` for live schema-discovery tools
that are not wrapped. Never expose credentials, connection properties, or
unrelated environment values.

Execute reviewed SQL as text or from a file:

```sh
ijctl --project PROJECT --server SERVER database query \
  --connection ID --database NAME --schema NAME --query "SELECT ..."

ijctl --project PROJECT --server SERVER database query \
  --connection ID --database NAME --schema NAME --query-file query.sql
```

## Mutation safeguards

The CLI conservatively classifies database tools as `database`; it does not
parse SQL to determine whether a statement is read-only. Default to bounded
`SELECT`, metadata, and explain queries. Require explicit user authorization
for the exact target and statement before DDL, DML, transaction control,
procedure calls, or any other mutation. Never infer production authorization
from connection visibility. Do not automatically retry a query that may have
been delivered.

If the alias schema changed, inspect the live tool and use generic `call`
without weakening these safeguards.
