/**
 * @fileoverview Starter script templates and reusable code pattern snippets
 * for Combat-Multihog Game Scripts.
 *
 * Pure ESM with zero external/SillyTavern/DOM/Multihog imports so it can run
 * in both browser UI contexts and Node tests.
 */

function deepClone(value) {
    if (value === null || typeof value !== 'object') {
        return value;
    }
    if (Array.isArray(value)) {
        return value.map(deepClone);
    }
    const copy = {};
    for (const key of Object.keys(value)) {
        copy[key] = deepClone(value[key]);
    }
    return copy;
}

/**
 * Canonical starter templates for Game Scripts.
 *
 * Every template matches the canonical script schema:
 * `{ id, name, icon, description, lang, scope, boundCharacters, globalEnabled,
 *    trackerTag, commandPrefix, stripCommandFromPrompt, toolEnabled, toolName,
 *    toolDescription, toolActions, gmPrompt, code }`.
 */
export const SCRIPT_STARTER_TEMPLATES = [
    {
        id: 'blank',
        name: 'Blank Script',
        icon: '📜',
        description: 'Minimal skeleton implementing initState, onBeforeGenerate, onToolCall, onAfterGenerate, and renderMemo.',
        lang: 'js',
        scope: 'chat',
        boundCharacters: [],
        globalEnabled: false,
        trackerTag: 'SCRIPT_STATE',
        commandPrefix: '!script',
        stripCommandFromPrompt: true,
        toolEnabled: false,
        toolName: 'update_script_state',
        toolDescription: 'Update or inspect the custom script state.',
        toolActions: ['status', 'set'],
        gmPrompt: 'Respect the [SCRIPT_STATE] tracker block when narrating outcomes.',
        code: `function initState() {
    return {
        turnCount: 0,
        status: 'Ready',
        note: 'Initialized',
    };
}

function onBeforeGenerate(state, ctx) {
    const rawCommand = String(ctx?.command || '').trim();
    if (!rawCommand) {
        return { state };
    }

    if (rawCommand === 'reset') {
        return {
            state: initState(),
            immediateReply: 'Script state reset.',
        };
    }

    return {
        state: {
            ...state,
            note: rawCommand,
        },
        immediateReply: 'Updated script note.',
    };
}

function onToolCall(state, action, args) {
    if (action === 'status') {
        return {
            state,
            result: {
                ok: true,
                turnCount: state.turnCount,
                status: state.status,
                note: state.note,
            },
        };
    }

    if (action === 'set') {
        const nextStatus = typeof args?.status === 'string' && args.status.trim()
            ? args.status.trim()
            : state.status;
        const nextNote = typeof args?.note === 'string' && args.note.trim()
            ? args.note.trim()
            : state.note;
        return {
            state: {
                ...state,
                status: nextStatus,
                note: nextNote,
            },
            result: { ok: true, status: nextStatus, note: nextNote },
        };
    }

    return {
        state,
        result: { ok: false, error: \`Unknown action: \${String(action || '')}\` },
    };
}

function onAfterGenerate(state, ctx) {
    return {
        state: {
            ...state,
            turnCount: Number(state.turnCount || 0) + 1,
        },
    };
}

function renderMemo(state) {
    return [
        \`Status: ((PILLS)) \${state.status || 'Ready'}\`,
        \`Turns: \${Number(state.turnCount || 0)}\`,
        \`Note: \${state.note || 'None'}\`,
    ].join('\\n');
}
`,
    },
    {
        id: 'time_decay_meter',
        name: 'Time-Decay Meter',
        icon: '⏳',
        description: 'Tracks 0–100 Stamina & Focus that decay over ctx.time.deltaMinutes, recover via !meter rest / !meter boost or the recover tool, and render ((BAR)) + ((PILLS)).',
        lang: 'js',
        scope: 'chat',
        boundCharacters: [],
        globalEnabled: false,
        trackerTag: 'VITAL_METER',
        commandPrefix: '!meter',
        stripCommandFromPrompt: true,
        toolEnabled: true,
        toolName: 'meter_recover',
        toolDescription: 'Recover Stamina or Focus during rest, meals, or tactical pauses.',
        toolActions: ['recover'],
        gmPrompt: 'Keep narration consistent with [VITAL_METER]. When Stamina or Focus falls below 30, describe fatigue or distraction and invoke meter_recover only when the narrative includes genuine rest or recovery.',
        code: `function clamp(value, min, max) {
    const num = Number(value);
    if (!Number.isFinite(num)) return min;
    return Math.min(max, Math.max(min, Math.round(num)));
}

function initState() {
    return {
        stamina: 100,
        focus: 100,
        lastDay: null,
    };
}

function computeConditionPills(stamina, focus) {
    const pills = [];
    if (stamina >= 75) pills.push('Rested');
    else if (stamina >= 35) pills.push('Steady');
    else if (stamina >= 15) pills.push('Fatigued');
    else pills.push('Exhausted');

    if (focus >= 75) pills.push('Sharp');
    else if (focus >= 35) pills.push('Alert');
    else pills.push('Unfocused');

    return pills;
}

function onBeforeGenerate(state, ctx) {
    let stamina = clamp(state.stamina, 0, 100);
    let focus = clamp(state.focus, 0, 100);
    let dayCue = '';

    const deltaMinutes = Math.max(0, Number(ctx?.time?.deltaMinutes || 0));
    const dayChanged = Boolean(ctx?.time?.dayChanged);

    if (deltaMinutes > 0) {
        const staminaLoss = Math.floor(deltaMinutes / 30);
        const focusLoss = Math.floor(deltaMinutes / 45);
        stamina = clamp(stamina - staminaLoss, 0, 100);
        focus = clamp(focus - focusLoss, 0, 100);
    }

    if (dayChanged) {
        stamina = clamp(stamina + 25, 0, 100);
        focus = clamp(focus + 20, 0, 100);
        dayCue = 'A new day dawns, partially restoring stamina and focus.';
    }

    const cmd = String(ctx?.command || '').trim().toLowerCase();
    if (cmd === 'rest') {
        stamina = clamp(stamina + 30, 0, 100);
        focus = clamp(focus + 20, 0, 100);
        return {
            state: {
                ...state,
                stamina,
                focus,
                lastDay: ctx?.time?.day ?? state.lastDay,
            },
            immediateReply: \`Rested. Stamina \${stamina}/100, Focus \${focus}/100.\`,
        };
    }

    if (cmd === 'boost') {
        stamina = clamp(stamina + 15, 0, 100);
        focus = clamp(focus + 35, 0, 100);
        return {
            state: {
                ...state,
                stamina,
                focus,
                lastDay: ctx?.time?.day ?? state.lastDay,
            },
            immediateReply: \`Focus boosted. Stamina \${stamina}/100, Focus \${focus}/100.\`,
        };
    }

    const nextState = {
        ...state,
        stamina,
        focus,
        lastDay: ctx?.time?.day ?? state.lastDay,
    };

    const result = { state: nextState };
    if (stamina <= 20 || focus <= 20) {
        result.promptInjection = \`[Vital Meter Warning] Stamina is \${stamina}/100 and Focus is \${focus}/100. Reflect weariness in the scene.\`;
    } else if (dayCue) {
        result.promptInjection = dayCue;
    }
    return result;
}

function onToolCall(state, action, args) {
    if (action !== 'recover') {
        return {
            state,
            result: { ok: false, error: \`Unsupported action: \${String(action || '')}\` },
        };
    }

    const staminaGain = clamp(args?.stamina ?? 20, 0, 100);
    const focusGain = clamp(args?.focus ?? 15, 0, 100);
    const stamina = clamp(state.stamina + staminaGain, 0, 100);
    const focus = clamp(state.focus + focusGain, 0, 100);

    return {
        state: {
            ...state,
            stamina,
            focus,
        },
        result: {
            ok: true,
            stamina,
            focus,
            recovered: { stamina: staminaGain, focus: focusGain },
        },
    };
}

function onAfterGenerate(state, ctx) {
    const stamina = clamp(state.stamina - 3, 0, 100);
    const focus = clamp(state.focus - 2, 0, 100);
    return {
        state: {
            ...state,
            stamina,
            focus,
        },
    };
}

function renderMemo(state) {
    const stamina = clamp(state.stamina, 0, 100);
    const focus = clamp(state.focus, 0, 100);
    const pills = computeConditionPills(stamina, focus);
    return [
        \`Stamina: ((BAR)) \${stamina}/100\`,
        \`Focus: ((BAR)) \${focus}/100\`,
        \`Condition: ((PILLS)) \${pills.join(', ')}\`,
    ].join('\\n');
}
`,
    },
    {
        id: 'command_tool_companion',
        name: 'Command + Tool Companion',
        icon: '🤝',
        description: 'Tracks a companion’s Affinity, Mood, and Name via both !ally name: ... / !ally praise pre-turn commands and interact / set_name mid-turn tool actions without double-firing.',
        lang: 'js',
        scope: 'chat',
        boundCharacters: [],
        globalEnabled: false,
        trackerTag: 'COMPANION',
        commandPrefix: '!ally',
        stripCommandFromPrompt: true,
        toolEnabled: true,
        toolName: 'companion_action',
        toolDescription: 'Update companion name or record a meaningful interaction when not already handled by a player command this turn.',
        toolActions: ['interact', 'set_name'],
        gmPrompt: 'Track the companion shown in [COMPANION]. Call companion_action(action="interact"|"set_name") only when the scene meaningfully shifts rapport or reveals/changes their name, and never repeat an adjustment already acknowledged by a player command.',
        code: `function clamp(value, min, max) {
    const num = Number(value);
    if (!Number.isFinite(num)) return min;
    return Math.min(max, Math.max(min, Math.round(num)));
}

function getTier(affinity) {
    if (affinity >= 80) return 'Devoted';
    if (affinity >= 55) return 'Trusted';
    if (affinity >= 30) return 'Friendly';
    if (affinity >= 15) return 'Cordial';
    return 'Wary';
}

function initState() {
    return {
        name: 'Vesper',
        affinity: 25,
        mood: 'Observant',
        lastCommandTurnHandled: false,
    };
}

function onBeforeGenerate(state, ctx) {
    const raw = String(ctx?.command || '').trim();
    if (!raw) {
        return {
            state: {
                ...state,
                lastCommandTurnHandled: false,
            },
        };
    }

    const nameMatch = raw.match(/^name\\s*:\\s*(.+)$/i);
    if (nameMatch) {
        const nextName = nameMatch[1].trim().slice(0, 48);
        if (!nextName) {
            return {
                state,
                immediateReply: 'Usage: !ally name: <Companion Name>',
            };
        }
        return {
            state: {
                ...state,
                name: nextName,
                lastCommandTurnHandled: true,
            },
            immediateReply: \`Companion renamed to \${nextName}.\`,
        };
    }

    if (raw.toLowerCase() === 'praise') {
        const nextAffinity = clamp(state.affinity + 8, 0, 100);
        return {
            state: {
                ...state,
                affinity: nextAffinity,
                mood: 'Encouraged',
                lastCommandTurnHandled: true,
            },
            immediateReply: \`\${state.name} appreciates the encouragement (Affinity \${nextAffinity}/100).\`,
        };
    }

    return {
        state: {
            ...state,
            lastCommandTurnHandled: false,
        },
        immediateReply: \`Unknown !ally command "\${raw}". Try "!ally praise" or "!ally name: <Name>".\`,
    };
}

function onToolCall(state, action, args) {
    if (state.lastCommandTurnHandled) {
        return {
            state,
            result: {
                ok: true,
                skipped: true,
                reason: 'Already handled by pre-turn player command this turn.',
                name: state.name,
                affinity: state.affinity,
                mood: state.mood,
            },
        };
    }

    if (action === 'set_name') {
        const nextName = String(args?.name || '').trim().slice(0, 48);
        if (!nextName) {
            return {
                state,
                result: { ok: false, error: 'Missing non-empty name argument.' },
            };
        }
        return {
            state: {
                ...state,
                name: nextName,
                lastCommandTurnHandled: true,
            },
            result: { ok: true, name: nextName },
        };
    }

    if (action === 'interact') {
        const delta = clamp(args?.affinityDelta ?? 5, -15, 15);
        const nextAffinity = clamp(state.affinity + delta, 0, 100);
        const nextMood = typeof args?.mood === 'string' && args.mood.trim()
            ? args.mood.trim().slice(0, 32)
            : (delta >= 0 ? 'Warm' : 'Guarded');
        return {
            state: {
                ...state,
                affinity: nextAffinity,
                mood: nextMood,
                lastCommandTurnHandled: true,
            },
            result: {
                ok: true,
                name: state.name,
                affinity: nextAffinity,
                mood: nextMood,
                tier: getTier(nextAffinity),
            },
        };
    }

    return {
        state,
        result: { ok: false, error: \`Unknown action: \${String(action || '')}\` },
    };
}

function onAfterGenerate(state, ctx) {
    if (!state.lastCommandTurnHandled) {
        return { state };
    }
    return {
        state: {
            ...state,
            lastCommandTurnHandled: false,
        },
    };
}

function renderMemo(state) {
    const affinity = clamp(state.affinity, 0, 100);
    const tier = getTier(affinity);
    return [
        \`Companion: \${state.name || 'Unnamed'}\`,
        \`Affinity: ((BAR)) \${affinity}/100\`,
        \`Standing: ((PILLS)) \${tier}, \${state.mood || 'Calm'}\`,
    ].join('\\n');
}
`,
    },
    {
        id: 'stage_route_progression',
        name: 'Stage & Route Progression',
        icon: '🧭',
        description: 'Tracks Reputation, Discipline, and Empathy, advances monotone stages (Novice → Seasoned → Master), emits one-shot promptInjection cues, and demonstrates portraitUrl + appendMarkdown.',
        lang: 'js',
        scope: 'chat',
        boundCharacters: [],
        globalEnabled: false,
        trackerTag: 'ROUTE_PROGRESS',
        commandPrefix: '!route',
        stripCommandFromPrompt: true,
        toolEnabled: true,
        toolName: 'advance_route',
        toolDescription: 'Adjust Reputation, Discipline, or Empathy after a consequential decision or trial.',
        toolActions: ['progress', 'inspect'],
        gmPrompt: 'Consult [ROUTE_PROGRESS] to reflect the protagonist’s current Stage and dominant Route (Vanguard, Balanced, or Diplomat). Call advance_route(action="progress") when choices noticeably shift Reputation, Discipline, or Empathy.',
        code: `const STAGES = [
    { index: 0, label: 'Novice', minScore: 0, portrait: '/assets/portraits/stage-novice.png' },
    { index: 1, label: 'Seasoned', minScore: 40, portrait: '/assets/portraits/stage-seasoned.png' },
    { index: 2, label: 'Master', minScore: 80, portrait: '/assets/portraits/stage-master.png' },
];

function clamp(value, min, max) {
    const num = Number(value);
    if (!Number.isFinite(num)) return min;
    return Math.min(max, Math.max(min, Math.round(num)));
}

function resolveStageIndex(reputation, currentStageIndex) {
    let computed = 0;
    for (const stage of STAGES) {
        if (reputation >= stage.minScore) {
            computed = stage.index;
        }
    }
    // Monotone progression: stage never regresses once unlocked.
    return Math.max(Number(currentStageIndex || 0), computed);
}

function resolveRoute(discipline, empathy) {
    if (Math.abs(discipline - empathy) < 10) return 'Balanced';
    return discipline > empathy ? 'Vanguard' : 'Diplomat';
}

function initState() {
    return {
        reputation: 10,
        discipline: 20,
        empathy: 20,
        stageIndex: 0,
        announcedStageIndex: 0,
        pendingMilestoneCue: '',
        pendingAppendCard: '',
    };
}

function applyDelta(state, repDelta, discDelta, empDelta) {
    const reputation = clamp(state.reputation + repDelta, 0, 100);
    const discipline = clamp(state.discipline + discDelta, 0, 100);
    const empathy = clamp(state.empathy + empDelta, 0, 100);
    const prevStage = Number(state.stageIndex || 0);
    const stageIndex = resolveStageIndex(reputation, prevStage);

    let pendingMilestoneCue = state.pendingMilestoneCue || '';
    let pendingAppendCard = state.pendingAppendCard || '';
    let announcedStageIndex = Number(state.announcedStageIndex || 0);

    if (stageIndex > announcedStageIndex) {
        const stageInfo = STAGES[stageIndex];
        const route = resolveRoute(discipline, empathy);
        announcedStageIndex = stageIndex;
        pendingMilestoneCue = \`[Milestone Reached] The protagonist has ascended to \${stageInfo.label} rank on the \${route} route. Acknowledge this earned recognition naturally.\`;
        pendingAppendCard = \`\\n> **Rank Unlocked:** \${stageInfo.label} (\${route} Route)\`;
    }

    return {
        ...state,
        reputation,
        discipline,
        empathy,
        stageIndex,
        announcedStageIndex,
        pendingMilestoneCue,
        pendingAppendCard,
    };
}

function onBeforeGenerate(state, ctx) {
    let nextState = { ...state };
    const cmd = String(ctx?.command || '').trim().toLowerCase();

    if (cmd === 'train') {
        nextState = applyDelta(nextState, 12, 8, 0);
        return {
            state: nextState,
            immediateReply: \`Training complete. Reputation \${nextState.reputation}/100, Discipline \${nextState.discipline}/100.\`,
        };
    }

    if (cmd === 'counsel') {
        nextState = applyDelta(nextState, 12, 0, 8);
        return {
            state: nextState,
            immediateReply: \`Counsel offered. Reputation \${nextState.reputation}/100, Empathy \${nextState.empathy}/100.\`,
        };
    }

    const output = { state: nextState };
    if (nextState.pendingMilestoneCue) {
        output.promptInjection = nextState.pendingMilestoneCue;
        nextState.pendingMilestoneCue = '';
    }
    return output;
}

function onToolCall(state, action, args) {
    if (action === 'inspect') {
        const stageInfo = STAGES[state.stageIndex] || STAGES[0];
        return {
            state,
            result: {
                ok: true,
                stage: stageInfo.label,
                route: resolveRoute(state.discipline, state.empathy),
                reputation: state.reputation,
                discipline: state.discipline,
                empathy: state.empathy,
            },
        };
    }

    if (action === 'progress') {
        const repDelta = clamp(args?.reputation ?? 10, -25, 50);
        const discDelta = clamp(args?.discipline ?? 0, -25, 50);
        const empDelta = clamp(args?.empathy ?? 0, -25, 50);
        const nextState = applyDelta(state, repDelta, discDelta, empDelta);
        const stageInfo = STAGES[nextState.stageIndex] || STAGES[0];
        return {
            state: nextState,
            result: {
                ok: true,
                stage: stageInfo.label,
                route: resolveRoute(nextState.discipline, nextState.empathy),
                reputation: nextState.reputation,
                discipline: nextState.discipline,
                empathy: nextState.empathy,
            },
        };
    }

    return {
        state,
        result: { ok: false, error: \`Unknown action: \${String(action || '')}\` },
    };
}

function onAfterGenerate(state, ctx) {
    const stageInfo = STAGES[state.stageIndex] || STAGES[0];
    const appendMarkdown = state.pendingAppendCard || '';
    return {
        state: {
            ...state,
            pendingAppendCard: '',
        },
        portraitUrl: stageInfo.portrait,
        appendMarkdown,
    };
}

function renderMemo(state) {
    const stageInfo = STAGES[state.stageIndex] || STAGES[0];
    const route = resolveRoute(state.discipline, state.empathy);
    return [
        \`Stage: ((PILLS)) \${stageInfo.label}, \${route}\`,
        \`Reputation: ((BAR)) \${clamp(state.reputation, 0, 100)}/100\`,
        \`Discipline: ((BAR)) \${clamp(state.discipline, 0, 100)}/100\`,
        \`Empathy: ((BAR)) \${clamp(state.empathy, 0, 100)}/100\`,
    ].join('\\n');
}
`,
    },
];

