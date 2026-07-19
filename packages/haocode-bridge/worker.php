<?php

declare(strict_types=1);

use HaoCode\Sdk\Agent;
use HaoCode\Sdk\HaoCode;
use HaoCode\Sdk\HaoCodeConfig;
use HaoCode\Sdk\Message;
use HaoCode\Sdk\Runner;
use HaoCode\Sdk\RunOptions;

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
// OAuth bearer marker: the compat server sets provider.oauthBearer when the
// apiKey it sends is an OAuth access token (Anthropic subscription login)
// rather than a raw x-api-key. HaoCodeConfig forwards it to the SDK, which
// then sends Authorization: Bearer with the oauth beta header.
$oauthBearer = (bool) ($provider['oauthBearer'] ?? false);
// Extra provider request headers (e.g. the GitHub Copilot API headers set by
// the compat server). Forwarded verbatim to HaoCodeConfig's `headers` named
// parameter (added by the SDK alongside this change); omitted when empty so
// providers without extra headers never touch the parameter.
$providerHeaders = [];
if (is_array($provider['headers'] ?? null)) {
    foreach ($provider['headers'] as $headerName => $headerValue) {
        if (is_string($headerName) && $headerName !== '' && is_string($headerValue) && $headerValue !== '') {
            $providerHeaders[$headerName] = $headerValue;
        }
    }
}
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
// Sandbox runtime: when enabled with a provisioned baseRootfs, the SDK runs
// file/search/bash tools inside a tokimo VM and the smart-HITL decider can
// auto-approve contained actions (emitting auto_decision source:'sandbox').
// permissionMode stays on bypass_permissions: sandbox reroutes tool I/O,
// the permission check is orthogonal and still answered by hitlMode.
// normalizeSandbox lives before the try so its variable is in scope below;
// a bad sandbox request (missing baseRootfs, invalid memory/CPU) surfaces as
// a structured _fe_exception event instead of a PHP fatal error.
$agentDefinition = is_array($request['agent'] ?? null) ? $request['agent'] : null;
$agentName = normalizeString($agentDefinition['name'] ?? null);
$agentPrompt = normalizeString($agentDefinition['prompt'] ?? null);
$agentModel = is_array($agentDefinition['model'] ?? null)
    ? normalizeString($agentDefinition['model']['modelID'] ?? null)
    : null;
