import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

describe('skill registry persistence contract', () => {
    it('adds a per-chat registry default and chat rename key', () => {
        expect(read('src/state/defaults.js')).toContain('skillRegistry: createEmptySkillRegistry()');
        expect(read('src/state/defaults.js')).toContain('skillRegistryLorebookMirror: true');
        expect(read('src/features/chat/chat-rename-migrate.js')).toContain("'skillRegistry'");
    });

    it('snapshots and restores the registry with the chat partition', () => {
        const persistence = read('src/state/chat-persistence.js');
        expect(persistence).toContain('skillRegistry: JSON.parse(JSON.stringify');
        const loader = read('src/features/chat/chat-state-loader.js');
        expect(loader).toContain('s.skillRegistry = normalizeSkillRegistry(saved.skillRegistry).registry');
        expect(loader).toContain('hydrateSkillRegistryFromLorebook');
    });

    it('clears an unseen chat registry instead of leaking the previous chat', () => {
        const index = read('index.js');
        expect(index).toContain('s.skillRegistry = createEmptySkillRegistry()');
    });

    it('exposes a campaign registry editor and privacy-preserving mirror toggle', () => {
        const html = read('settings.html');
        expect(html).toContain('id="rpg_tactical_combat_skill_registry"');
        expect(html).toContain('id="rpg_tactical_combat_skill_registry_status"');
        expect(html).toContain('id="rpg_tactical_combat_skill_registry_mirror"');
        expect(html).toContain('id="rpg_tactical_combat_skill_registry_keywords"');
    });
});
