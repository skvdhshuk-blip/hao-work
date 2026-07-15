# HaoCode bridge

This package is the PHP execution boundary used by Hao Work. `worker.php` reads one JSON request from stdin, streams JSON-lines events to stdout, and exits after the HaoCode run or interrupt continuation completes.

Development can use `HAOWORK_HAOCODE_AUTOLOAD=/path/to/hao-code/vendor/autoload.php`. Packaged builds install the locked Composer dependencies into this directory and point the worker at the bundled PHP runtime.

Long-running tasks have no practical turn limit by default (`PHP_INT_MAX`). A positive `maxTurns` value in a worker request takes precedence; otherwise `HAOWORK_HAOCODE_MAX_TURNS` can impose a process-wide finite limit. Invalid and non-positive values fall back to the next valid level. Users can still stop an active run through Hao Work's abort control.
