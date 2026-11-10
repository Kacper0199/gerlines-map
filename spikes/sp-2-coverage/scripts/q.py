"""Run SQL statements with DuckDB and print each result.

Usage: python -I q.py <workdir> <sql> [<sql> ...]
"""

import os
import sys

import duckdb

os.chdir(sys.argv[1])
con = duckdb.connect()
for statement in sys.argv[2:]:
    result = con.sql(statement)
    if result is not None:
        result.show(max_rows=200, max_width=220)
