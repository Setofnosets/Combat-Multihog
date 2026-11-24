/**
 * Shared helpers for hydrating shallow (lazy-loaded) SillyTavern / TauriTavern
 * character cards on demand via POST /api/characters/get.
 *
 * Background:
 * - Upstream SillyTavern returns shallow character objects from /api/characters/all
 *   when `performance.lazyLoadCharacters` is enabled.
 * - TauriTavern always returns shallow character objects (`shallow: true` with
 *   empty description/personality/scenario/first_mes) from /api/characters/all
 *   and expects callers to fetch full card payloads via POST /api/characters/get
 *   with `{ avatar_url: card.avatar }` (exact avatar filename, never transformed).
 */

const CARD_TEXT_FIELDS = Object.freeze([
    'description',
    'personality',
    'scenario',
    'first_mes',
    'mes_example',
    'creator_notes',
]);

/**
 * Returns true when `card.avatar` is a concrete filename usable with `/api/characters/get`.
 * Never trims or rewrites `avatar` because TauriTavern treats `avatar_url` as an exact filename.
 * @param {any} card
 * @returns {boolean}
 */
export function hasHydratableAvatar(card) {
    return typeof card?.avatar === 'string'
        && card.avatar.trim().length > 0
        && card.avatar !== 'none';
}

/**
 * Picks a character card text field from either V1 top-level or V2 `data.*`.
 * @param {any} card
 * @param {string} field
 * @returns {string}
 */
export function getCharacterCardField(card, field) {
    if (!card || typeof card !== 'object') return '';
    const top = card[field];
    const nested = card.data && typeof card.data === 'object' ? card.data[field] : undefined;
    if (typeof top === 'string' && top.length > 0) return top;
    if (typeof nested === 'string' && nested.length > 0) return nested;
    if (typeof top === 'string') return top;
    if (typeof nested === 'string') return nested;
    return '';
}

/**
 * Detects whether a character card is shallow and needs `/api/characters/get` hydration.
 * @param {any} card
 * @returns {boolean}
 */
export function isShallowCharacterCard(card) {
    if (!card || typeof card !== 'object') return false;
    if (card.shallow === true) return true;
    if (card.shallow === false) return false;
    if (!hasHydratableAvatar(card)) return false;
    const data = card.data && typeof card.data === 'object' ? card.data : null;
    return card.description === undefined
        && card.personality === undefined
        && data?.description === undefined
        && data?.personality === undefined;
}

/**
 * Builds the short preview line shown in character card pickers.
 * @param {any} card
 * @param {{ maxLength?: number, fallback?: string }} [options]
 * @returns {string}
 */
export function getCharacterCardPreviewText(card, { maxLength = 120, fallback = 'No description' } = {}) {
    const text = getCharacterCardField(card, 'description')
        || getCharacterCardField(card, 'personality')
        || fallback;
    return String(text).substring(0, maxLength);
}

/**
 * Normalizes a character list entry from `/api/characters/all` while preserving
 * `shallow` so lazy-loaded cards can be hydrated on demand.
 * @param {any} raw
 * @returns {object}
 */
export function normalizeListedCharacterCard(raw) {
    const shallow = isShallowCharacterCard(raw);
    return {
        name: getCharacterCardField(raw, 'name'),
        avatar: typeof raw?.avatar === 'string' ? raw.avatar : '',
        description: shallow ? '' : getCharacterCardField(raw, 'description'),
        personality: shallow ? '' : getCharacterCardField(raw, 'personality'),
        scenario: shallow ? '' : getCharacterCardField(raw, 'scenario'),
        first_mes: shallow ? '' : getCharacterCardField(raw, 'first_mes'),
        mes_example: shallow ? '' : getCharacterCardField(raw, 'mes_example'),
        creator_notes: getCharacterCardField(raw, 'creator_notes'),
        date_added: raw?.date_added || 0,
        shallow,
    };
}

/**
 * Merges a full character card response onto a listed/shallow card without mutating either input.
 * Lifts V2 `data.*` text fields to top-level so downstream consumers can read `card.description`,
 * `card.personality`, etc. uniformly.
 * @param {any} baseCard
 * @param {any} fullCard
 * @returns {object}
 */
