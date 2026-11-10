# photo-review

A small local page to approve or reject vehicle photos from Wikimedia Commons (WP-6.3). It shows the candidates of
each series with the author, licence, size and Commons link, and records each decision with a reason in
[`catalog/photos.yaml`](../../catalog/photos.yaml) as a maintainer's review (`by: user`, `user_review: done`). The code is
`gerlines_catalog.photo_review` in [pipelines/catalog](../../pipelines/catalog/README.md).

## Use

```bash
tools/photo-review/photo-review                  # http://127.0.0.1:8791/
GERLINES_DATA=/path/to/main/data tools/photo-review/photo-review   # from a worktree
```

It needs `data/photos/candidates.json` from `uv run gerlines-catalog photos candidates`. Thumbnails load from
Wikimedia's servers in your browser. Approve at most two photos per series; rank 1 is the photo the train card
shows. The focus field (`x,y` between 0 and 1) moves the crop of the 3 by 2 frame.

After deciding, store and check the copies, then load them:

```bash
uv run gerlines-catalog photos store     # 330 and 960 px copies of new approvals into data/photos/
uv run gerlines-catalog photos check     # every approved photo has its credit and verified copies
DATABASE_URL=... uv run gerlines-catalog photos load
```

`load` publishes only the photos you reviewed (`user_review: done`). A pre-selected pick stays out until you
approve or reject it here; `load --include-pending` loads the picks too, for development and screenshots only.

The same decisions work without the page:
`uv run gerlines-catalog photos approve <series_id> "File:…" --reason "…"` (or `reject`).

## Safety

The server listens on 127.0.0.1 only, refuses requests for any other host name and accepts a decision only with
the random token of the running server, so other sites open in the browser cannot post decisions. Every text from
Commons is HTML escaped.
