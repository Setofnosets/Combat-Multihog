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
 * Looks up a starter template by ID and returns a deep-cloned copy, or null if not found.
 *
 * @param {string} id
 * @returns {object | null}
 */
export function getStarterTemplateById(id) {
    if (typeof id !== 'string' || !id) {
        return null;
    }
    const found = SCRIPT_STARTER_TEMPLATES.find((tpl) => tpl.id === id);
    return found ? deepClone(found) : null;
}