export function mergeHydratedCharacterCard(baseCard, fullCard) {
    const base = baseCard && typeof baseCard === 'object' ? baseCard : {};
    const full = fullCard && typeof fullCard === 'object' ? fullCard : {};
    const merged = {
        ...base,
        ...full,
        name: getCharacterCardField(full, 'name') || getCharacterCardField(base, 'name'),
        avatar: typeof base.avatar === 'string' && base.avatar.length > 0
            ? base.avatar
            : (typeof full.avatar === 'string' ? full.avatar : ''),
        shallow: false,
    };
    for (const field of CARD_TEXT_FIELDS) {
        const value = getCharacterCardField(full, field);
        merged[field] = value || getCharacterCardField(base, field);
    }
    return merged;
}

/**
 * Copies hydrated card fields onto an existing card object so list entries stay up to date.
 * @param {any} targetCard
 * @param {any} hydratedCard
 * @returns {any}
 */
export function applyHydratedCardFields(targetCard, hydratedCard) {
    if (!targetCard || typeof targetCard !== 'object' || !hydratedCard || typeof hydratedCard !== 'object') {
        return hydratedCard;
    }
    targetCard.name = hydratedCard.name || targetCard.name || '';
    for (const field of CARD_TEXT_FIELDS) {
        targetCard[field] = hydratedCard[field] ?? '';
    }
    if (hydratedCard.data && typeof hydratedCard.data === 'object') {
        targetCard.data = hydratedCard.data;
    }
    targetCard.shallow = false;
    return targetCard;
}

function buildJsonHeaders(getHeaders) {
    const raw = typeof getHeaders === 'function' ? (getHeaders() || {}) : (getHeaders || {});
    const headers = { ...raw };
    const hasContentType = Object.keys(headers).some(k => k.toLowerCase() === 'content-type');
    if (!hasContentType) headers['Content-Type'] = 'application/json';
    return headers;
}

/**
 * Creates a per-session hydrator that caches full cards by exact avatar filename,
 * deduplicates concurrent fetches for the same card, and bounds preview concurrency.
 * @param {{
 *   fetchImpl?: typeof fetch,
 *   getHeaders?: (() => Record<string, string>) | Record<string, string>,
 *   timeoutMs?: number,
 *   concurrency?: number,
 * }} [options]
 */
