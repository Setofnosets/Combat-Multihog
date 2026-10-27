/**
 * skill-lorebook.js — readable backup/mirror of the campaign Skill Registry.
 *
 * The JSON registry is authoritative. This module writes a dedicated
 * `<prefix>_Skills` lorebook so the ledger survives manual exports, can be read
 * in SillyTavern, and can be re-imported if chat state is lost. Book writes are
 * debounced and guarded against chat switches.
 */

import { getActiveChatId, getEffectiveRouterCampaignPrefix, saveChatState } from '../../../state-manager.js';
import { createChatCommitGuard, chatCommitResult } from '../../state/pass-affinity.js';
import {
    ensureSkillRegistry,
    normalizeSkillClass,
    normalizeSkillKey,
    normalizeSkillRegistryEntry,
    rememberSkillForm,
    slugifySkill,
} from './skill-registry.js';

const MIRROR_DELAY_MS = 1500;
let mirrorTimer = null;
let mirrorChatId = '';

function getContext() {
    return typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null;
}

function requestHeaders(ctx) {
    try {
        if (typeof ctx?.getRequestHeaders === 'function') return ctx.getRequestHeaders();
        if (typeof globalThis?.getRequestHeaders === 'function') return globalThis.getRequestHeaders();
    } catch (_) { /* fall through */ }
    return {};
}

function normalizePrefix(value) {
    return String(value || '').trim().replace(/[^\w-]+/g, '_').replace(/^_+|_+$/g, '');
}

/** @param {Record<string, any>} settings */
export function getSkillLorebookName(settings = {}, chatId = getActiveChatId()) {
    const prefix = normalizePrefix(
        (chatId ? getEffectiveRouterCampaignPrefix(chatId) : '')
        || settings.routerCampaignPrefix
        || '',
    );
    return prefix ? `${prefix}_Skills` : 'Skills';
}

function bookDataFor(bookName) {
    return {
        entries: {},
        name: bookName,
        scan_depth: 4,
        token_budget: 400,
        recursive: false,
        extensions: {},
    };
}

async function loadBook(ctx, bookName, canCommit) {
    let book = null;
    if (typeof ctx?.loadWorldInfo === 'function') {
        try { book = chatCommitResult(canCommit, await ctx.loadWorldInfo(bookName)); } catch (_) { book = null; }
    }
    if (book?.entries) return book;
    try {
        const response = await fetch('/api/worldinfo/get', {
            method: 'POST',
            headers: requestHeaders(ctx),
            body: JSON.stringify({ name: bookName }),
        });
        if (response.ok) {
            const data = await response.json();
            if (data && typeof data === 'object' && data.entries) return data;
        }
    } catch (_) { /* non-fatal */ }
    return bookDataFor(bookName);
}

async function saveBook(ctx, bookName, book, canCommit) {
    const headers = requestHeaders(ctx);
    if (headers && Object.keys(headers).length) {
        try {
            const response = await fetch('/api/worldinfo/edit', {
                method: 'POST',
                headers,
                body: JSON.stringify({ name: bookName, data: book }),
            });
            if (response.ok) return true;
        } catch (_) { /* fall through */ }
    }
    if (typeof ctx?.saveWorldInfo === 'function') {
        try {
            await ctx.saveWorldInfo(bookName, book);
            return true;
        } catch (error) {
            if (canCommit()) console.warn('[RPG Tracker] Skill mirror save failed:', error);
        }
    }
    return false;
}

function registerCampaignBook(settings, bookName, chatId = getActiveChatId()) {
    const partition = chatId ? settings?.chatStates?.[chatId] : null;
    if (!partition) return false;
    const books = new Set(Array.isArray(partition.campaignBooks) ? partition.campaignBooks : []);
    if (books.has(bookName)) return false;
    books.add(bookName);
    partition.campaignBooks = [...books];
    return true;
}

/** Register the mirror book in the chat partition before a normal save. */
export function ensureSkillBookRegistered(settings, chatId = getActiveChatId()) {
    if (!settings || !chatId || settings.skillRegistryLorebookMirror === false) return false;
    return registerCampaignBook(settings, getSkillLorebookName(settings, chatId), chatId);
}

