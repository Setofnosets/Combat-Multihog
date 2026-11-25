/**
 * python-bootstrap.js — Pure ESM definitions and self-contained Python 3
 * sandbox bootstrap for Combat-Multihog Phase 2 Game Scripts (Pyodide).
 *
 * Pure ESM module: zero SillyTavern, DOM, or Node imports.
 */

export const PYTHON_ALLOWED_MODULES = Object.freeze([
    'math',
    're',
    'json',
    'random',
    'datetime',
    'collections',
    'itertools',
    'functools',
    'dataclasses',
    'copy',
    'statistics',
    'string',
    'typing',
    'enum',
    'decimal',
    'fractions',
]);

export const PYTHON_HOOK_ALIASES = Object.freeze({
    initState: 'init_state',
    onBeforeGenerate: 'on_before_generate',
    onToolCall: 'on_tool_call',
    onAfterGenerate: 'on_after_generate',
    renderMemo: 'render_memo',
});

export const PYTHON_RESULT_KEY_ALIASES = Object.freeze({
    memo_block: 'memoBlock',
    prompt_injection: 'promptInjection',
    tool_result: 'toolResult',
    strip_command: 'stripCommand',
    portrait_url: 'portraitUrl',
    append_markdown: 'appendMarkdown',
});

const allowedModulesPy = PYTHON_ALLOWED_MODULES.map((mod) => `'${mod}'`).join(', ');
const hookAliasesPy = Object.entries(PYTHON_HOOK_ALIASES)
    .map(([jsName, pyName]) => `    '${jsName}': '${pyName}',`)
    .join('\n');
const resultAliasesPy = Object.entries(PYTHON_RESULT_KEY_ALIASES)
    .map(([snakeKey, camelKey]) => `    '${snakeKey}': '${camelKey}',`)
    .join('\n');