$configArguments = [
    'apiKey' => normalizeString($provider['apiKey'] ?? null),
    'model' => normalizeString($provider['model'] ?? null),
    'baseUrl' => normalizeString($provider['baseUrl'] ?? null),
    'providerType' => normalizeProviderType($provider['providerType'] ?? null),
    'maxTokens' => normalizePositiveInt($provider['maxTokens'] ?? null) ?? 8192,
    'cwd' => $cwd,
    'maxTurns' => $maxTurns,
    'maxBudgetUsd' => isset($request['maxBudgetUsd']) ? (float) $request['maxBudgetUsd'] : null,
    'permissionMode' => 'bypass_permissions',
    'allowedTools' => normalizeTools($request['allowedTools'] ?? null),
    'appendSystemPrompt' => $agentPrompt ?? normalizeString($request['appendSystemPrompt'] ?? null),
    'thinkingEnabled' => (bool) ($request['thinkingEnabled'] ?? false),
    'onThinking' => static fn (string $delta): mixed => emit(['type' => 'thinking', 'text' => $delta]),
    'ephemeral' => false,
    'sessionId' => $sessionId,
    'interruptOn' => $hitlMode === 'auto' ? [] : normalizeInterrupts($request['interruptOn'] ?? null),
    'enableAskUser' => true,
    'hitlMode' => $hitlMode,
    'hitlReviewModel' => $hitlReviewModel,
    'hitlAllowlistPath' => $hitlAllowlistPath,
    'oauthBearer' => $oauthBearer ? true : null,
];
if ($providerHeaders !== []) {
    $configArguments['headers'] = $providerHeaders;
}
// Image attachments (data URIs, file paths, URLs) for native multimodal input.
$images = [];
foreach (is_array($request['images'] ?? null) ? $request['images'] : [] as $image) {
    if (is_string($image) && trim($image) !== '') {
        $images[] = $image;
    }
}
if ($images !== []) {
    $configArguments['images'] = $images;
}
$config = new HaoCodeConfig(...$configArguments);
// First-class SDK Agent/Runner view of the same request (dogfooded by fresh
// runs below). Field mapping: run-invariant settings live on the Agent;
// per-run inputs (callbacks, images, cwd, budget, persistence) live on
// RunOptions. Only `sessionId` (session continuity) has no Agent/RunOptions
// counterpart — runs needing it fall back to the HaoCode facade.
// Agent.headers only exists in hao-code >= 1.16.0; gate it so the worker
// keeps running against older vendored SDKs (fresh runs then take the
// facade path for header-carrying providers, preserving header delivery).
$agentSupportsHeaders = property_exists(Agent::class, 'headers');
$agentArguments = [
    'name' => $agentName ?? 'haowork',
    'model' => $agentModel ?? $configArguments['model'],
    'apiKey' => $configArguments['apiKey'],
    'baseUrl' => $configArguments['baseUrl'],
    'providerType' => $configArguments['providerType'],
    'maxTokens' => $configArguments['maxTokens'],
    'maxTurns' => $configArguments['maxTurns'],
    'appendSystemPrompt' => $configArguments['appendSystemPrompt'],
    'thinkingEnabled' => $configArguments['thinkingEnabled'],
    'permissionMode' => $configArguments['permissionMode'],
    'allowedTools' => $configArguments['allowedTools'],
    'interruptOn' => $configArguments['interruptOn'],
    'enableAskUser' => $configArguments['enableAskUser'],
    'hitlMode' => $configArguments['hitlMode'],
    'hitlReviewModel' => $configArguments['hitlReviewModel'],
    'hitlAllowlistPath' => $configArguments['hitlAllowlistPath'],
    'oauthBearer' => $configArguments['oauthBearer'],
    'ephemeral' => false,
];
if ($agentSupportsHeaders) {
    $agentArguments['headers'] = $providerHeaders;
}
$agent = new Agent(...$agentArguments);
$runOptions = new RunOptions(
    onThinking: $configArguments['onThinking'],
    images: $images,
    ephemeral: false,
    cwd: $cwd,
    maxBudgetUsd: $configArguments['maxBudgetUsd'],
);

