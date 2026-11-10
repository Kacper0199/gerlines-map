"""Send a migration file the way the TypeScript runner does (packages/db/src/migrations.ts).

``packages/db/src/split-golden.json`` records how the runner splits its cases and every committed
migration file; the tests of both languages compare against it.
"""

import re

NO_TRANSACTION = "-- gerlines:no-transaction"
_DOLLAR_TAG = re.compile(r"\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$")
_IDENTIFIER_CHAR = re.compile(r"[A-Za-z0-9_$]")


def _skip_block_comment(sql: str, i: int) -> int:
    depth = 0
    while i < len(sql):
        if sql.startswith("/*", i):
            depth += 1
            i += 2
        elif sql.startswith("*/", i):
            depth -= 1
            i += 2
            if depth == 0:
                return i
        else:
            i += 1
    return len(sql)


def _skip_line_comment(sql: str, i: int) -> int:
    end = sql.find("\n", i)
    return len(sql) if end == -1 else end + 1


def _skip_quoted(sql: str, i: int, quote: str, *, backslash_escapes: bool) -> int:
    i += 1
    while i < len(sql):
        if backslash_escapes and sql[i] == "\\":
            i += 2
        elif sql[i] == quote:
            if sql[i + 1 : i + 2] != quote:
                return i + 1
            i += 2
        else:
            i += 1
    return len(sql)


def _is_identifier_char(char: str) -> bool:
    return bool(char) and _IDENTIFIER_CHAR.fullmatch(char) is not None


def _skip_token(sql: str, i: int) -> int:
    char = sql[i]
    previous = sql[i - 1] if i > 0 else ""
    if sql.startswith("--", i):
        return _skip_line_comment(sql, i)
    if sql.startswith("/*", i):
        return _skip_block_comment(sql, i)
    if char == "'":
        before = sql[i - 2] if i > 1 else ""
        escape_string = previous in ("E", "e") and not _is_identifier_char(before)
        return _skip_quoted(sql, i, "'", backslash_escapes=escape_string)
    if char == '"':
        return _skip_quoted(sql, i, '"', backslash_escapes=False)
    if char == "$" and not _is_identifier_char(previous) and (tag := _DOLLAR_TAG.match(sql, i)):
        end = sql.find(tag.group(), tag.end())
        return len(sql) if end == -1 else end + len(tag.group())
    return i + 1


def _strip_leading_comments(statement: str) -> str:
    rest = statement.lstrip()
    while True:
        if rest.startswith("--"):
            rest = rest[_skip_line_comment(rest, 0) :].lstrip()
        elif rest.startswith("/*"):
            rest = rest[_skip_block_comment(rest, 0) :].lstrip()
        else:
            return rest


def _has_content(statement: str) -> bool:
    return _strip_leading_comments(statement).removeprefix(";").strip() != ""


def split_statements(sql: str) -> list[str]:
    """Split on top-level semicolons, ignoring those in quotes, dollar bodies and comments, and
    drop parts that hold only comments or whitespace."""
    statements: list[str] = []
    start = i = 0
    while i <= len(sql):
        if i == len(sql) or sql[i] == ";":
            statement = sql[start : i + 1].strip()
            if _has_content(statement):
                statements.append(statement)
            i += 1
            start = i
        else:
            i = _skip_token(sql, i)
    return statements


def migration_statements(sql: str) -> list[str]:
    """The whole file as one string, or each statement alone for a no-transaction file."""
    if sql.split("\n", 1)[0].strip() == NO_TRANSACTION:
        return split_statements(sql)
    return [sql]
