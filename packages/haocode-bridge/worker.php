<?php

declare(strict_types=1);

use HaoCode\Sdk\HaoCode;
use HaoCode\Sdk\HaoCodeConfig;
use HaoCode\Sdk\Message;

const DEFAULT_MAX_TURNS = PHP_INT_MAX;

$autoloadCandidates = array_filter([
    getenv('HAOWORK_HAOCODE_AUTOLOAD') ?: null,
    __DIR__.'/vendor/autoload.php',
    '/Users/wanghao/git/hao-code/vendor/autoload.php',
]);

foreach ($autoloadCandidates as $autoload) {
    if (is_string($autoload) && is_file($autoload)) {
        require $autoload;
        break;
    }
}

if (! class_exists(HaoCode::class)) {
    emit(['type' => 'error', 'error' => 'HaoCode Composer autoloader was not found.']);
    exit(2);
}

$raw = stream_get_contents(STDIN);
$request = is_string($raw) ? json_decode($raw, true) : null;
if (! is_array($request)) {
    emit(['type' => 'error', 'error' => 'Worker request must be valid JSON.']);
    exit(2);
}

$cwd = normalizeString($request['cwd'] ?? null) ?? (getcwd() ?: '/');
if (! is_dir($cwd)) {
    emit(['type' => 'error', 'error' => "Working directory does not exist: {$cwd}"]);
    exit(2);
}

$storagePath = normalizeString($request['storagePath'] ?? null);
if ($storagePath !== null) {
    if (! is_dir($storagePath) && ! mkdir($storagePath, 0700, true) && ! is_dir($storagePath)) {
        emit(['type' => 'error', 'error' => "Unable to create HaoCode storage path: {$storagePath}"]);
        exit(2);
    }
    putenv("HAOCODE_STORAGE_PATH={$storagePath}");
    $_ENV['HAOCODE_STORAGE_PATH'] = $storagePath;
    $_SERVER['HAOCODE_STORAGE_PATH'] = $storagePath;
}
$mcpSettingsPath = normalizeString($request['mcpSettingsPath'] ?? null);
if ($mcpSettingsPath !== null) {
    putenv("HAOCODE_GLOBAL_SETTINGS_PATH={$mcpSettingsPath}");
    $_ENV['HAOCODE_GLOBAL_SETTINGS_PATH'] = $mcpSettingsPath;
    $_SERVER['HAOCODE_GLOBAL_SETTINGS_PATH'] = $mcpSettingsPath;
}

$provider = is_array($request['provider'] ?? null) ? $request['provider'] : [];
$contextWindow = normalizePositiveInt($provider['contextWindow'] ?? null);
if ($contextWindow !== null) {
    $contextWindowValue = (string) $contextWindow;
    putenv("HAOCODE_CONTEXT_WINDOW={$contextWindowValue}");
    $_ENV['HAOCODE_CONTEXT_WINDOW'] = $contextWindowValue;
    $_SERVER['HAOCODE_CONTEXT_WINDOW'] = $contextWindowValue;
}
$sessionId = normalizeString($request['haocodeSessionId'] ?? null);
$maxTurns = normalizePositiveInt($request['maxTurns'] ?? null)
    ?? normalizePositiveInt(getenv('HAOWORK_HAOCODE_MAX_TURNS'))
    ?? DEFAULT_MAX_TURNS;
// HITL mode: ask, smart (default), or auto. Unknown values always fall back
// to smart. All smart/auto adjudication happens inside the HaoCode SDK; this
// worker only forwards the stream (including SDK-emitted auto_decision
// messages) and never decides an interrupt locally.
$hitlMode = normalizeHitlMode($request['hitlMode'] ?? null);
$hitlReviewModel = normalizeString($request['hitlReviewModel'] ?? null);
// User "Always Allow" rules persisted by the compatibility server; the SDK
// exact-matches trimmed Bash commands from this file before rule grading.
$hitlAllowlistPath = normalizeString($request['hitlAllowlistPath'] ?? null);
$config = new HaoCodeConfig(
    apiKey: normalizeString($provider['apiKey'] ?? null),
    model: normalizeString($provider['model'] ?? null),
    baseUrl: normalizeString($provider['baseUrl'] ?? null),
    providerType: normalizeProviderType($provider['providerType'] ?? null),
    maxTokens: normalizePositiveInt($provider['maxTokens'] ?? null) ?? 8192,
    cwd: $cwd,
    maxTurns: $maxTurns,
    maxBudgetUsd: isset($request['maxBudgetUsd']) ? (float) $request['maxBudgetUsd'] : null,
    permissionMode: 'bypass_permissions',
    allowedTools: normalizeTools($request['allowedTools'] ?? null),
    appendSystemPrompt: normalizeString($request['appendSystemPrompt'] ?? null),
    thinkingEnabled: (bool) ($request['thinkingEnabled'] ?? false),
    onThinking: static fn (string $delta): mixed => emit(['type' => 'thinking', 'text' => $delta]),
    ephemeral: false,
    sessionId: $sessionId,
    interruptOn: $hitlMode === 'auto' ? [] : normalizeInterrupts($request['interruptOn'] ?? null),
    enableAskUser: true,
    hitlMode: $hitlMode,
    hitlReviewModel: $hitlReviewModel,
    hitlAllowlistPath: $hitlAllowlistPath,
);