/**
 * Reusable code pattern snippets for inserting into custom Game Scripts.
 */
export const SCRIPT_PATTERN_SNIPPETS = [
    {
        id: 'time_delta',
        label: 'Time Delta & Day Rollover',
        description: 'Reads ctx.time.deltaMinutes and ctx.time.dayChanged safely to drive decay or daily resets.',
        code: `const deltaMinutes = Math.max(0, Number(ctx?.time?.deltaMinutes || 0));
const dayChanged = Boolean(ctx?.time?.dayChanged);
if (deltaMinutes > 0) {
    // Example: lose 1 point per 30 elapsed in-world minutes
    const decay = Math.floor(deltaMinutes / 30);
    state.meter = Math.max(0, state.meter - decay);
}
if (dayChanged) {
    state.dailyUses = 0;
}`,
    },
    {
        id: 'bar_and_pills',
        label: 'BAR & PILLS Formatting',
        description: 'Formats ((BAR)) progress bars and ((PILLS)) status badges for renderMemo.',
        code: `function renderMemo(state) {
    const statuses = state.statuses?.length ? state.statuses.join(', ') : 'Steady';
    return [
        \`Meter: ((BAR)) \${state.meter}/100\`,
        \`Status: ((PILLS)) \${statuses}\`,
    ].join('\\n');
}`,
    },
    {
        id: 'clamp_and_tier',
        label: 'Clamp & Threshold Tier Lookup',
        description: 'Provides clamp(n, 0, 100) and a descending threshold lookup helper.',
        code: `function clamp(n, min = 0, max = 100) {
    const num = Number(n);
    if (!Number.isFinite(num)) return min;
    return Math.min(max, Math.max(min, Math.round(num)));
}

function getTier(score, tiers = [
    { min: 80, label: 'Master' },
    { min: 40, label: 'Seasoned' },
    { min: 0, label: 'Novice' },
]) {
    const val = clamp(score, 0, 100);
    return (tiers.find((t) => val >= t.min) || tiers[tiers.length - 1]).label;
}`,
    },
    {
        id: 'one_shot_prompt',
        label: 'One-Shot Prompt Injection',
        description: 'Consumes a queued event flag once and emits promptInjection for the current turn only.',
        code: `let promptInjection = '';
if (state.pendingCue) {
    promptInjection = String(state.pendingCue);
    state = { ...state, pendingCue: '' };
}
return promptInjection ? { state, promptInjection } : { state };`,
    },
    {
        id: 'media_attachment',
        label: 'Deterministic Portrait & Append Markdown',
        description: 'Returns a deterministic portraitUrl and consumes a one-shot appendMarkdown banner in onAfterGenerate.',
        code: `function onAfterGenerate(state, ctx) {
    const portraitUrl = state.stage >= 2
        ? '/assets/portraits/stage-2.png'
        : '/assets/portraits/stage-1.png';
    const appendMarkdown = state.pendingBanner || '';
    return {
        state: { ...state, pendingBanner: '' },
        portraitUrl,
        appendMarkdown,
    };
}`,
    },
];

