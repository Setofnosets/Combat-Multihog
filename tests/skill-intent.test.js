import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sendStateRequest } = vi.hoisted(() => ({ sendStateRequest: vi.fn() }));
vi.mock('../llm-client.js', () => ({ sendStateRequest }));

import {
    classifySkillIntent,
} from '../src/features/tactical-combat/tactical-combat-classifiers.js';
import {
    buildFallbackEnemies,
    buildEncounterFromContext,
    collectEncounterContext,
} from '../src/features/tactical-combat/tactical-combat-context.js';
import { createEncounterState, normalizeSkillList } from '../src/features/tactical-combat/tactical-combat-engine.js';
import { buildTacticalCombatMarkup } from '../src/features/tactical-combat/tactical-combat-markup.js';
import {
    hasPendingSkillIntents,
    resolvePendingSkillIntents,
} from '../src/features/tactical-combat/tactical-combat-agent.js';
import {
    createEmptySkillRegistry,
    findSkillRegistryEntry,
    upsertSkillRegistryEntry,
} from '../src/features/skill-registry/skill-registry.js';

function settingsFor(memo = '') {
    return {
        currentMemo: memo,
        skillRegistry: createEmptySkillRegistry(),
        tacticalCombatMovement: 6,
        tacticalCombatTerrainTheme: 'auto',
        tacticalCombatGridPreset: '15x15',
        tacticalCombatTurnStyle: 'phase',
        tacticalCombatTerrainDensity: 35,
        tacticalCombatEncounterSource: 'auto',
        tacticalCombatAgentPrompt: 'agent',
        tacticalCombatSpecialPrompt: 'special',
        traditionalCombatSpecialPrompt: 'special',
        tacticalCombatConnectionSource: 'default',
        tacticalCombatMaxTokens: 4000,
    };
}

const BASE_MEMO = `[CHARACTER]
Aria (Mystic): 30/30 HP
Status: Healthy
[/CHARACTER]

[ABILITIES]
- Telepathic Link (communicate mentally with allies)
- Arcane Recovery (recover spell slots; 1/1 per rest)
- Silver Tongue (a quick lie)
- Nimble Escape (disengage as a bonus action)
- Shield Bash (strike with a shield; 2d6)
- Second Wind (recover 1d8+2 HP; 1/1 per rest)
- Firebolt (ranged spell attack for 1d10 fire damage)
[/ABILITIES]`;