export function createCharacterCardHydrator(options = {}) {
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    const getHeaders = options.getHeaders ?? (() => globalThis.SillyTavern?.getContext?.()?.getRequestHeaders?.() || {});
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 10000;
    const concurrency = Math.max(1, Math.floor(Number(options.concurrency) || 4));

    /** @type {Map<string, object>} */
    const cache = new Map();
    /** @type {Map<string, Promise<object>>} */
    const inFlight = new Map();

    const fetchFullCard = (card) => {
        const avatar = card.avatar;
        const cached = cache.get(avatar);
        if (cached) return Promise.resolve(cached);

        const existing = inFlight.get(avatar);
        if (existing) return existing;

        const promise = (async () => {
            if (typeof fetchImpl !== 'function') {
                throw new Error('Fetch API is unavailable for character card hydration.');
            }
            const controller = typeof AbortController === 'function' && timeoutMs > 0
                ? new AbortController()
                : null;
            const timeoutId = controller
                ? setTimeout(() => controller.abort(), timeoutMs)
                : null;
            try {
                const res = await fetchImpl('/api/characters/get', {
                    method: 'POST',
                    headers: buildJsonHeaders(getHeaders),
                    // Pass avatar verbatim (exact filename, no trim/encode/path prefix).
                    body: JSON.stringify({ avatar_url: avatar }),
                    ...(controller ? { signal: controller.signal } : {}),
                });
                if (!res?.ok) {
                    throw new Error(`Failed to load character card "${card.name || avatar}" (HTTP ${res?.status ?? 'error'}).`);
                }
                const payload = await res.json();
                if (!payload || typeof payload !== 'object') {
                    throw new Error(`Invalid character card payload for "${card.name || avatar}".`);
                }
                const normalized = mergeHydratedCharacterCard(card, payload);
                cache.set(avatar, normalized);
                return normalized;
            } finally {
                if (timeoutId !== null) clearTimeout(timeoutId);
                inFlight.delete(avatar);
            }
        })();

        inFlight.set(avatar, promise);
        return promise;
    };

    /**
     * Returns the cached hydrated copy if available, otherwise the input card.
     * @param {any} card
     */
    const getCached = (card) => {
        if (!hasHydratableAvatar(card)) return card;
        const cached = cache.get(card.avatar);
        return cached ? mergeHydratedCharacterCard(card, cached) : card;
    };

    /**
     * Ensures `card` has full card fields, fetching `/api/characters/get` only if shallow.
     * @param {any} card
     * @param {{ strict?: boolean }} [opts]
     * @returns {Promise<any>}
     */
    const hydrate = async (card, { strict = false } = {}) => {
        if (!card || typeof card !== 'object') return card;
        if (!isShallowCharacterCard(card)) {
            return mergeHydratedCharacterCard(card, card);
        }
        if (!hasHydratableAvatar(card)) {
            return card;
        }
        try {
            const full = await fetchFullCard(card);
            return mergeHydratedCharacterCard(card, full);
        } catch (err) {
            if (strict) throw err;
            return card;
        }
    };

    /**
     * Lazily hydrates a slice of visible shallow cards with bounded concurrency.
     * Cancels remaining queued items and suppresses callbacks when `signal` aborts.
     * @param {any[]} cards
     * @param {{
     *   onHydrated?: (card: any, hydrated: any) => void,
     *   onError?: (card: any, error: unknown) => void,
     *   signal?: AbortSignal | null,
     * }} [opts]
     * @returns {Promise<void>}
     */
    const hydrateVisible = async (cards, { onHydrated, onError, signal } = {}) => {
        if (!Array.isArray(cards) || cards.length === 0 || signal?.aborted) return;

        const queue = [];
        for (const card of cards) {
            if (!isShallowCharacterCard(card) || !hasHydratableAvatar(card)) continue;
            const cached = cache.get(card.avatar);
            if (cached) {
                if (!signal?.aborted) {
                    onHydrated?.(card, mergeHydratedCharacterCard(card, cached));
                }
                continue;
            }
            queue.push(card);
        }

        if (queue.length === 0 || signal?.aborted) return;

        let cursor = 0;
        const workerCount = Math.min(concurrency, queue.length);
        const workers = Array.from({ length: workerCount }, async () => {
            while (cursor < queue.length && !signal?.aborted) {
                const card = queue[cursor++];
                try {
                    const hydrated = await hydrate(card, { strict: true });
                    if (!signal?.aborted) {
                        onHydrated?.(card, hydrated);
                    }
                } catch (err) {
                    if (!signal?.aborted) {
                        onError?.(card, err);
                    }
                }
            }
        });

        await Promise.all(workers);
    };

    /**
     * Hydrates a list of selected cards in order with bounded concurrency.
     * @param {any[]} cards
     * @param {{ strict?: boolean, signal?: AbortSignal | null }} [opts]
     * @returns {Promise<any[]>}
     */
    const hydrateMany = async (cards, { strict = false, signal } = {}) => {
        if (!Array.isArray(cards) || cards.length === 0) return [];
        const results = new Array(cards.length);
        let cursor = 0;
        const workerCount = Math.min(concurrency, cards.length);
        const workers = Array.from({ length: workerCount }, async () => {
            while (cursor < cards.length) {
                if (signal?.aborted) return;
                const index = cursor++;
                results[index] = await hydrate(cards[index], { strict });
            }
        });
        await Promise.all(workers);
        return results;
    };

    return {
        getCached,
        hydrate,
        hydrateVisible,
        hydrateMany,
    };
}

/**
 * Convenience helper to hydrate an array of character cards in one batch.
 * @param {any[]} cards
 * @param {{
 *   fetchImpl?: typeof fetch,
 *   getHeaders?: (() => Record<string, string>) | Record<string, string>,
 *   timeoutMs?: number,
 *   concurrency?: number,
 *   strict?: boolean,
 *   signal?: AbortSignal | null,
 * }} [options]
 * @returns {Promise<any[]>}
 */
export async function hydrateCharacterCards(cards, options = {}) {
    const hydrator = createCharacterCardHydrator(options);
    return hydrator.hydrateMany(cards, {
        strict: options.strict ?? false,
        signal: options.signal ?? null,
    });
}
