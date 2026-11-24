import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
    applyHydratedCardFields,
    createCharacterCardHydrator,
    getCharacterCardField,
    getCharacterCardPreviewText,
    hasHydratableAvatar,
    hydrateCharacterCards,
    isShallowCharacterCard,
    mergeHydratedCharacterCard,
    normalizeListedCharacterCard,
} from '../src/state/character-cards.js';

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

describe('character card shallow detection and normalization', () => {
    it('detects TauriTavern shallow cards (shallow: true with empty strings)', () => {
        const card = {
            name: 'Alice',
            avatar: 'Alice.png',
            description: '',
            personality: '',
            scenario: '',
            first_mes: '',
            shallow: true,
        };
        expect(isShallowCharacterCard(card)).toBe(true);
        const listed = normalizeListedCharacterCard(card);
        expect(listed.shallow).toBe(true);
        expect(listed.avatar).toBe('Alice.png');
    });

    it('detects SillyTavern lazyLoadCharacters shallow cards (shallow: true with omitted text fields)', () => {
        const card = {
            name: 'Bob',
            avatar: 'Bob.png',
            shallow: true,
            data: { name: 'Bob', creator_notes: 'note' },
        };
        expect(isShallowCharacterCard(card)).toBe(true);
        expect(normalizeListedCharacterCard(card).shallow).toBe(true);
    });

    it('treats full SillyTavern cards (including blank cards) as non-shallow', () => {
        const blankFullCard = {
            name: 'Game Master',
            avatar: 'Game Master.png',
            description: '',
            personality: '',
            scenario: '',
            first_mes: '',
        };
        expect(isShallowCharacterCard(blankFullCard)).toBe(false);
        expect(normalizeListedCharacterCard(blankFullCard).shallow).toBe(false);
    });

    it('extracts and lifts V2 data.* fields when top-level fields are empty', () => {
        const base = normalizeListedCharacterCard({ name: 'Lyra', avatar: 'Lyra.png', shallow: true });
        const full = {
            name: 'Lyra',
            avatar: 'Lyra.png',
            description: '',
            personality: '',
            data: {
                name: 'Lyra',
                description: 'A sharp-eyed ranger from the northern woods.',
                personality: 'Calm, observant, loyal.',
                scenario: 'Camped beside the ruins.',
                first_mes: 'She checks the perimeter.',
            },
        };
        const merged = mergeHydratedCharacterCard(base, full);
        expect(merged.shallow).toBe(false);
        expect(merged.description).toBe('A sharp-eyed ranger from the northern woods.');
        expect(merged.personality).toBe('Calm, observant, loyal.');
        expect(merged.scenario).toBe('Camped beside the ruins.');
        expect(merged.first_mes).toBe('She checks the perimeter.');
        expect(getCharacterCardField(full, 'description')).toBe('A sharp-eyed ranger from the northern woods.');
        expect(getCharacterCardPreviewText(merged, { maxLength: 20 })).toBe('A sharp-eyed ranger ');
    });

    it('checks hydratable avatars without mutating exact filenames', () => {
        expect(hasHydratableAvatar({ avatar: ' Alice#1.png' })).toBe(true);
        expect(hasHydratableAvatar({ avatar: 'none' })).toBe(false);
        expect(hasHydratableAvatar({ avatar: '' })).toBe(false);
        expect(hasHydratableAvatar({ avatar: '   ' })).toBe(false);
    });
});

