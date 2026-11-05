# DM ledger fixtures

A miniature bots root (`<bot>/dm/inbox.jsonl`, `outbox.jsonl`) in the v1 ledger format
(`shared/dm-schema.ts`, report 07 §5). Point a reader at this folder as the bots root.

- `the-fat-controller` sent a request (`...0001`, steered) to `bitzer`, who replied (`...0002`, started).
- `bitzer`'s inbox also holds a worker report (`...0003`), a reply from `sam` (`...0004`,
  written by the DMs tab: it keeps the thread's last hop, 2), and
  three lines a reader must skip: broken JSON, an unknown type/version, and an invalid message.
- `bitzer`'s outbox holds a refused PM-to-PM escalate (`...000R`, `not_allowed`).

Expected per file: valid records / unknown / invalid
- bitzer/dm/inbox.jsonl: 3 / 1 / 2
- bitzer/dm/outbox.jsonl: 4 / 0 / 0
- the-fat-controller/dm/inbox.jsonl: 1 / 0 / 0
- the-fat-controller/dm/outbox.jsonl: 2 / 0 / 0

`../dm-workers/` is a miniature bot-dm workers root (`~/.local/state/bot-dm/workers/<name>/`):
`wp1-bot-dm/outbox.jsonl` holds the worker report `...0003` and its `queued` and `started`
statuses, which the DMs view joins onto the copy in `bitzer`'s inbox.
