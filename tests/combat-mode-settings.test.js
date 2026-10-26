import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const settingsHtml = readFileSync(new URL('../settings.html', import.meta.url), 'utf8');
const style = readFileSync(new URL('../style.css', import.meta.url), 'utf8');
const settingsSource = readFileSync(
    new URL('../src/features/combat/combat-mode-settings.js', import.meta.url),
    'utf8',
);

describe('Combat style settings contract', () => {
    it('ships the open-encounter panel next to the style selector', () => {
        const selectIndex = settingsHtml.indexOf('id="rpg_combat_style"');
        const panelIndex = settingsHtml.indexOf('id="rpg_combat_active_encounters"');
        expect(selectIndex).toBeGreaterThan(-1);
        expect(panelIndex).toBeGreaterThan(selectIndex);
        expect(settingsHtml).toContain('id="rpg_combat_active_encounters_list"');
        expect(settingsHtml).toContain('id="rpg_combat_clear_encounters"');
        expect(style).toContain('.rt-tc-open-encounter');
    });

    it('wires the guard to name the offending chats and clear them', () => {
        expect(settingsSource).toContain('listActiveCombatBoards');
        expect(settingsSource).toContain('clearActiveCombatEncounters');
        expect(settingsSource).toContain('refreshCombatEncountersUi');
        expect(settingsSource).toContain('rt_tactical_combat_changed');
        expect(settingsSource).toContain('rt_traditional_combat_changed');
    });
});