describe('createCharacterCardHydrator', () => {
    it('fetches /api/characters/get with exact avatar_url verbatim and caches results', async () => {
        const requests = [];
        const fetchImpl = vi.fn(async (url, init) => {
            requests.push({ url, init, body: JSON.parse(init.body) });
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    name: 'Alice',
                    avatar: ' Alice#1.png',
                    description: 'Full description from backend',
                    personality: 'Curious',
                    shallow: false,
                }),
            };
        });

        const hydrator = createCharacterCardHydrator({
            fetchImpl,
            getHeaders: () => ({ 'X-CSRF-Token': 'tok-123' }),
        });

        const shallowCard = normalizeListedCharacterCard({
            name: 'Alice',
            avatar: ' Alice#1.png',
            description: '',
            personality: '',
            shallow: true,
        });

        const first = await hydrator.hydrate(shallowCard, { strict: true });
        expect(first.shallow).toBe(false);
        expect(first.description).toBe('Full description from backend');
        expect(first.personality).toBe('Curious');

        // Exact avatar filename preserved (leading space + #1 untouched)
        expect(requests).toHaveLength(1);
        expect(requests[0].url).toBe('/api/characters/get');
        expect(requests[0].body).toEqual({ avatar_url: ' Alice#1.png' });
        expect(requests[0].init.headers['X-CSRF-Token']).toBe('tok-123');
        expect(requests[0].init.headers['Content-Type']).toBe('application/json');

        // Second call hits cache without another fetch
        const second = await hydrator.hydrate(shallowCard, { strict: true });
        expect(second.description).toBe('Full description from backend');
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('skips network fetch for cards that are already full', async () => {
        const fetchImpl = vi.fn();
        const hydrator = createCharacterCardHydrator({ fetchImpl });

        const fullCard = normalizeListedCharacterCard({
            name: 'Mira',
            avatar: 'Mira.png',
            description: 'Already loaded.',
            personality: 'Steady.',
        });

        const result = await hydrator.hydrate(fullCard, { strict: true });
        expect(result.description).toBe('Already loaded.');
        expect(result.shallow).toBe(false);
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('deduplicates concurrent preview + explicit import fetches for the same avatar', async () => {
        const gate = deferred();
        const fetchImpl = vi.fn(async () => gate.promise);
        const hydrator = createCharacterCardHydrator({ fetchImpl });

        const card = normalizeListedCharacterCard({
            name: 'Kael',
            avatar: 'Kael.png',
            shallow: true,
        });

        const previewPromise = hydrator.hydrate(card, { strict: false });
        const importPromise = hydrator.hydrate(card, { strict: true });

        expect(fetchImpl).toHaveBeenCalledTimes(1);

        gate.resolve({
            ok: true,
            status: 200,
            json: async () => ({
                name: 'Kael',
                avatar: 'Kael.png',
                description: 'Battle-hardened mercenary.',
                personality: 'Stoic.',
            }),
        });

        const [fromPreview, fromImport] = await Promise.all([previewPromise, importPromise]);
        expect(fromPreview.description).toBe('Battle-hardened mercenary.');
        expect(fromImport.description).toBe('Battle-hardened mercenary.');
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('does not cache failed hydrations, allowing strict retry on explicit import', async () => {
        let attempt = 0;
        const fetchImpl = vi.fn(async () => {
            attempt += 1;
            if (attempt === 1) {
                return { ok: false, status: 500, json: async () => ({}) };
            }
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    name: 'Nora',
                    avatar: 'Nora.png',
                    description: 'Recovered description',
                }),
            };
        });

        const hydrator = createCharacterCardHydrator({ fetchImpl });
        const card = normalizeListedCharacterCard({ name: 'Nora', avatar: 'Nora.png', shallow: true });

        // Preview-mode non-strict call falls back gracefully without caching failure
        const failed = await hydrator.hydrate(card, { strict: false });
        expect(failed.shallow).toBe(true);

        // Explicit retry succeeds
        const retried = await hydrator.hydrate(card, { strict: true });
        expect(retried.shallow).toBe(false);
        expect(retried.description).toBe('Recovered description');
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('throws when strict hydration fails so callers do not import an empty card', async () => {
        const fetchImpl = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }));
        const hydrator = createCharacterCardHydrator({ fetchImpl });
        const card = normalizeListedCharacterCard({ name: 'Ghost', avatar: 'Ghost.png', shallow: true });

        await expect(hydrator.hydrate(card, { strict: true })).rejects.toThrow(/Ghost/);
    });

    it('lazily hydrates visible rows with bounded concurrency and honors abort signal', async () => {
        let active = 0;
        let maxActive = 0;
        const gates = new Map();
        const fetchImpl = vi.fn(async (_url, init) => {
            const { avatar_url } = JSON.parse(init.body);
            active += 1;
            maxActive = Math.max(maxActive, active);
            const g = deferred();
            gates.set(avatar_url, g);
            try {
                return await g.promise;
            } finally {
                active -= 1;
            }
        });

        const hydrator = createCharacterCardHydrator({ fetchImpl, concurrency: 2 });
        const cards = ['A', 'B', 'C', 'D'].map(name =>
            normalizeListedCharacterCard({ name, avatar: `${name}.png`, shallow: true }),
        );

        const controller = new AbortController();
        const hydratedNames = [];
        const batch = hydrator.hydrateVisible(cards, {
            signal: controller.signal,
            onHydrated: (card, full) => {
                applyHydratedCardFields(card, full);
                hydratedNames.push(card.name);
            },
        });

        // Wait a tick for workers to start
        await Promise.resolve();
        expect(maxActive).toBe(2);
        expect(gates.size).toBe(2);

        // Abort before resolving — remaining cards C and D should never be fetched
        controller.abort();
        for (const [avatar, g] of gates.entries()) {
            g.resolve({
                ok: true,
                status: 200,
                json: async () => ({ name: avatar.replace('.png', ''), avatar, description: `Desc ${avatar}` }),
            });
        }
        await batch;

        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(hydratedNames).toEqual([]);
    });

    it('hydrates mixed batches in order via hydrateCharacterCards', async () => {
        const fetchImpl = vi.fn(async (_url, init) => {
            const { avatar_url } = JSON.parse(init.body);
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    name: avatar_url.replace('.png', ''),
                    avatar: avatar_url,
                    description: `Hydrated ${avatar_url}`,
                }),
            };
        });

        const cards = [
            { name: 'FullOne', avatar: 'FullOne.png', description: 'Local desc', personality: '' },
            { name: 'ShallowOne', avatar: 'ShallowOne.png', description: '', personality: '', shallow: true },
        ];

        const results = await hydrateCharacterCards(cards, { fetchImpl });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(results.map(c => c.description)).toEqual(['Local desc', 'Hydrated ShallowOne.png']);
    });
});

describe('framework call-site wiring for shallow character cards', () => {
    const panelSource = readFileSync(new URL('../src/ui/panel/panel-builder.js', import.meta.url), 'utf8');
    const creatorSource = readFileSync(new URL('../character-creator.js', import.meta.url), 'utf8');

    it('wires lazy preview and strict click hydration in NPC Manager From Card tab', () => {
        expect(panelSource).toContain('allChars = (Array.isArray(raw) ? raw : []).map(normalizeListedCharacterCard);');
        expect(panelSource).toContain('cardHydrator.hydrateVisible(cardsToHydrate');
        expect(panelSource).toContain('await cardHydrator.hydrate(char, { strict: true })');
    });

    it('wires batch hydration for Map Architect selected character card context', () => {
        expect(panelSource).toContain('await hydrateCharacterCards(form.selectedCharacterCards');
    });

    it('wires lazy preview and strict import hydration in PC Import', () => {
        expect(creatorSource).toContain('.map(normalizeListedCharacterCard)');
        expect(creatorSource).toContain('cardHydrator.hydrateVisible(cardsToHydrate');
        expect(creatorSource).toContain('await cardHydrator.hydrate(char, { strict: true })');
    });
});