export const PYTHON_SANDBOX_BOOTSTRAP = `import builtins as _builtins
import inspect as _inspect
import json as _json

ALLOWED_MODULES = frozenset((${allowedModulesPy}))

HOOK_ALIASES = {
${hookAliasesPy}
}

RESULT_KEY_ALIASES = {
${resultAliasesPy}
}

_MAX_LOGS = 100

_BLOCKED_DUNDER_ATTRS = frozenset((
    '__subclasses__',
    '__globals__',
    '__builtins__',
    '__code__',
    '__closure__',
    '__import__',
    '__loader__',
    '__spec__',
))

_SAFE_BUILTIN_NAMES = (
    'abs', 'all', 'any', 'bool', 'chr', 'dict', 'divmod', 'enumerate',
    'filter', 'float', 'frozenset', 'hasattr', 'hash', 'hex', 'int',
    'isinstance', 'issubclass', 'iter', 'len', 'list', 'map', 'max',
    'min', 'next', 'object', 'ord', 'pow', 'range', 'repr', 'reversed',
    'round', 'set', 'slice', 'sorted', 'str', 'sum', 'tuple', 'type', 'zip',
    'Exception', 'ValueError', 'TypeError', 'KeyError', 'IndexError',
    'RuntimeError', 'ZeroDivisionError', 'StopIteration', 'AttributeError',
    'AssertionError', 'True', 'False', 'None', '__build_class__',
)

_REAL_IMPORT = _builtins.__import__
_REAL_GETATTR = _builtins.getattr
_REAL_HASATTR = _builtins.hasattr


def _make_safe_import():
    def _safe_import(name, globals=None, locals=None, fromlist=(), level=0):
        if level != 0:
            raise ImportError(f"Relative imports are not allowed in the Game Scripts sandbox: '{name}'")
        if not isinstance(name, str) or not name:
            raise ImportError("Module name must be a non-empty string")
        top_level = name.split('.', 1)[0]
        if top_level not in ALLOWED_MODULES:
            raise ImportError(f"Module '{name}' is not allowed in the Game Scripts sandbox")
        return _REAL_IMPORT(name, globals, locals, fromlist, level)

    return _safe_import


def _safe_getattr(obj, name, *default):
    if isinstance(name, str) and name in _BLOCKED_DUNDER_ATTRS:
        raise AttributeError(f"Access to restricted attribute '{name}' is not allowed in the Game Scripts sandbox")
    return _REAL_GETATTR(obj, name, *default)


def _safe_hasattr(obj, name):
    if isinstance(name, str) and name in _BLOCKED_DUNDER_ATTRS:
        return False
    return _REAL_HASATTR(obj, name)


def _build_safe_builtins(logs):
    safe_builtins = {}
    for _name in _SAFE_BUILTIN_NAMES:
        if hasattr(_builtins, _name):
            safe_builtins[_name] = _REAL_GETATTR(_builtins, _name)

    def _safe_print(*args, sep=' ', end='\\n', file=None, flush=False):
        if len(logs) >= _MAX_LOGS:
            return
        sep_str = ' ' if sep is None else str(sep)
        line = sep_str.join(str(arg) for arg in args)
        if end is not None and end != '\\n':
            line = f"{line}{end}".rstrip('\\n')
        logs.append(line)

    safe_builtins['__import__'] = _make_safe_import()
    safe_builtins['getattr'] = _safe_getattr
    safe_builtins['hasattr'] = _safe_hasattr
    safe_builtins['print'] = _safe_print
    return safe_builtins


def _call_with_accepted_args(fn, candidate_args):
    try:
        sig = _inspect.signature(fn)
    except (ValueError, TypeError):
        return fn(*candidate_args)

    params = list(sig.parameters.values())
    has_var_positional = any(
        p.kind == _inspect.Parameter.VAR_POSITIONAL for p in params
    )
    if has_var_positional:
        return fn(*candidate_args)

    max_positional = sum(
        1
        for p in params
        if p.kind in (
            _inspect.Parameter.POSITIONAL_ONLY,
            _inspect.Parameter.POSITIONAL_OR_KEYWORD,
        )
    )
    min_positional = sum(
        1
        for p in params
        if p.kind in (
            _inspect.Parameter.POSITIONAL_ONLY,
            _inspect.Parameter.POSITIONAL_OR_KEYWORD,
        )
        and p.default is _inspect.Parameter.empty
    )

    if len(candidate_args) <= max_positional:
        return fn(*candidate_args)

    trimmed = candidate_args[:max_positional]
    if len(trimmed) < min_positional:
        return fn(*candidate_args)
    return fn(*trimmed)


def _invoke_hook(hook_fn, hook_name, payload):
    ctx = payload.get('ctx', {})
    if ctx is None:
        ctx = {}
    state = payload.get('state')
    call = payload.get('call', {})
    if call is None:
        call = {}

    if hook_name == 'initState':
        return _call_with_accepted_args(hook_fn, (ctx,))
    if hook_name == 'onToolCall':
        return _call_with_accepted_args(hook_fn, (state, call, ctx))
    if hook_name in ('onBeforeGenerate', 'onAfterGenerate', 'renderMemo'):
        return _call_with_accepted_args(hook_fn, (state, ctx))
    return _call_with_accepted_args(hook_fn, (state, ctx))


def _normalize_result(value):
    if isinstance(value, dict):
        normalized = {}
        for k, v in value.items():
            normalized[k] = v
        for snake_key, camel_key in RESULT_KEY_ALIASES.items():
            if snake_key in value and camel_key not in normalized:
                normalized[camel_key] = value[snake_key]
        return normalized
    return value


def run_sandboxed_hook(code, hook_name, payload_json):
    logs = []
    try:
        payload = _json.loads(payload_json) if payload_json else {}
        if not isinstance(payload, dict):
            payload = {}
    except Exception as exc:
        return _json.dumps({
            'ok': False,
            'result': None,
            'missingHook': False,
            'logs': logs,
            'error': f'Invalid payload JSON: {exc}',
        })

    if not isinstance(code, str):
        return _json.dumps({
            'ok': False,
            'result': None,
            'missingHook': False,
            'logs': logs,
            'error': 'Script code must be a string',
        })

    safe_builtins = _build_safe_builtins(logs)
    ns = {
        '__builtins__': safe_builtins,
        '__name__': '__game_script__',
    }

    try:
        compiled = compile(code, '<game_script>', 'exec')
        exec(compiled, ns, ns)
    except Exception as exc:
        return _json.dumps({
            'ok': False,
            'result': None,
            'missingHook': False,
            'logs': logs,
            'error': f'{type(exc).__name__}: {exc}',
        })

    hook_fn = ns.get(hook_name)
    if not callable(hook_fn):
        alias = HOOK_ALIASES.get(hook_name, '')
        hook_fn = ns.get(alias) if alias else None

    if not callable(hook_fn):
        return _json.dumps({
            'ok': True,
            'result': None,
            'missingHook': True,
            'logs': logs,
            'error': None,
        })

    try:
        raw_result = _invoke_hook(hook_fn, hook_name, payload)
        normalized_result = _normalize_result(raw_result)
        return _json.dumps({
            'ok': True,
            'result': normalized_result,
            'missingHook': False,
            'logs': logs,
            'error': None,
        }, allow_nan=False)
    except TypeError as exc:
        return _json.dumps({
            'ok': False,
            'result': None,
            'missingHook': False,
            'logs': logs,
            'error': f'Hook execution or JSON serialization failed (TypeError): {exc}',
        })
    except ValueError as exc:
        return _json.dumps({
            'ok': False,
            'result': None,
            'missingHook': False,
            'logs': logs,
            'error': f'Hook execution or JSON serialization failed (ValueError): {exc}',
        })
    except Exception as exc:
        return _json.dumps({
            'ok': False,
            'result': None,
            'missingHook': False,
            'logs': logs,
            'error': f'{type(exc).__name__}: {exc}',
        })
`;