try {
    // Sandbox runtime: when enabled with a provisioned baseRootfs, the SDK runs
    // file/search/bash tools inside a tokimo VM and the smart-HITL decider can
    // auto-approve contained actions (emitting auto_decision source:'sandbox').
    // permissionMode stays on bypass_permissions: sandbox reroutes tool I/O,
    // the permission check is orthogonal and still answered by hitlMode.
    // normalizeSandbox runs inside the try so a bad sandbox request (missing
    // baseRootfs, invalid memory/CPU) surfaces as a structured _fe_exception
    // event instead of a PHP fatal error; when enabled, the shared config
    // (images/headers/agent fields included) is rebuilt with the sandbox set.
    $sandboxConfig = normalizeSandbox($request['sandbox'] ?? null);
    if ($sandboxConfig !== null) {
        $configArguments['sandbox'] = $sandboxConfig;
        $config = new HaoCodeConfig(...$configArguments);
        $agent = new Agent(...[...$agentArguments, 'sandbox' => $sandboxConfig]);
    }

    $action = normalizeString($request['action'] ?? null) ?? 'run';

    if ($action === 'resume_interrupt') {
        $interruptId = normalizeString($request['interruptId'] ?? null);
        if ($sessionId === null || $interruptId === null) {
            throw new InvalidArgumentException('resume_interrupt requires haocodeSessionId and interruptId.');
        }
        $decisions = is_array($request['decisions'] ?? null) ? $request['decisions'] : [];
        // Runner has no interrupt-resume API; the HaoCode facade path stays.
        $messages = HaoCode::streamResumeInterrupt($sessionId, $interruptId, $decisions, $config);
    } else {
        $prompt = normalizeString($request['prompt'] ?? null);
        if ($prompt === null) {
            throw new InvalidArgumentException('run requires a non-empty prompt.');
        }
        if ($sessionId === null && ($agentSupportsHeaders || $providerHeaders === [])) {
            // Fresh run: dogfood Runner::stream. It drives the same AgentLoop
            // as HaoCode::stream (which internally delegates to Runner), so
            // the emitted Message stream is identical. When the vendored SDK
            // predates Agent.headers, header-carrying runs keep the facade so
            // headers still reach the provider.
            $messages = Runner::stream($agent, $prompt, $runOptions);
        } else {
            // Session continuation ($sessionId redirects to a resumed
            // Conversation) is a HaoCodeConfig-only behavior — keep the facade.
            $messages = HaoCode::stream($prompt, $config);
        }
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

/**
 * Build a SandboxConfig from the worker request, or null when sandbox is
 * disabled. Mirrors normalizeHitlMode's "whitelist + fail-closed" style:
 * unknown enum values fall back to safe defaults (network -> blocked,
 * provider -> tokimo-or-disable). Only a missing baseRootfs on an enabled
 * tokimo request throws, and that error surfaces through the outer try/catch
 * as `_fe_exception: InvalidArgumentException` so the UI can show it.
 *
 * The binary path is intentionally NOT resolved here. It flows through the
 * SandboxConfig::tokimo() `binary` option when the caller provides one, but
 * production runs leave it null so the SDK's SandboxBinaryResolver picks up
 * the HAOCODE_SANDBOX_BINARY env that Electron injects at spawn time. This
 * keeps dev (resolver walks dev path / user cache) and packaged (env path)
 * on the same code path.
 *
 * @return \HaoCode\Sdk\Sandbox\SandboxConfig|null
 */
function normalizeSandbox(mixed $value): ?object
{
    if (! is_array($value) || ($value['enabled'] ?? false) === false) {
        return null;
    }
    $provider = normalizeString($value['provider'] ?? null) ?? 'tokimo';
    if ($provider !== 'tokimo') {
        // MVP only supports tokimo; unknown providers are disabled.
        return null;
    }
    $baseRootfs = normalizeString($value['baseRootfs'] ?? null);
    if ($baseRootfs === null) {
        throw new InvalidArgumentException('tokimo sandbox requires baseRootfs.');
    }
    $network = normalizeString($value['network'] ?? null);
    if (! in_array($network, ['blocked', 'allow-all'], true)) {
        $network = 'blocked';
    }
    $exclude = is_array($value['exclude'] ?? null)
        ? array_values(array_filter($value['exclude'], 'is_string'))
        : [];

    return \HaoCode\Sdk\Sandbox\SandboxConfig::tokimo(
        baseRootfs: $baseRootfs,
        mode: normalizeString($value['mode'] ?? null) ?? 'full',
        sync: normalizeString($value['sync'] ?? null) ?? 'upload-cwd',
        remoteCwd: normalizeString($value['remoteCwd'] ?? null) ?? '/workspace',
        cleanup: normalizeString($value['cleanup'] ?? null) ?? 'always',
        root: normalizeString($value['root'] ?? null),
        exclude: $exclude,
        binary: normalizeString($value['binary'] ?? null),
        vmDir: normalizeString($value['vmDir'] ?? null),
        memoryMb: normalizePositiveInt($value['memoryMb'] ?? null) ?? 4096,
        cpuCount: normalizePositiveInt($value['cpuCount'] ?? null) ?? 4,
        network: $network,
        startupTimeoutSeconds: normalizePositiveInt($value['startupTimeoutSeconds'] ?? null) ?? 30,
    );
}