function skillContent(entry, forms = {}) {
    const lines = ['[CORE]'];
    lines.push(`Type: ${entry.type || 'ability'}`);
    if (entry.brief) lines.push(`Brief: ${entry.brief}`);
    if (entry.effectSummary) lines.push(`Effect: ${entry.effectSummary}`);
    if (entry.owners?.length) lines.push(`Owners: ${entry.owners.map(owner => owner.name).join(', ')}`);
    for (const form of Object.values(forms || {})) {
        const skills = Array.isArray(form.skills) && form.skills.length
            ? form.skills.map(skill => skill.name).filter(Boolean).join(', ')
            : (form.replaceSkills === true ? 'helpless/no skills' : 'keeps original skills');
        lines.push(`Form: ${form.name}${form.maxHp ? ` · ${form.maxHp} HP` : ''}${form.ac ? ` · AC ${form.ac}` : ''} · ${skills}`);
    }
    lines.push('[/CORE]');
    return lines.join('\n');
}

function classContent(cls) {
    const lines = ['[CORE]', 'Type: class'];
    if (cls.brief) lines.push(`Brief: ${cls.brief}`);
    if (cls.skillIds?.length) lines.push(`Skills: ${cls.skillIds.join(', ')}`);
    lines.push('[/CORE]');
    return lines.join('\n');
}

function findEntryByComment(book, comment) {
    const target = String(comment || '').trim().toLowerCase();
    if (!target) return null;
    for (const [uid, existing] of Object.entries(book.entries || {})) {
        if (existing?.extensions?.multihogSkill) continue;
        if (String(existing?.comment || '').trim().toLowerCase() === target) return { uid, existing };
    }
    return null;
}

function referencedForms(entry, registry) {
    const forms = {};
    const template = entry?.mechanics?.effectTemplate || [];
    for (const effect of template) {
        if (!effect?.formId) continue;
        const form = registry.forms?.[effect.formId];
        if (form) forms[effect.formId] = form;
    }
    return forms;
}

function findEntryByLabel(book, entry) {
    const target = String(entry.name || '').trim().toLowerCase();
    if (!target) return null;
    for (const [uid, existing] of Object.entries(book.entries || {})) {
        if (existing?.extensions?.multihogClass) continue;
        const label = String(existing?.comment || '').trim().toLowerCase();
        const keys = Array.isArray(existing?.key) ? existing.key.map(key => String(key).trim().toLowerCase()) : [];
        if (label === target || keys.includes(target)) return { uid, existing };
    }
    return null;
}

function stripSkillBookKeys(settings, bookName) {
    const lower = String(bookName || '').toLowerCase();
    let changed = false;
    for (const key of ['activeRouterKeys', 'keywordActivatedKeys', 'pinnedRouterKeys']) {
        const list = Array.isArray(settings[key]) ? settings[key] : [];
        const next = list.filter(id => String(id || '').split('::')[0].toLowerCase() !== lower);
        if (next.length !== list.length) {
            settings[key] = next;
            changed = true;
        }
    }
    return changed;
}

/**
 * Write the current registry into the mirror lorebook.
 * @param {Record<string, any>} settings
 * @param {{ chatId?: string, force?: boolean }} [options]
 * @returns {Promise<number>}
 */