describe('skill intent classification', () => {
    it('never turns an unmarked utility, social, or recovery ability into an attack', () => {
        const settings = settingsFor(BASE_MEMO);
        const context = collectEncounterContext(settings, { name1: 'Aria', chatId: 'intent-base', chat: [] });
        const byName = Object.fromEntries(context.playerUnits[0].skills.map(skill => [skill.name, skill]));

        expect(byName['Telepathic Link']).toMatchObject({
            intent: 'noncombat',
            kind: 'special',
            noncombat: true,
            damage: '',
        });
        expect(byName['Arcane Recovery']).toMatchObject({
            intent: 'noncombat',
            noncombat: true,
            uses: 1,
            maxUses: 1,
        });
        expect(byName['Silver Tongue']).toMatchObject({ intent: 'noncombat', noncombat: true });
        expect(byName['Nimble Escape']).toMatchObject({
            intent: 'utility',
            kind: 'special',
            utility: true,
            damage: '',
        });
        expect(byName['Shield Bash']).toMatchObject({ intent: 'attack', kind: 'attack', damage: '2d6' });
        expect(byName['Second Wind']).toMatchObject({ intent: 'heal', kind: 'heal', heal: '1d8+2' });
        expect(byName.Firebolt).toMatchObject({ intent: 'attack', kind: 'attack', damage: '1d10' });
    });

    it('keeps noncombat skills in the context for registry discovery but removes them from the battle state', () => {
        const settings = settingsFor(BASE_MEMO);
        const context = collectEncounterContext(settings, { name1: 'Aria', chatId: 'intent-filter', chat: [] });
        const normalized = normalizeSkillList(context.playerUnits[0].skills, 'player');
        const names = normalized.map(skill => skill.name);
        expect(names).not.toContain('Telepathic Link');
        expect(names).not.toContain('Arcane Recovery');
        expect(names).not.toContain('Silver Tongue');
        expect(names).toContain('Nimble Escape');
        expect(names).toContain('Shield Bash');
    });

    it('keeps explicit attack, heal, buff, and Willpower intent intact', () => {
        expect(classifySkillIntent('Dread Wail', 'Will damage 2d6, 6 cells, 1/1; on Willpower break: flee')).toMatchObject({
            intent: 'attack',
            resource: 'willpower',
            willpowerOutcome: 'flee',
        });
        expect(classifySkillIntent('Psychic Lance', '2d6 HP + 1d6 Willpower')).toMatchObject({
            intent: 'attack',
            resource: 'both',
        });
        expect(classifySkillIntent('Mind Ward', 'Will heal 1d6, self')).toMatchObject({
            intent: 'heal',
            resource: 'willpower',
        });
        expect(classifySkillIntent('Fearless Stance', 'Stand firm against terror')).toMatchObject({
            resource: 'hp',
        });
        expect(classifySkillIntent('Shield', 'Raise a ward')).toMatchObject({ intent: 'buff' });
        expect(classifySkillIntent('Rallying Aura', 'Allies within 2 cells gain +1 AC')).toMatchObject({ intent: 'buff' });
        expect(classifySkillIntent('Bless', 'Add 1d4 to attack rolls')).toMatchObject({ intent: 'buff' });
        expect(classifySkillIntent('Shield Bash', 'Strike with a shield; 2d6')).toMatchObject({ intent: 'attack' });
    });

    it('does not let a stale confirmed attack registry entry override a newly parsed noncombat skill', () => {
        const settings = settingsFor(`[CHARACTER]
Aria (Mystic): 30/30 HP
[ABILITIES]
- Telepathic Link (communicate mentally with allies)
[/ABILITIES]
Status: Healthy
[/CHARACTER]`);
        upsertSkillRegistryEntry(settings.skillRegistry, {
            name: 'Telepathic Link',
            source: 'memo',
            status: 'confirmed',
            mechanics: { kind: 'attack', damage: '1d8' },
        });
        const context = collectEncounterContext(settings, { name1: 'Aria', chatId: 'intent-stale', chat: [] });
        const skill = context.playerUnits[0].skills.find(entry => entry.name === 'Telepathic Link');
        expect(skill).toMatchObject({ intent: 'noncombat', kind: 'special', damage: '', noncombat: true });
        // The registry itself is not migrated; only the newly parsed skill's
        // runtime intent is corrected.
        expect(findSkillRegistryEntry(settings, 'Telepathic Link').mechanics.kind).toBe('attack');
    });

    it('adds fallback attacks when every parsed skill is noncombat', () => {
        const memo = `[CHARACTER]
Aria (Mystic): 30/30 HP
[ABILITIES]
- Telepathic Link (communicate mentally with allies)
[/ABILITIES]
Status: Healthy
[/CHARACTER]`;
        const settings = settingsFor(memo);
        const context = collectEncounterContext(settings, { name1: 'Aria', chatId: 'intent-fallback', chat: [] });
        const active = context.playerUnits[0].skills.filter(skill => !skill.noncombat);
        expect(active.length).toBeGreaterThan(0);
        expect(active.every(skill => skill.source === 'fallback')).toBe(true);
    });
});

