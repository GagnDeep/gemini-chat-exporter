// IndexedDB persistence via Dexie. Holds the imported chats, the flattened
// searchable segments (one per Q&A turn, with an optional embedding vector),
// and detected entities/concepts.

import Dexie, { type EntityTable } from "dexie";
import type { Chat, ChatTurn, Segment } from "./types";
import {
  extractHeuristicEntities,
  conceptCandidates,
  conceptEntity,
  type Entity,
} from "./entities";
import { cosineSim, getEmbeddings } from "./embeddings";
import { sanitizeAnswerHtml } from "./sanitize";

const db = new Dexie("GeminiChatArchive") as Dexie & {
  chats: EntityTable<Chat, "id">;
  segments: EntityTable<Segment, "id">;
  entities: EntityTable<Entity, "id">;
};

db.version(1).stores({
  chats: "id, title, scrapedAt",
  // index chatId so we can wipe/replace a chat's segments efficiently
  segments: "id, chatId, chatTitle, turnIndex",
});

// v2 (additive): detected entities/concepts. Existing v1 data is untouched.
db.version(2).stores({
  entities: "id, type, value, chatId, turnIndex",
});

export { db };

function segmentsFor(chat: Chat): Segment[] {
  return chat.turns.map((t) => ({
    id: `${chat.id}#${t.index}`,
    chatId: chat.id,
    chatTitle: chat.title,
    turnIndex: t.index,
    question: t.question,
    answerText: t.answerText,
    text: `${t.question}\n\n${t.answerText}`.trim(),
    embedding: null,
  }));
}

function turnMatchKey(t: ChatTurn): string {
  return t.key ? `k:${t.key}` : `i:${t.index}`;
}

/**
 * Fold an incoming (possibly fuller) scrape of a chat into the existing copy.
 * Matches turns by stable `key`, falling back to `index` for chats imported
 * before keys existed. Prefers the incoming turn only when it carries more
 * content, so a partial re-scrape never clobbers a fuller stored turn.
 */
function mergeTurns(existing: ChatTurn[], incoming: ChatTurn[]): ChatTurn[] {
  const byKey = new Map<string, ChatTurn>();
  const byIndex = new Map<number, ChatTurn>();
  for (const t of existing) {
    if (t.key) byKey.set(t.key, t);
    byIndex.set(t.index, t);
  }

  const result: ChatTurn[] = [];
  const usedIndexes = new Set<number>();

  for (const t of incoming) {
    let prev: ChatTurn | undefined;
    if (t.key && byKey.has(t.key)) {
      prev = byKey.get(t.key);
      if (prev) usedIndexes.add(prev.index);
    } else if (byIndex.has(t.index) && !usedIndexes.has(t.index)) {
      prev = byIndex.get(t.index);
      usedIndexes.add(t.index);
    }

    if (prev) {
      const richer = (t.answerText?.length || 0) >= (prev.answerText?.length || 0);
      result.push({
        index: t.index,
        key: t.key ?? prev.key,
        question: t.question || prev.question,
        answerText: richer ? t.answerText : prev.answerText,
        answerHtml: richer ? t.answerHtml : prev.answerHtml,
      });
    } else {
      result.push({ ...t });
    }
  }

  // Keep existing turns the incoming scrape didn't cover (e.g. a partial scrape
  // that missed turns currently in the archive).
  for (const t of existing) {
    if (!usedIndexes.has(t.index)) result.push({ ...t });
  }

  return result.sort((a, b) => a.index - b.index).map((t, i) => ({ ...t, index: i }));
}

/** Full delete + rebuild of a chat's rows (the original v1 behavior). */
async function rebuildChat(chat: Chat): Promise<void> {
  await db.segments.where("chatId").equals(chat.id).delete();
  await db.entities.where("chatId").equals(chat.id).delete();
  await db.chats.put(chat);
  await db.segments.bulkPut(segmentsFor(chat));
  await db.entities.bulkPut(extractHeuristicEntities(chat));
}

/**
 * Merge an incoming chat into the stored one, preserving embeddings on turns
 * whose text is unchanged so only new/changed turns need re-embedding.
 */
async function mergeChat(existing: Chat, incoming: Chat): Promise<void> {
  const mergedChat: Chat = {
    id: existing.id,
    title: incoming.title || existing.title,
    url: incoming.url || existing.url,
    scrapedAt: incoming.scrapedAt || existing.scrapedAt,
    turns: mergeTurns(existing.turns, incoming.turns),
  };
  await db.chats.put(mergedChat);

  // Preserve embeddings by matching on segment text (robust to index shifts).
  const prevSegs = await db.segments.where("chatId").equals(existing.id).toArray();
  const embByText = new Map<string, number[]>();
  for (const s of prevSegs) {
    if (s.embedding && s.embedding.length && !embByText.has(s.text)) {
      embByText.set(s.text, s.embedding);
    }
  }

  const nextSegs = segmentsFor(mergedChat).map((s) => {
    const kept = embByText.get(s.text);
    return kept ? { ...s, embedding: kept } : s;
  });

  await db.segments.where("chatId").equals(existing.id).delete();
  await db.segments.bulkPut(nextSegs);

  // Refresh heuristic entities; drop stale concepts so buildEntityIndex can
  // re-rank them against the (possibly grown) conversation.
  await db.entities.where("chatId").equals(existing.id).delete();
  await db.entities.bulkPut(extractHeuristicEntities(mergedChat));
}