export async function mirrorSkillRegistryToLorebook(settings, options = {}) {
    if (settings?.skillRegistryLorebookMirror === false) return 0;
    const chatId = String(options.chatId || getActiveChatId() || '');
    if (!chatId) return 0;
    const ownsChat = createChatCommitGuard(chatId, getActiveChatId);
    const ctx = getContext();
    if (!ctx) return 0;
    const registry = ensureSkillRegistry(settings);
    const bookName = getSkillLorebookName(settings, chatId);
    const keysChanged = settings.skillRegistryLorebookKeywords !== true
        && stripSkillBookKeys(settings, bookName);
    const book = await loadBook(ctx, bookName, ownsChat);
    if (!ownsChat()) return 0;
    const disable = settings.skillRegistryLorebookKeywords !== true;
    let changed = 0;
    for (const entry of Object.values(registry.skills || {})) {
        if (!entry?.name) continue;
        const found = findEntryByLabel(book, entry);
        const forms = referencedForms(entry, registry);
        const payload = {
            ...JSON.parse(JSON.stringify(entry)),
            ...(Object.keys(forms).length ? { forms } : {}),
        };
        const keys = [entry.name, ...(entry.aliases || [])]
            .map(value => String(value || '').trim())
            .filter(Boolean)
            .slice(0, 16);
        const content = skillContent(entry, forms);
        if (found) {
            const existing = found.existing;
            if (existing.content !== content
                || JSON.stringify(existing.extensions?.multihogSkill || null) !== JSON.stringify(payload)
                || existing.disable !== disable) {
                existing.content = content;
                existing.key = keys;
                existing.comment = entry.name;
                existing.disable = disable;
                existing.extensions = {
                    ...(existing.extensions || {}),
                    multihogManaged: true,
                    multihogRegistryVersion: 1,
                    multihogSkill: payload,
                };
                changed += 1;
            }
            continue;
        }
        const uids = Object.keys(book.entries || {}).map(Number).filter(Number.isFinite);
        const nextUid = uids.length ? Math.max(...uids) + 1 : 0;
        book.entries[nextUid] = {
            uid: nextUid,
            key: keys,
            keysecondary: [],
            comment: entry.name,
            content,
            constant: false,
            selective: false,
            selectiveLogic: 0,
            addMemo: true,
            order: settings.routerDefaultOrder ?? 100,
            position: settings.routerDefaultPosition ?? 0,
            disable,
            probability: 100,
            useProbability: false,
            depth: settings.routerDefaultDepth ?? 4,
            role: (settings.routerDefaultPosition === 4) ? (settings.routerDefaultRole ?? 0) : null,
            group: '',
            groupOverride: false,
            groupWeight: 100,
            extensions: {
                multihogManaged: true,
                multihogRegistryVersion: 1,
                multihogSkill: payload,
            },
        };
        changed += 1;
    }
    for (const cls of Object.values(registry.classes || {})) {
        if (!cls?.name) continue;
        const comment = `Class: ${cls.name}`;
        const found = findEntryByComment(book, comment);
        const content = classContent(cls);
        const payload = JSON.parse(JSON.stringify(cls));
        if (found) {
            const existing = found.existing;
            if (existing.content !== content
                || JSON.stringify(existing.extensions?.multihogClass || null) !== JSON.stringify(payload)) {
                existing.content = content;
                existing.key = [cls.name, comment];
                existing.comment = comment;
                existing.disable = disable;
                existing.extensions = {
                    ...(existing.extensions || {}),
                    multihogManaged: true,
                    multihogRegistryVersion: 1,
                    multihogClass: payload,
                };
                changed += 1;
            }
            continue;
        }
        const uids = Object.keys(book.entries || {}).map(Number).filter(Number.isFinite);
        const nextUid = uids.length ? Math.max(...uids) + 1 : 0;
        book.entries[nextUid] = {
            uid: nextUid,
            key: [cls.name, comment],
            keysecondary: [],
            comment,
            content,
            constant: false,
            selective: false,
            selectiveLogic: 0,
            addMemo: true,
            order: settings.routerDefaultOrder ?? 100,
            position: settings.routerDefaultPosition ?? 0,
            disable,
            probability: 100,
            useProbability: false,
            depth: settings.routerDefaultDepth ?? 4,
            role: (settings.routerDefaultPosition === 4) ? (settings.routerDefaultRole ?? 0) : null,
            group: '',
            groupOverride: false,
            groupWeight: 100,
            extensions: {
                multihogManaged: true,
                multihogRegistryVersion: 1,
                multihogClass: payload,
            },
        };
        changed += 1;
    }
    // Remove managed mirror entries whose skills no longer exist in the registry.
    // Without this, "Clear campaign registry" would be undone by hydration.
    if (options.prune !== false) {
        const currentNames = new Set(
            Object.values(registry.skills || {})
                .map(entry => normalizeSkillKey(entry.name))
                .filter(Boolean),
        );
        const currentClasses = new Set(
            Object.values(registry.classes || {})
                .map(cls => normalizeSkillKey(cls.name))
                .filter(Boolean),
        );
        for (const [uid, existing] of Object.entries(book.entries || {})) {
            if (existing?.extensions?.multihogManaged !== true) continue;
            if (existing.extensions.multihogClass) {
                const className = normalizeSkillKey(existing.extensions.multihogClass.name || '');
                if (className && currentClasses.has(className)) continue;
            } else if (existing.extensions.multihogSkill) {
                const label = normalizeSkillKey(existing.comment || existing.key?.[0] || '');
                if (label && currentNames.has(label)) continue;
            } else {
                continue;
            }
            delete book.entries[uid];
            changed += 1;
        }
    }
    if (!changed && !options.force) {
        if (registerCampaignBook(settings, bookName, chatId) || keysChanged) {
            try { saveChatState(chatId, { skipDiskWrite: true }); } catch (_) { /* non-fatal */ }
        }
        return 0;
    }
    const saved = await saveBook(ctx, bookName, book, ownsChat);
    if (!ownsChat()) return 0;
    if (saved) {
        const registered = registerCampaignBook(settings, bookName, chatId);
        if (registered || keysChanged) {
            try { saveChatState(chatId, { skipDiskWrite: true }); } catch (_) { /* non-fatal */ }
        }
        try {
            if (typeof ctx.updateWorldInfoList === 'function') await ctx.updateWorldInfoList();
        } catch (_) { /* non-fatal */ }
    }
    return changed;
}