/**
 * Canonical Python (Pyodide) starter templates for Game Scripts.
 *
 * Mirrors the canonical script schema with `lang: 'python'` and idiomatic
 * snake_case hooks (`init_state`, `on_before_generate`, `on_tool_call`,
 * `on_after_generate`, `render_memo`) and snake_case return dictionary keys.
 */
export const SCRIPT_PYTHON_STARTER_TEMPLATES = [
    {
        id: 'py_blank',
        name: 'Blank Python Script',
        icon: '🐍',
        description: 'Minimal Python skeleton implementing init_state, on_before_generate, on_tool_call, on_after_generate, and render_memo.',
        lang: 'python',
        scope: 'chat',
        boundCharacters: [],
        globalEnabled: false,
        trackerTag: 'SCRIPT_STATE',
        commandPrefix: '!script',
        stripCommandFromPrompt: true,
        toolEnabled: false,
        toolName: 'update_script_state',
        toolDescription: 'Update or inspect the custom script state.',
        toolActions: ['status', 'set'],
        gmPrompt: 'Respect the [SCRIPT_STATE] tracker block when narrating outcomes.',
        code: `def init_state(ctx):
    return {
        "turn_count": 0,
        "status": "Ready",
        "note": "Initialized",
    }


def on_before_generate(state, ctx):
    cmd = ctx.get("command") or {}
    sub = str(cmd.get("subcommand") or "").strip().lower()
    raw_args = str(cmd.get("rawArgs") or "").strip()
    if not sub:
        return {"state": state}

    if sub == "reset":
        next_state = init_state(ctx)
        return {
            "state": next_state,
            "prompt_injection": "[SCRIPT_EVENT] Script state reset to initial defaults.",
        }

    note_text = f"{sub} {raw_args}".strip() if raw_args else sub
    next_state = dict(state)
    next_state["note"] = note_text
    return {
        "state": next_state,
        "prompt_injection": f"[SCRIPT_EVENT] Updated script note to: {note_text}.",
    }


def on_tool_call(state, call, ctx):
    call = call if isinstance(call, dict) else {}
    action = str(call.get("action") or "").strip()
    args = call.get("args") if isinstance(call.get("args"), dict) else {}

    if action == "status":
        return {
            "state": state,
            "tool_result": {
                "ok": True,
                "turn_count": int(state.get("turn_count") or 0),
                "status": state.get("status") or "Ready",
                "note": state.get("note") or "None",
            },
        }

    if action == "set":
        next_status = str(args.get("status") or "").strip() or state.get("status") or "Ready"
        next_note = str(args.get("note") or "").strip() or state.get("note") or "Initialized"
        next_state = dict(state)
        next_state["status"] = next_status
        next_state["note"] = next_note
        return {
            "state": next_state,
            "tool_result": {
                "ok": True,
                "status": next_status,
                "note": next_note,
            },
        }

    return {
        "state": state,
        "tool_result": {
            "ok": False,
            "error": f"Unknown action: {action}",
        },
    }


def on_after_generate(state, ctx):
    next_state = dict(state)
    next_state["turn_count"] = int(state.get("turn_count") or 0) + 1
    return {"state": next_state}


def render_memo(state, ctx):
    status = state.get("status") or "Ready"
    turns = int(state.get("turn_count") or 0)
    note = state.get("note") or "None"
    return "\\n".join([
        f"Status: ((PILLS)) {status}",
        f"Turns: {turns}",
        f"Note: {note}",
    ])
`,
    },
    {
        id: 'py_time_decay_meter',
        name: 'Time-Decay Meter (Python)',
        icon: '⏳',
        description: 'Tracks 0–100 Stamina & Focus that decay over ctx["time"]["deltaMinutes"], recover via !meter rest / !meter boost or the recover tool, and render ((BAR)) + ((PILLS)).',
        lang: 'python',
        scope: 'chat',
        boundCharacters: [],
        globalEnabled: false,
        trackerTag: 'VITAL_METER',
        commandPrefix: '!meter',
        stripCommandFromPrompt: true,
        toolEnabled: true,
        toolName: 'meter_recover',
        toolDescription: 'Recover Stamina or Focus during rest, meals, or tactical pauses.',
        toolActions: ['recover'],
        gmPrompt: 'Keep narration consistent with [VITAL_METER]. When Stamina or Focus falls below 30, describe fatigue or distraction and invoke meter_recover only when the narrative includes genuine rest or recovery.',
        code: `def clamp(value, min_val=0, max_val=100):
    try:
        num = float(value)
    except (TypeError, ValueError):
        return min_val
    return max(min_val, min(max_val, round(num)))


def init_state(ctx):
    return {
        "stamina": 100,
        "focus": 100,
        "last_day": None,
    }


def compute_condition_pills(stamina, focus):
    pills = []
    if stamina >= 75:
        pills.append("Rested")
    elif stamina >= 35:
        pills.append("Steady")
    elif stamina >= 15:
        pills.append("Fatigued")
    else:
        pills.append("Exhausted")

    if focus >= 75:
        pills.append("Sharp")
    elif focus >= 35:
        pills.append("Alert")
    else:
        pills.append("Unfocused")

    return pills


def on_before_generate(state, ctx):
    stamina = clamp(state.get("stamina", 100), 0, 100)
    focus = clamp(state.get("focus", 100), 0, 100)
    day_cue = ""

    time_info = ctx.get("time") if isinstance(ctx.get("time"), dict) else {}
    delta_minutes = max(0, int(time_info.get("deltaMinutes") or 0))
    day_changed = bool(time_info.get("dayChanged"))

    if delta_minutes > 0:
        stamina = clamp(stamina - (delta_minutes // 30), 0, 100)
        focus = clamp(focus - (delta_minutes // 45), 0, 100)

    if day_changed:
        stamina = clamp(stamina + 25, 0, 100)
        focus = clamp(focus + 20, 0, 100)
        day_cue = "A new day dawns, partially restoring stamina and focus."

    cmd = ctx.get("command") or {}
    sub = str(cmd.get("subcommand") or "").strip().lower()
    next_day = time_info.get("day") if "day" in time_info else state.get("last_day")

    if sub == "rest":
        stamina = clamp(stamina + 30, 0, 100)
        focus = clamp(focus + 20, 0, 100)
        next_state = dict(state)
        next_state.update({"stamina": stamina, "focus": focus, "last_day": next_day})
        return {
            "state": next_state,
            "prompt_injection": f"[Vital Meter] Rested. Stamina {stamina}/100, Focus {focus}/100.",
        }

    if sub == "boost":
        stamina = clamp(stamina + 15, 0, 100)
        focus = clamp(focus + 35, 0, 100)
        next_state = dict(state)
        next_state.update({"stamina": stamina, "focus": focus, "last_day": next_day})
        return {
            "state": next_state,
            "prompt_injection": f"[Vital Meter] Focus boosted. Stamina {stamina}/100, Focus {focus}/100.",
        }

    next_state = dict(state)
    next_state.update({"stamina": stamina, "focus": focus, "last_day": next_day})
    result = {"state": next_state}
    if stamina <= 20 or focus <= 20:
        result["prompt_injection"] = (
            f"[Vital Meter Warning] Stamina is {stamina}/100 and Focus is {focus}/100. "
            "Reflect weariness in the scene."
        )
    elif day_cue:
        result["prompt_injection"] = day_cue
    return result


def on_tool_call(state, call, ctx):
    call = call if isinstance(call, dict) else {}
    action = str(call.get("action") or "").strip()
    args = call.get("args") if isinstance(call.get("args"), dict) else {}

    if action != "recover":
        return {
            "state": state,
            "tool_result": {"ok": False, "error": f"Unsupported action: {action}"},
        }

    stamina_gain = clamp(args.get("stamina", 20), 0, 100)
    focus_gain = clamp(args.get("focus", 15), 0, 100)
    stamina = clamp(state.get("stamina", 100) + stamina_gain, 0, 100)
    focus = clamp(state.get("focus", 100) + focus_gain, 0, 100)

    next_state = dict(state)
    next_state.update({"stamina": stamina, "focus": focus})
    return {
        "state": next_state,
        "tool_result": {
            "ok": True,
            "stamina": stamina,
            "focus": focus,
            "recovered": {"stamina": stamina_gain, "focus": focus_gain},
        },
    }


def on_after_generate(state, ctx):
    stamina = clamp(state.get("stamina", 100) - 3, 0, 100)
    focus = clamp(state.get("focus", 100) - 2, 0, 100)
    next_state = dict(state)
    next_state.update({"stamina": stamina, "focus": focus})
    return {"state": next_state}


def render_memo(state, ctx):
    stamina = clamp(state.get("stamina", 100), 0, 100)
    focus = clamp(state.get("focus", 100), 0, 100)
    pills = compute_condition_pills(stamina, focus)
    return "\\n".join([
        f"Stamina: ((BAR)) {stamina}/100",
        f"Focus: ((BAR)) {focus}/100",
        f"Condition: ((PILLS)) {', '.join(pills)}",
    ])
`,
    },
    {
        id: 'py_command_tool_companion',
        name: 'Command + Tool Companion (Python)',
        icon: '🤝',
        description: 'Tracks a companion’s Affinity, Mood, and Name via both !ally name: ... / !ally praise pre-turn commands and interact / set_name mid-turn tool actions without double-firing.',
        lang: 'python',
        scope: 'chat',
        boundCharacters: [],
        globalEnabled: false,
        trackerTag: 'COMPANION',
        commandPrefix: '!ally',
        stripCommandFromPrompt: true,
        toolEnabled: true,
        toolName: 'companion_action',
        toolDescription: 'Update companion name or record a meaningful interaction when not already handled by a player command this turn.',
        toolActions: ['interact', 'set_name'],
        gmPrompt: 'Track the companion shown in [COMPANION]. Call companion_action(action="interact"|"set_name") only when the scene meaningfully shifts rapport or reveals/changes their name, and never repeat an adjustment already acknowledged by a player command.',
        code: `def clamp(value, min_val=0, max_val=100):
    try:
        num = float(value)
    except (TypeError, ValueError):
        return min_val
    return max(min_val, min(max_val, round(num)))


def get_tier(affinity):
    if affinity >= 80:
        return "Devoted"
    if affinity >= 55:
        return "Trusted"
    if affinity >= 30:
        return "Friendly"
    if affinity >= 15:
        return "Cordial"
    return "Wary"


def init_state(ctx):
    return {
        "name": "Vesper",
        "affinity": 25,
        "mood": "Observant",
        "last_command_turn_handled": False,
    }


def on_before_generate(state, ctx):
    cmd = ctx.get("command") or {}
    sub = str(cmd.get("subcommand") or "").strip().lower()
    raw_args = str(cmd.get("rawArgs") or "").strip()

    if not sub:
        next_state = dict(state)
        next_state["last_command_turn_handled"] = False
        return {"state": next_state}

    if sub == "name":
        next_name = raw_args[:48].strip()
        if not next_name:
            return {
                "state": state,
                "prompt_injection": "[COMPANION] Usage: !ally name: <Companion Name>",
            }
        next_state = dict(state)
        next_state["name"] = next_name
        next_state["last_command_turn_handled"] = True
        return {
            "state": next_state,
            "prompt_injection": f"[COMPANION] Companion renamed to {next_name}.",
        }

    if sub == "praise":
        next_affinity = clamp(state.get("affinity", 25) + 8, 0, 100)
        next_state = dict(state)
        next_state.update({
            "affinity": next_affinity,
            "mood": "Encouraged",
            "last_command_turn_handled": True,
        })
        name = state.get("name") or "Companion"
        return {
            "state": next_state,
            "prompt_injection": f"[COMPANION] {name} appreciates the encouragement (Affinity {next_affinity}/100).",
        }

    next_state = dict(state)
    next_state["last_command_turn_handled"] = False
    return {
        "state": next_state,
        "prompt_injection": f'[COMPANION] Unknown !ally command "{sub}". Try "!ally praise" or "!ally name: <Name>".',
    }


def on_tool_call(state, call, ctx):
    if state.get("last_command_turn_handled"):
        return {
            "state": state,
            "tool_result": {
                "ok": True,
                "skipped": True,
                "reason": "Already handled by pre-turn player command this turn.",
                "name": state.get("name"),
                "affinity": state.get("affinity"),
                "mood": state.get("mood"),
            },
        }

    call = call if isinstance(call, dict) else {}
    action = str(call.get("action") or "").strip()
    args = call.get("args") if isinstance(call.get("args"), dict) else {}

    if action == "set_name":
        next_name = str(args.get("name") or "").strip()[:48]
        if not next_name:
            return {
                "state": state,
                "tool_result": {"ok": False, "error": "Missing non-empty name argument."},
            }
        next_state = dict(state)
        next_state.update({"name": next_name, "last_command_turn_handled": True})
        return {
            "state": next_state,
            "tool_result": {"ok": True, "name": next_name},
        }

    if action == "interact":
        raw_delta = args.get("affinityDelta")
        if raw_delta is None:
            raw_delta = args.get("affinity_delta", 5)
        delta = clamp(raw_delta, -15, 15)
        next_affinity = clamp(state.get("affinity", 25) + delta, 0, 100)
        raw_mood = str(args.get("mood") or "").strip()
        next_mood = raw_mood[:32] if raw_mood else ("Warm" if delta >= 0 else "Guarded")

        next_state = dict(state)
        next_state.update({
            "affinity": next_affinity,
            "mood": next_mood,
            "last_command_turn_handled": True,
        })
        return {
            "state": next_state,
            "tool_result": {
                "ok": True,
                "name": state.get("name"),
                "affinity": next_affinity,
                "mood": next_mood,
                "tier": get_tier(next_affinity),
            },
        }

    return {
        "state": state,
        "tool_result": {"ok": False, "error": f"Unknown action: {action}"},
    }


def on_after_generate(state, ctx):
    if not state.get("last_command_turn_handled"):
        return {"state": state}
    next_state = dict(state)
    next_state["last_command_turn_handled"] = False
    return {"state": next_state}


def render_memo(state, ctx):
    affinity = clamp(state.get("affinity", 25), 0, 100)
    tier = get_tier(affinity)
    name = state.get("name") or "Unnamed"
    mood = state.get("mood") or "Calm"
    return "\\n".join([
        f"Companion: {name}",
        f"Affinity: ((BAR)) {affinity}/100",
        f"Standing: ((PILLS)) {tier}, {mood}",
    ])
`,
    },
    {
        id: 'py_stage_route_progression',
        name: 'Stage & Route Progression (Python)',
        icon: '🧭',
        description: 'Tracks Reputation, Discipline, and Empathy, advances monotone stages (Novice → Seasoned → Master), emits one-shot prompt_injection cues, and demonstrates portrait_url + append_markdown.',
        lang: 'python',
        scope: 'chat',
        boundCharacters: [],
        globalEnabled: false,
        trackerTag: 'ROUTE_PROGRESS',
        commandPrefix: '!route',
        stripCommandFromPrompt: true,
        toolEnabled: true,
        toolName: 'advance_route',
        toolDescription: 'Adjust Reputation, Discipline, or Empathy after a consequential decision or trial.',
        toolActions: ['progress', 'inspect'],
        gmPrompt: 'Consult [ROUTE_PROGRESS] to reflect the protagonist’s current Stage and dominant Route (Vanguard, Balanced, or Diplomat). Call advance_route(action="progress") when choices noticeably shift Reputation, Discipline, or Empathy.',
        code: `STAGES = [
    {"index": 0, "label": "Novice", "min_score": 0, "portrait": "/assets/portraits/stage-novice.png"},
    {"index": 1, "label": "Seasoned", "min_score": 40, "portrait": "/assets/portraits/stage-seasoned.png"},
    {"index": 2, "label": "Master", "min_score": 80, "portrait": "/assets/portraits/stage-master.png"},
]


def clamp(value, min_val=0, max_val=100):
    try:
        num = float(value)
    except (TypeError, ValueError):
        return min_val
    return max(min_val, min(max_val, round(num)))


def resolve_stage_index(reputation, current_stage_index):
    computed = 0
    for stage in STAGES:
        if reputation >= stage["min_score"]:
            computed = stage["index"]
    # Monotone progression: stage never regresses once unlocked.
    return max(int(current_stage_index or 0), computed)


def resolve_route(discipline, empathy):
    if abs(discipline - empathy) < 10:
        return "Balanced"
    return "Vanguard" if discipline > empathy else "Diplomat"


def init_state(ctx):
    return {
        "reputation": 10,
        "discipline": 20,
        "empathy": 20,
        "stage_index": 0,
        "announced_stage_index": 0,
        "pending_milestone_cue": "",
        "pending_append_card": "",
    }


def apply_delta(state, rep_delta, disc_delta, emp_delta):
    reputation = clamp(state.get("reputation", 10) + rep_delta, 0, 100)
    discipline = clamp(state.get("discipline", 20) + disc_delta, 0, 100)
    empathy = clamp(state.get("empathy", 20) + emp_delta, 0, 100)
    prev_stage = int(state.get("stage_index") or 0)
    stage_index = resolve_stage_index(reputation, prev_stage)

    pending_milestone_cue = state.get("pending_milestone_cue") or ""
    pending_append_card = state.get("pending_append_card") or ""
    announced_stage_index = int(state.get("announced_stage_index") or 0)

    if stage_index > announced_stage_index:
        stage_info = STAGES[stage_index]
        route = resolve_route(discipline, empathy)
        announced_stage_index = stage_index
        pending_milestone_cue = (
            f"[Milestone Reached] The protagonist has ascended to {stage_info['label']} rank "
            f"on the {route} route. Acknowledge this earned recognition naturally."
        )
        pending_append_card = f"\\n> **Rank Unlocked:** {stage_info['label']} ({route} Route)"

    next_state = dict(state)
    next_state.update({
        "reputation": reputation,
        "discipline": discipline,
        "empathy": empathy,
        "stage_index": stage_index,
        "announced_stage_index": announced_stage_index,
        "pending_milestone_cue": pending_milestone_cue,
        "pending_append_card": pending_append_card,
    })
    return next_state


def on_before_generate(state, ctx):
    next_state = dict(state)
    cmd = ctx.get("command") or {}
    sub = str(cmd.get("subcommand") or "").strip().lower()

    if sub == "train":
        next_state = apply_delta(next_state, 12, 8, 0)
        cue = next_state.get("pending_milestone_cue") or (
            f"[Route] Training complete. Reputation {next_state['reputation']}/100, "
            f"Discipline {next_state['discipline']}/100."
        )
        next_state["pending_milestone_cue"] = ""
        return {
            "state": next_state,
            "prompt_injection": cue,
        }

    if sub == "counsel":
        next_state = apply_delta(next_state, 12, 0, 8)
        cue = next_state.get("pending_milestone_cue") or (
            f"[Route] Counsel offered. Reputation {next_state['reputation']}/100, "
            f"Empathy {next_state['empathy']}/100."
        )
        next_state["pending_milestone_cue"] = ""
        return {
            "state": next_state,
            "prompt_injection": cue,
        }

    output = {"state": next_state}
    if next_state.get("pending_milestone_cue"):
        output["prompt_injection"] = next_state["pending_milestone_cue"]
        next_state["pending_milestone_cue"] = ""
    return output


def on_tool_call(state, call, ctx):
    call = call if isinstance(call, dict) else {}
    action = str(call.get("action") or "").strip()
    args = call.get("args") if isinstance(call.get("args"), dict) else {}

    if action == "inspect":
        idx = int(state.get("stage_index") or 0)
        stage_info = STAGES[idx] if 0 <= idx < len(STAGES) else STAGES[0]
        return {
            "state": state,
            "tool_result": {
                "ok": True,
                "stage": stage_info["label"],
                "route": resolve_route(state.get("discipline", 20), state.get("empathy", 20)),
                "reputation": state.get("reputation", 10),
                "discipline": state.get("discipline", 20),
                "empathy": state.get("empathy", 20),
            },
        }

    if action == "progress":
        rep_delta = clamp(args.get("reputation", 10), -25, 50)
        disc_delta = clamp(args.get("discipline", 0), -25, 50)
        emp_delta = clamp(args.get("empathy", 0), -25, 50)
        next_state = apply_delta(state, rep_delta, disc_delta, emp_delta)
        idx = int(next_state.get("stage_index") or 0)
        stage_info = STAGES[idx] if 0 <= idx < len(STAGES) else STAGES[0]
        return {
            "state": next_state,
            "tool_result": {
                "ok": True,
                "stage": stage_info["label"],
                "route": resolve_route(next_state["discipline"], next_state["empathy"]),
                "reputation": next_state["reputation"],
                "discipline": next_state["discipline"],
                "empathy": next_state["empathy"],
            },
        }

    return {
        "state": state,
        "tool_result": {"ok": False, "error": f"Unknown action: {action}"},
    }


def on_after_generate(state, ctx):
    idx = int(state.get("stage_index") or 0)
    stage_info = STAGES[idx] if 0 <= idx < len(STAGES) else STAGES[0]
    append_markdown = state.get("pending_append_card") or ""
    next_state = dict(state)
    next_state["pending_append_card"] = ""
    return {
        "state": next_state,
        "portrait_url": stage_info["portrait"],
        "append_markdown": append_markdown,
    }


def render_memo(state, ctx):
    idx = int(state.get("stage_index") or 0)
    stage_info = STAGES[idx] if 0 <= idx < len(STAGES) else STAGES[0]
    reputation = clamp(state.get("reputation", 10), 0, 100)
    discipline = clamp(state.get("discipline", 20), 0, 100)
    empathy = clamp(state.get("empathy", 20), 0, 100)
    route = resolve_route(discipline, empathy)
    return "\\n".join([
        f"Stage: ((PILLS)) {stage_info['label']}, {route}",
        f"Reputation: ((BAR)) {reputation}/100",
        f"Discipline: ((BAR)) {discipline}/100",
        f"Empathy: ((BAR)) {empathy}/100",
    ])
`,
    },
];