/**
 * Insert chats and (re)build their segments + heuristic entities.
 * `mode: "merge"` (default) folds a re-scrape in while preserving embeddings;
 * `mode: "replace"` rebuilds the chat from scratch.
 * Returns the number of chats processed.
 */
export async function importChats(
  chats: Chat[],
  opts: { mode?: "merge" | "replace" } = {},
): Promise<number> {
  const mode = opts.mode ?? "merge";
  let count = 0;
  // Re-sanitize answer HTML on the way in — imported files are untrusted and we
  // render them with dangerouslySetInnerHTML downstream.
  const safe = chats.map((chat) =>
    chat && Array.isArray(chat.turns)
      ? { ...chat, turns: chat.turns.map((t) => ({ ...t, answerHtml: sanitizeAnswerHtml(t.answerHtml) })) }
      : chat,
  );
  await db.transaction("rw", db.chats, db.segments, db.entities, async () => {
    for (const chat of safe) {
      if (!chat?.id || !Array.isArray(chat.turns)) continue;
      const existing = await db.chats.get(chat.id);
      if (!existing || mode === "replace") {
        await rebuildChat(chat);
      } else {
        await mergeChat(existing, chat);
      }
      count++;
    }
  });
  return count;
}

export async function deleteChat(chatId: string): Promise<void> {
  await db.transaction("rw", db.chats, db.segments, db.entities, async () => {
    await db.segments.where("chatId").equals(chatId).delete();
    await db.entities.where("chatId").equals(chatId).delete();
    await db.chats.delete(chatId);
  });
}

/** Drop all ranked concept entities so they can be rebuilt from scratch. */
export async function clearConcepts(): Promise<number> {
  const n = await db.entities.where("type").equals("concept").count();
  await db.entities.where("type").equals("concept").delete();
  return n;
}

export async function clearAll(): Promise<void> {
  await db.transaction("rw", db.chats, db.segments, db.entities, async () => {
    await db.segments.clear();
    await db.entities.clear();
    await db.chats.clear();
  });
}

/** Persist computed embeddings back onto their segments. */
export async function saveEmbeddings(items: { id: string; embedding: number[] }[]): Promise<void> {
  await db.transaction("rw", db.segments, async () => {
    for (const { id, embedding } of items) {
      await db.segments.update(id, { embedding });
    }
  });
}

export async function unembeddedSegments(): Promise<Segment[]> {
  const all = await db.segments.toArray();
  return all.filter((s) => !s.embedding || s.embedding.length === 0);
}

/**
 * Rank concept phrases for every embedded segment that doesn't yet have
 * concept entities. Embeds candidate phrases in the existing worker and keeps
 * those most similar to the segment embedding (KeyBERT-style). Idempotent:
 * segments already carrying concepts are skipped.
 */
export async function buildEntityIndex(
  onProgress?: (done: number, total: number) => void,
): Promise<{ processed: number }> {
  const segs = await db.segments.toArray();
  const embedded = segs.filter((s) => s.embedding && s.embedding.length);

  const haveConcepts = new Set(
    (await db.entities.where("type").equals("concept").toArray()).map(
      (e) => `${e.chatId}#${e.turnIndex}`,
    ),
  );
  const todo = embedded.filter((s) => !haveConcepts.has(`${s.chatId}#${s.turnIndex}`));

  const emb = getEmbeddings();
  // Candidate phrases repeat heavily across turns of the same chat; cache their
  // vectors for the duration of this run so each phrase is embedded only once.
  const phraseCache = new Map<string, number[]>();
  let processed = 0;
  for (const seg of todo) {
    const candidates = conceptCandidates(seg.text);
    if (candidates.length) {
      try {
        const missing = candidates.filter((c) => !phraseCache.has(c));
        if (missing.length) {
          const vectors = await emb.embedBatch(missing.map((c, i) => ({ id: String(i), text: c })));
          vectors.forEach((v, i) => phraseCache.set(missing[i]!, v.embedding));
        }
        const scored = candidates.map((phrase) => ({
          phrase,
          score: cosineSim(phraseCache.get(phrase) ?? [], seg.embedding as number[]),
        }));
        const top = scored
          .sort((a, b) => b.score - a.score)
          .filter((s) => s.score > 0.25)
          .slice(0, 5);
        if (top.length) {
          await db.entities.bulkPut(
            top.map((t) => conceptEntity(seg.chatId, seg.turnIndex, t.phrase)),
          );
        }
      } catch {
        break; // worker/model unavailable — stop gracefully
      }
    }
    processed++;
    onProgress?.(processed, todo.length);
  }
  return { processed };
}
