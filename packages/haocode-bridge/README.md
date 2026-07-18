# HaoCode bridge

This package is the PHP execution boundary used by Hao Work. `worker.php` reads one JSON request from stdin, streams JSON-lines events to stdout, and exits after the HaoCode run or interrupt continuation completes.

Development can use `HAOWORK_HAOCODE_AUTOLOAD=/path/to/hao-code/vendor/autoload.php`. Packaged builds install the locked Composer dependencies into this directory and point the worker at the bundled PHP runtime.

Long-running tasks have no practical turn limit by default (`PHP_INT_MAX`). A positive `maxTurns` value in a worker request takes precedence; otherwise `HAOWORK_HAOCODE_MAX_TURNS` can impose a process-wide finite limit. Invalid and non-positive values fall back to the next valid level. Users can still stop an active run through Hao Work's abort control.

## HITL modes

The worker accepts optional `hitlMode` / `hitlReviewModel` request fields and forwards them to the SDK's `HaoCodeConfig`. Missing or invalid `hitlMode` values fall back to `ask`. All classification, guardian review, and batch settlement are enforced **inside the HaoCode SDK** (`HaoCode\Services\Hitl`, since v1.12.0); the worker only passes configuration and translates stream events.

- `ask` (default): every configured tool interrupt is emitted for human approval.
- `smart`: the SDK classifies each interrupt batch by deterministic rule (`HitlPolicy`), sends gray-zone actions to a guardian review (`HitlReviewer`, a tool-less `HaoCode::structured()` call with a 30-second budget, using `hitlReviewModel` or the run's model), and auto-settles batches it can; anything red-lined, malformed, unsure, or circuit-broken escalates to a human with a per-action reason. Automatically settled actions never produce an interrupt.
- `auto`: tool interrupts are auto-approved; `AskUserQuestion` still interrupts in every mode.

Each decided action produces one event line on the stream (emitted by the SDK, forwarded verbatim):

```
{"type":"auto_decision","sessionId":"...","interruptId":"...","actionId":"...","toolName":"...","toolInput":{...},"decision":"approve|reject|escalate","source":"rule|review|batch","riskLevel":"low|medium|high|critical","reason":"..."}
```

`escalate` events precede an interrupt that needs a human; their `reason` carries a machine-readable prefix family (`rule:red_line:…`, `rule:ask:…`, `review:unavailable:…`, `review:unsure`, `batch:escalated`, `batch:circuit_breaker`).

## Tests

- `node --test worker.test.mjs` — worker protocol tests against a fake autoloader.
- SDK-side policy, reviewer, and decider tests live in the hao-code repository (`tests/Unit/Hitl/`, `tests/Feature/SmartHitlModeTest.php`).