/**
 * Reusable Python code pattern snippets for inserting into custom Game Scripts.
 */
export const SCRIPT_PYTHON_PATTERN_SNIPPETS = [
    {
        id: 'py_time_delta',
        label: 'Time Delta & Day Rollover (Python)',
        description: 'Reads ctx["time"]["deltaMinutes"] and ctx["time"]["dayChanged"] safely to drive decay or daily resets.',
        code: `time_info = ctx.get("time") or {}
delta_minutes = max(0, int(time_info.get("deltaMinutes") or 0))
day_changed = bool(time_info.get("dayChanged"))
if delta_minutes > 0:
    # Example: lose 1 point per 30 elapsed in-world minutes
    decay = delta_minutes // 30
    state["meter"] = max(0, int(state.get("meter", 100)) - decay)
if day_changed:
    state["daily_uses"] = 0`,
    },
    {
        id: 'py_bar_and_pills',
        label: 'BAR & PILLS Formatting (Python)',
        description: 'Formats ((BAR)) progress bars and ((PILLS)) status badges in render_memo.',
        code: `def render_memo(state, ctx):
    raw_statuses = state.get("statuses") or []
    statuses = ", ".join(raw_statuses) if raw_statuses else "Steady"
    meter = int(state.get("meter", 0))
    return "\\n".join([
        f"Meter: ((BAR)) {meter}/100",
        f"Status: ((PILLS)) {statuses}",
    ])`,
    },
    {
        id: 'py_clamp_and_tier',
        label: 'Clamp & Threshold Tier Lookup (Python)',
        description: 'Provides clamp(n, 0, 100) and a descending threshold lookup helper.',
        code: `def clamp(n, min_val=0, max_val=100):
    try:
        num = float(n)
    except (TypeError, ValueError):
        return min_val
    return max(min_val, min(max_val, round(num)))


def get_tier(score, tiers=None):
    if tiers is None:
        tiers = [
            {"min": 80, "label": "Master"},
            {"min": 40, "label": "Seasoned"},
            {"min": 0, "label": "Novice"},
        ]
    val = clamp(score, 0, 100)
    for tier in tiers:
        if val >= tier["min"]:
            return tier["label"]
    return tiers[-1]["label"]`,
    },
    {
        id: 'py_one_shot_prompt',
        label: 'One-Shot Prompt Injection (Python)',
        description: 'Consumes a queued event flag once and emits prompt_injection for the current turn only.',
        code: `prompt_injection = ""
if state.get("pending_cue"):
    prompt_injection = str(state["pending_cue"])
    state = {**state, "pending_cue": ""}
return {"state": state, "prompt_injection": prompt_injection} if prompt_injection else {"state": state}`,
    },
    {
        id: 'py_media_attachment',
        label: 'Deterministic Portrait & Append Markdown (Python)',
        description: 'Returns a deterministic portrait_url and consumes a one-shot append_markdown banner in on_after_generate.',
        code: `def on_after_generate(state, ctx):
    portrait_url = (
        "/assets/portraits/stage-2.png"
        if int(state.get("stage", 0)) >= 2
        else "/assets/portraits/stage-1.png"
    )
    append_markdown = state.get("pending_banner") or ""
    return {
        "state": {**state, "pending_banner": ""},
        "portrait_url": portrait_url,
        "append_markdown": append_markdown,
    }`,
    },
];

