import { describe, expect, it } from 'vitest';
import * as ui from '../src/features/traditional-combat/traditional-combat-ui.js';
import * as router from '../src/features/combat/combat-ui-router.js';
import * as modeSettings from '../src/features/combat/combat-mode-settings.js';

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
});