describe('AI skill intent pass', () => {
    beforeEach(() => {
        sendStateRequest.mockReset();
    });

    it('classifies ambiguous skills as passive, utility, or noncombat', async () => {
        sendStateRequest.mockResolvedValue(JSON.stringify({
            skills: [
                { name: 'Umbral Step', intent: 'passive', note: 'always-on shadow movement' },
                { name: 'Star Whisper', intent: 'noncombat', note: 'communication only' },
                { name: 'Phase Shift', intent: 'utility', note: 'battlefield movement' },
            ],
        }));
        const memo = `[CHARACTER]
Aria (Mystic): 30/30 HP
[ABILITIES]
- Umbral Step (you may move through shadows; 1/1 per rest)
- Star Whisper (speak to distant stars)
- Phase Shift (shift out of phase)
[/ABILITIES]
Status: Healthy
[/CHARACTER]`;
        const settings = settingsFor(memo);
        const context = collectEncounterContext(settings, { name1: 'Aria', chatId: 'vitest-chat', chat: [] });
        expect(hasPendingSkillIntents(context)).toBe(true);
        const result = await resolvePendingSkillIntents(context, settings, { chatId: 'vitest-chat' });
        expect(result.changed).toBeGreaterThan(0);
        const byName = Object.fromEntries(context.playerUnits[0].skills.map(skill => [skill.name, skill]));
        expect(byName['Umbral Step']).toMatchObject({
            intent: 'passive',
            passive: true,
            kind: 'special',
            damage: '',
            unlimited: true,
        });
        expect(byName['Star Whisper']).toMatchObject({ intent: 'noncombat', noncombat: true, damage: '' });
        expect(byName['Phase Shift']).toMatchObject({ intent: 'utility', utility: true, damage: '' });
        expect(hasPendingSkillIntents(context)).toBe(false);
    });

    it('keeps safe utility fallbacks and warns when classification fails', async () => {
        sendStateRequest.mockRejectedValue(new Error('offline'));
        const memo = `[CHARACTER]
Aria (Mystic): 30/30 HP
[ABILITIES]
- Void Murmur (whisper across the void)
[/ABILITIES]
Status: Healthy
[/CHARACTER]`;
        const settings = settingsFor(memo);
        const context = collectEncounterContext(settings, { name1: 'Aria', chatId: 'vitest-chat', chat: [] });
        const skill = context.playerUnits[0].skills.find(entry => entry.name === 'Void Murmur');
        expect(skill).toMatchObject({ intent: 'unknown', kind: 'special', utility: true, damage: '' });
        const result = await resolvePendingSkillIntents(context, settings, { chatId: 'vitest-chat' });
        expect(result.warnings.some(warning => /classification failed/i.test(warning))).toBe(true);
        expect(skill.kind).toBe('special');
        expect(skill.noncombat).not.toBe(true);
    });
});

describe('utility intent markup and battle state', () => {
    it('builds a playable encounter without exposing noncombat skills to units', () => {
        const settings = settingsFor(BASE_MEMO);
        const context = collectEncounterContext(settings, { name1: 'Aria', chatId: 'intent-build', chat: [] });
        const enemies = buildFallbackEnemies(context, 3);
        const { state } = buildEncounterFromContext({ ...context, enemies, existingCombat: true }, settings, { source: 'existing', seed: 4 });
        const pc = state.units.find(unit => unit.side === 'player');
        expect(pc.skills.some(skill => skill.name === 'Telepathic Link')).toBe(false);
        expect(pc.skills.some(skill => skill.name === 'Nimble Escape' && skill.utility === true)).toBe(true);
    });

    it('renders utility skills in their own pane and passives in the passives pane', () => {
        const state = createEncounterState({
            seed: 2,
            grid: { rows: 5, cols: 5 },
            units: [{
                id: 'pc-1',
                name: 'Aria',
                side: 'player',
                maxHp: 20,
                hp: 20,
                skills: [
                    { name: 'Firebolt', kind: 'attack', damage: '1d10', range: 6, unlimited: true },
                    { name: 'Nimble Escape', kind: 'special', intent: 'utility', utility: true, range: 6, unlimited: true },
                    { name: 'Pack Tactics', kind: 'special', passive: true, unlimited: true },
                ],
            }, {
                id: 'enemy-2',
                name: 'Goblin',
                side: 'enemy',
                maxHp: 10,
                hp: 10,
                ac: 12,
                attackBonus: 3,
                damage: '1d6',
            }],
        });
        state.units[0].x = 1;
        state.units[0].y = 1;
        state.units[1].x = 3;
        state.units[1].y = 1;
        const html = buildTacticalCombatMarkup(state, { selectedUnitId: 'pc-1', mode: 'skill' });
        expect(html).toContain('Skills & spells');
        expect(html).toContain('Utility');
        expect(html).toContain('UTILITY');
        expect(html).toContain('Passives');
        expect(html).toContain('PASSIVE');
    });
});