try {
    $action = normalizeString($request['action'] ?? null) ?? 'run';

    if ($action === 'resume_interrupt') {
        $interruptId = normalizeString($request['interruptId'] ?? null);
        if ($sessionId === null || $interruptId === null) {
            throw new InvalidArgumentException('resume_interrupt requires haocodeSessionId and interruptId.');
        }
        $decisions = is_array($request['decisions'] ?? null) ? $request['decisions'] : [];
        $messages = HaoCode::streamResumeInterrupt($sessionId, $interruptId, $decisions, $config);
    } else {
        $prompt = normalizeString($request['prompt'] ?? null);
        if ($prompt === null) {
            throw new InvalidArgumentException('run requires a non-empty prompt.');
        }
        $messages = HaoCode::stream($prompt, $config);
    }

    // Pure forwarding loop: the SDK settles smart/auto decisions internally
    // (emitting auto_decision messages for visibility) and resumes itself, so
    // the worker just relays every message until a terminal event arrives.
    $terminalEmitted = false;
    foreach ($messages as $message) {
        if (in_array($message->type, ['result', 'error', 'interrupt'], true)) {
            $terminalEmitted = true;
        }
        emitMessage($message);
    }
    if (! $terminalEmitted) {
        // Terminal-event contract: the run must end with result, error, or interrupt.
        emit(['type' => 'error', 'error' => 'Worker stream ended without a terminal event.']);
        exit(1);
    }
} catch (Throwable $exception) {
    emit([
        'type' => 'error',
        'error' => $exception->getMessage(),
        '_fe_exception' => $exception::class,
    ]);
    exit(1);
}

function emitMessage(Message $message): void
{
    if ($message->type === 'auto_decision') {
        emit(normalizeAutoDecisionMessage($message));
        return;
    }
    $payload = ['type' => $message->type];
    foreach ([
        'text', 'toolName', 'toolInput', 'toolOutput', 'toolIsError',
        'turnNumber', 'sessionId', 'usage', 'cost', 'error',
    ] as $property) {
        if ($message->{$property} !== null) {
            $payload[$property] = $message->{$property};
        }
    }
    if ($message->interrupt !== null) {
        $payload['interrupt'] = $message->interrupt->toArray();
    }
    emit($payload);
}

/**
 * Forward one SDK-native smart-HITL auto_decision message. The SDK already
 * settled (or escalated) the action; this only normalizes the wire shape.
 * Unknown enum values are mapped conservatively, matching the compatibility
 * server's fail-closed normalization: unknown decision -> reject, unknown
 * risk level -> high, unknown source -> rule.
 *
 * @return array<string, mixed>
 */
function normalizeAutoDecisionMessage(Message $message): array
{
    $decision = normalizeString($message->decision ?? null);
    if (! in_array($decision, ['approve', 'reject', 'escalate'], true)) {
        $decision = 'reject';
    }
    $source = normalizeString($message->source ?? null);
    if (! in_array($source, ['rule', 'review', 'batch', 'sandbox'], true)) {
        $source = 'rule';
    }
    $riskLevel = normalizeString($message->riskLevel ?? null);
    if (! in_array($riskLevel, ['low', 'medium', 'high', 'critical'], true)) {
        $riskLevel = 'high';
    }

    return [
        'type' => 'auto_decision',
        'sessionId' => normalizeString($message->sessionId ?? null),
        'interruptId' => normalizeString($message->interruptId ?? null),
        'actionId' => normalizeString($message->actionId ?? null) ?? 'unknown',
        'toolName' => normalizeString($message->toolName ?? null),
        'toolInput' => is_array($message->toolInput ?? null) ? $message->toolInput : [],
        'decision' => $decision,
        'source' => $source,
        'riskLevel' => $riskLevel,
        'reason' => is_string($message->reason ?? null) ? $message->reason : '',
    ];
}

function emit(array $payload): void
{
    $encoded = json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    if ($encoded === false) {
        $encoded = '{"type":"error","error":"Worker could not encode an event."}';
    }
    fwrite(STDOUT, $encoded."\n");
    fflush(STDOUT);
}

function normalizeString(mixed $value): ?string
{
    if (! is_string($value)) {
        return null;
    }
    $value = trim($value);
    return $value !== '' ? $value : null;
}

function normalizePositiveInt(mixed $value): ?int
{
    $value = filter_var($value, FILTER_VALIDATE_INT);
    return is_int($value) && $value > 0 ? $value : null;
}

function normalizeProviderType(mixed $value): ?string
{
    $value = normalizeString($value);
    return in_array($value, ['anthropic', 'openai', 'openai_chat'], true) ? $value : null;
}

/** @return 'ask'|'smart'|'auto' */
function normalizeHitlMode(mixed $value): string
{
    $value = normalizeString($value);
    return in_array($value, ['ask', 'smart', 'auto'], true) ? $value : 'smart';
}

/** @return string[] */
function normalizeTools(mixed $value): array
{
    if (! is_array($value)) {
        return ['Read', 'Write', 'Edit', 'apply_patch', 'Glob', 'Grep', 'Bash', 'LSP', 'TodoWrite', 'Skill', 'MemoryRead', 'MemoryWrite', 'AskUserQuestion'];
    }
    return array_values(array_filter($value, static fn (mixed $tool): bool => is_string($tool) && trim($tool) !== ''));
}

/** @return array<string, array<string, mixed>|bool> */
function normalizeInterrupts(mixed $value): array
{
    if (is_array($value)) {
        return $value;
    }
    return [
        'Bash' => [
            'allowedDecisions' => ['approve', 'edit', 'reject'],
            'description' => 'Review this shell command before it runs.',
        ],
        'Write' => [
            'allowedDecisions' => ['approve', 'edit', 'reject'],
            'description' => 'Review this file write before it runs.',
        ],
        'Edit' => [
            'allowedDecisions' => ['approve', 'edit', 'reject'],
            'description' => 'Review this file edit before it runs.',
        ],
        'apply_patch' => [
            'allowedDecisions' => ['approve', 'edit', 'reject'],
            'description' => 'Review this patch before it runs.',
        ],
    ];
}