/**
 * Merge entries from the mirror book back into the live registry.
 * @param {Record<string, any>} settings
 * @param {{ chatId?: string }} [options]
 * @returns {Promise<number>}
 */
export async function hydrateSkillRegistryFromLorebook(settings, options = {}) {
    const chatId = String(options.chatId || getActiveChatId() || '');
    if (!chatId) return 0;
    const ownsChat = createChatCommitGuard(chatId, getActiveChatId);
    const ctx = getContext();
    if (!ctx) return 0;
    const bookName = getSkillLorebookName(settings, chatId);
    const book = await loadBook(ctx, bookName, ownsChat);
    if (!ownsChat()) return 0;
    const registry = ensureSkillRegistry(settings);
    let changed = 0;
    for (const entry of Object.values(book.entries || {})) {
        const payload = entry?.extensions?.multihogSkill;
        if (!payload || typeof payload !== 'object') continue;
        const { forms, ...skill } = payload;
        const normalized = normalizeSkillRegistryEntry(skill);
        if (!normalized) continue;
        const key = normalizeSkillKey(normalized.name);
        if (!registry.skills[key]) {
            registry.skills[key] = normalized;
            changed += 1;
        }
        for (const form of Object.values(forms || {})) {
            if (rememberSkillForm(settings, form)) changed += 1;
        }
    }
    for (const entry of Object.values(book.entries || {})) {
        const payload = entry?.extensions?.multihogClass;
        if (!payload || typeof payload !== 'object') continue;
        const normalized = normalizeSkillClass(payload);
        if (!normalized) continue;
        const key = slugifySkill(normalized.id || normalized.name, 'class');
        if (!registry.classes[key]) {
            registry.classes[key] = normalized;
            changed += 1;
        }
    }
    if (changed) {
        registry.updatedAt = Date.now();
        registerCampaignBook(settings, bookName, chatId);
        try { saveChatState(chatId, { skipDiskWrite: true }); } catch (_) { /* non-fatal */ }
    }
    return changed;
}

/**
 * Debounced background mirror. Safe to call after every registry mutation.
 * @param {Record<string, any>} settings
 * @param {string|null} [chatId]
 */
export function scheduleSkillLorebookMirror(settings, chatId = getActiveChatId()) {
    if (!settings || settings.skillRegistryLorebookMirror === false) return;
    const id = String(chatId || '');
    if (!id) return;
    mirrorChatId = id;
    if (mirrorTimer) clearTimeout(mirrorTimer);
    mirrorTimer = setTimeout(() => {
        mirrorTimer = null;
        const target = mirrorChatId;
        mirrorChatId = '';
        if (!target || getActiveChatId() !== target) return;
        void mirrorSkillRegistryToLorebook(settings, { chatId: target }).catch(error => {
            if (settings.debugMode) console.warn('[RPG Tracker] Skill mirror failed:', error);
        });
    }, MIRROR_DELAY_MS);
}

export function cancelScheduledSkillMirror() {
    if (mirrorTimer) clearTimeout(mirrorTimer);
    mirrorTimer = null;
    mirrorChatId = '';
}
