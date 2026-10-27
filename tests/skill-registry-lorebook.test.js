import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getSettings } from '../state-manager.js';
import {
    createEmptySkillRegistry,
    findSkillRegistryEntry,
    upsertSkillRegistryEntry,
} from '../src/features/skill-registry/skill-registry.js';
import {
    hydrateSkillRegistryFromLorebook,
    mirrorSkillRegistryToLorebook,
} from '../src/features/skill-registry/skill-lorebook.js';
import { persistSkillRegistry } from '../src/features/skill-registry/skill-registry-store.js';

const baseContext = globalThis.SillyTavern.getContext;
const baseChatId = globalThis._rpgCurrentChatId;
let savedBook = null;
let ctx = null;

beforeEach(() => {
    globalThis._rpgCurrentChatId = () => 'vitest-chat';
    const settings = getSettings();
    for (const key of Object.keys(settings)) delete settings[key];
    Object.assign(settings, {
        chatStates: {},
        routerCampaignPrefix: 'TestCampaign',
        routerCampaignPrefixOverride: 'TestCampaign',
        routerCampaignPrefixOverrideAnchorChatId: 'vitest-chat',
        skillRegistry: createEmptySkillRegistry(),
        skillRegistryLorebookMirror: true,
        skillRegistryLorebookKeywords: false,
        routerDefaultOrder: 100,
        routerDefaultPosition: 0,
        routerDefaultDepth: 4,
    });
    savedBook = null;
    ctx = {
        extensionSettings: settings,
        chatId: 'vitest-chat',
        saveSettingsDebounced() {},
        getRequestHeaders() { return {}; },
        async loadWorldInfo() { return savedBook; },
        async saveWorldInfo(name, book) { savedBook = JSON.parse(JSON.stringify(book)); },
        async updateWorldInfoList() {},
    };
    globalThis.SillyTavern.getContext = () => ctx;
});

afterEach(() => {
    globalThis.SillyTavern.getContext = baseContext;
    globalThis._rpgCurrentChatId = baseChatId;
});

describe('skill registry lorebook mirror', () => {
    it('writes a managed skill entry with machine-readable metadata', async () => {
        const settings = getSettings();
        upsertSkillRegistryEntry(settings.skillRegistry, {
            name: 'Dread Wail',
            type: 'ability',
            brief: 'A wail that breaks resolve.',
            source: 'resolver',
            status: 'resolved',
            mechanics: {
                kind: 'special',
                effectTemplate: [{ type: 'damage', target: '$target', amount: '2d6', resource: 'willpower' }],
            },
        });
        const changed = await mirrorSkillRegistryToLorebook(settings, { chatId: 'vitest-chat' });
        expect(changed).toBe(1);
        expect(savedBook.name).toMatch(/_Skills$/);
        expect(savedBook.name.toLowerCase()).toContain('vitest');
        expect(savedBook.name.toLowerCase()).toContain('skills');
        const entry = Object.values(savedBook.entries)[0];
        expect(entry.comment).toBe('Dread Wail');
        expect(entry.disable).toBe(true);
        expect(entry.extensions.multihogManaged).toBe(true);
        expect(entry.extensions.multihogSkill.mechanics.effectTemplate[0].amount).toBe('2d6');
        expect(entry.content).toContain('Effect:');
    });

    it('removes managed mirror entries when the registry entry is cleared', async () => {
        const settings = getSettings();
        upsertSkillRegistryEntry(settings.skillRegistry, {
            name: 'Dread Wail',
            source: 'resolver',
            status: 'resolved',
            mechanics: {
                kind: 'special',
                effectTemplate: [{ type: 'damage', target: '$target', amount: '2d6' }],
            },
        });
        await mirrorSkillRegistryToLorebook(settings, { chatId: 'vitest-chat' });
        expect(Object.keys(savedBook.entries)).toHaveLength(1);
        settings.skillRegistry.skills = {};
        await mirrorSkillRegistryToLorebook(settings, { chatId: 'vitest-chat' });
        expect(Object.keys(savedBook.entries)).toHaveLength(0);
    });

    it('mirrors class skeletons and restores them', async () => {
        const settings = getSettings();
        settings.skillRegistry.classes.wizard = {
            id: 'wizard',
            name: 'Wizard',
            brief: 'Arcane scholar.',
            skillIds: ['Fireball', 'Shield'],
            source: 'memo',
            owners: [{ type: 'character', name: 'Mira' }],
        };
        await mirrorSkillRegistryToLorebook(settings, { chatId: 'vitest-chat' });
        const classEntry = Object.values(savedBook.entries).find(entry => entry.comment === 'Class: Wizard');
        expect(classEntry).toBeTruthy();
        expect(classEntry.extensions.multihogClass.skillIds).toContain('Fireball');

        const targetSettings = getSettings();
        targetSettings.skillRegistry = createEmptySkillRegistry();
        await hydrateSkillRegistryFromLorebook(targetSettings, { chatId: 'vitest-chat' });
        expect(targetSettings.skillRegistry.classes.wizard.skillIds).toContain('Shield');
    });

    it('hydrates missing registry entries from the mirror without clobbering existing ones', async () => {
        const sourceSettings = getSettings();
        upsertSkillRegistryEntry(sourceSettings.skillRegistry, {
            name: 'Dread Wail',
            source: 'resolver',
            status: 'resolved',
            mechanics: {
                kind: 'special',
                effectTemplate: [{ type: 'damage', target: '$target', amount: '2d6' }],
            },
        });
        await mirrorSkillRegistryToLorebook(sourceSettings, { chatId: 'vitest-chat' });

        const targetSettings = getSettings();
        targetSettings.skillRegistry = createEmptySkillRegistry();
        const changed = await hydrateSkillRegistryFromLorebook(targetSettings, { chatId: 'vitest-chat' });
        expect(changed).toBe(1);
        expect(findSkillRegistryEntry(targetSettings, 'Dread Wail').mechanics.effectTemplate[0].amount).toBe('2d6');
    });

    it('snapshots the registry and schedules the mirror even outside a board persist', async () => {
        const settings = getSettings();
        settings.chatStates['vitest-chat'] = { campaignBooks: [] };
        upsertSkillRegistryEntry(settings.skillRegistry, {
            name: 'Cinder Burst',
            source: 'resolver',
            status: 'resolved',
            mechanics: {
                kind: 'special',
                effectTemplate: [{ type: 'damage', target: '$target', amount: '2d6' }],
            },
        });
        expect(persistSkillRegistry(settings, 'vitest-chat')).toBe(true);
        expect(findSkillRegistryEntry(settings.chatStates['vitest-chat'].skillRegistry, 'Cinder Burst')).toBeTruthy();
        await new Promise(resolve => setTimeout(resolve, 1700));
        expect(Object.values(savedBook.entries || {}).some(entry => entry.comment === 'Cinder Burst')).toBe(true);
        expect(settings.chatStates['vitest-chat'].campaignBooks.some(name => name.endsWith('_Skills'))).toBe(true);
    });
});