/**
 * Returns the starter template list for a given script language (`'js'` or `'python'`).
 *
 * @param {string} [lang='js']
 * @returns {Array<object>}
 */
export function getStarterTemplatesForLang(lang = 'js') {
    return String(lang).toLowerCase() === 'python'
        ? SCRIPT_PYTHON_STARTER_TEMPLATES
        : SCRIPT_STARTER_TEMPLATES;
}

/**
 * Returns the pattern snippet list for a given script language (`'js'` or `'python'`).
 *
 * @param {string} [lang='js']
 * @returns {Array<object>}
 */
export function getPatternSnippetsForLang(lang = 'js') {
    return String(lang).toLowerCase() === 'python'
        ? SCRIPT_PYTHON_PATTERN_SNIPPETS
        : SCRIPT_PATTERN_SNIPPETS;
}

/**
 * Looks up a starter template by ID across both JS and Python starter templates
 * and returns a deep-cloned copy, or null if not found.
 *
 * @param {string} id
 * @returns {object | null}
 */
export function getStarterTemplateById(id) {
    if (typeof id !== 'string' || !id) {
        return null;
    }
    const found =
        SCRIPT_STARTER_TEMPLATES.find((tpl) => tpl.id === id) ||
        SCRIPT_PYTHON_STARTER_TEMPLATES.find((tpl) => tpl.id === id);
    return found ? deepClone(found) : null;
}
