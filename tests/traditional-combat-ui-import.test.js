import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as ui from '../src/features/traditional-combat/traditional-combat-ui.js';
import * as router from '../src/features/combat/combat-ui-router.js';
import * as modeSettings from '../src/features/combat/combat-mode-settings.js';

const uiSource = readFileSync(new URL('../src/features/traditional-combat/traditional-combat-ui.js', import.meta.url), 'utf8');

describe('traditional combat UI module', () => {
    it('exports lifecycle and narrator entry points without touching the DOM at import time', () => {
        expect(typeof ui.startTraditionalCombatFromNarrator).toBe('function');
        expect(typeof ui.startTraditionalCombatFlow).toBe('function');
        expect(typeof ui.openTraditionalCombatBoard).toBe('function');
        expect(typeof ui.onTraditionalCombatChatChanged).toBe('function');
        expect(typeof ui.resetTraditionalCombatEncounter).toBe('function');
        expect(typeof router.installCombatUiRouter).toBe('function');
        expect(typeof modeSettings.bindCombatModeSettings).toBe('function');
    });

    it('scrolls the combat log to the newest entry after each render', () => {
        expect(uiSource).toContain("host.querySelector('.rt-tc-log-list')");
        expect(uiSource).toContain('log.scrollTop = log.scrollHeight');
    });
});
