import { describe, it, expect } from 'vitest'
import {
  tokenize,
  deterministicPreFilter,
  assembleContext,
} from '../context-gate.js'
import type { RelevanceChunk, RelevanceResult } from '../qwen-router.js'

// -----------------------------------------------------------------------
// tokenize -- Hungarian + English, stop-word aware, diacritic safe
// -----------------------------------------------------------------------
describe('tokenize', () => {
  it('lowercases and splits on non-alphanumeric', () => {
    expect(tokenize('Hello, World! Foo-Bar')).toEqual(['hello', 'world', 'foo', 'bar'])
  })

  it('keeps Hungarian diacritics intact', () => {
    // á, é, í, ó, ö, ő, ú, ü, ű -- all kept, all lowercase.
    // Numeric tokens of length >= 2 also survive (they are not stop-words).
    expect(tokenize('Tüskésréti út 12.')).toEqual(['tüskésréti', 'út', '12'])
  })

  it('drops very short tokens (< 2 chars)', () => {
    expect(tokenize('a b cd ef gh')).toEqual(['cd', 'ef', 'gh'])
  })

  it('drops common Hungarian stop-words', () => {
    const out = tokenize('a kutya és a macska sétál az udvaron')
    // The "az" stays because it's only length 2 and stop-words include "az"
    // (we treat 2-char stop-words too); verify the content words survive.
    expect(out).toContain('kutya')
    expect(out).toContain('macska')
    expect(out).toContain('sétál')
    expect(out).toContain('udvaron')
    expect(out).not.toContain('a')
    expect(out).not.toContain('és')
    expect(out).not.toContain('az')
  })

  it('drops common English stop-words', () => {
    const out = tokenize('The quick brown fox jumps over the lazy dog')
    expect(out).toContain('quick')
    expect(out).toContain('brown')
    expect(out).toContain('fox')
    expect(out).toContain('jumps')
    expect(out).toContain('over') // not in stop-words; preserved
    expect(out).toContain('lazy')
    expect(out).toContain('dog')
    expect(out).not.toContain('the')
  })

  it('returns empty array on pure punctuation / stop-words', () => {
    expect(tokenize('!!! ??? ...')).toEqual([])
  })
})

// -----------------------------------------------------------------------
// deterministicPreFilter -- cheap keyword scoring, no model call
// -----------------------------------------------------------------------
const chunks: RelevanceChunk[] = [
  { id: 'src/qwen-router.ts:1', content: 'relevance filter pipeline for context gate' },
  { id: 'src/context-gate.ts:1', content: 'context gate query candidates topK' },
  { id: 'README.md:1', content: 'Marveen Agentic OS -- general intro to the system' },
  { id: 'src/db.ts:1525', content: 'recall search by query term and date range' },
  { id: 'src/web/agent-process.ts:1', content: 'main agent process loop' },
]

describe('deterministicPreFilter', () => {
  it('returns chunks sorted by keyword score descending', () => {
    const r = deterministicPreFilter('relevance filter query', chunks)
    // The two top-scoring chunks are the ones that mention BOTH "relevance" + "filter"
    // and "query" -- so either order between them is acceptable but both must be ahead
    // of the README and agent-process chunks.
    expect(r[0].id).not.toBe('README.md:1')
    expect(r[0].id).not.toBe('src/web/agent-process.ts:1')
    expect(r[0].score).toBeGreaterThan(r[r.length - 1].score)
  })

  it('is deterministic: same input -> same output', () => {
    const a = deterministicPreFilter('relevance filter', chunks)
    const b = deterministicPreFilter('relevance filter', chunks)
    expect(a).toEqual(b)
  })

  it('dropZero=true removes chunks with zero keyword overlap', () => {
    // A query that overlaps nothing in the chunks: pure noise
    const r = deterministicPreFilter('xyzzy plugh frobnicate', chunks, { dropZero: true })
    expect(r).toEqual([])
  })

  it('dropZero=false keeps zero-score chunks at the tail', () => {
    const r = deterministicPreFilter('relevance filter', chunks, { dropZero: false })
    expect(r.length).toBe(chunks.length)
    // The zero-score tail is at the bottom
    expect(r.every((x, i) => i === 0 || x.score <= r[i - 1].score)).toBe(true)
  })

  it('handles empty input', () => {
    expect(deterministicPreFilter('anything', [])).toEqual([])
  })

  it('handles all-stop-words query gracefully (returns zero scores, original order)', () => {
    const r = deterministicPreFilter('a az és', chunks)
    expect(r.length).toBe(chunks.length)
    expect(r.every(x => x.score === 0)).toBe(true)
  })
})

// -----------------------------------------------------------------------
// assembleContext -- join top-K contents into a single string
// -----------------------------------------------------------------------
describe('assembleContext', () => {
  const chunks: RelevanceChunk[] = [
    { id: 'a.ts:1', content: 'first chunk content' },
    { id: 'b.ts:1', content: 'second chunk content' },
    { id: 'c.ts:1', content: 'third chunk content' },
  ]

  it('returns null on empty results', () => {
    expect(assembleContext([], chunks)).toBe(null)
  })

  it('returns null when no result IDs match any chunk', () => {
    const r: RelevanceResult[] = [{ id: 'unknown.ts:99', score: 0.9 }]
    expect(assembleContext(r, chunks)).toBe(null)
  })

  it('joins top-K contents in result order with default separator', () => {
    const r: RelevanceResult[] = [
      { id: 'b.ts:1', score: 0.9 },
      { id: 'a.ts:1', score: 0.7 },
    ]
    const out = assembleContext(r, chunks)
    expect(out).not.toBe(null)
    // Header lines first, then content
    expect(out).toContain('chunk: b.ts:1')
    expect(out).toContain('chunk: a.ts:1')
    expect(out).toContain('second chunk content')
    expect(out).toContain('first chunk content')
    // b comes before a (result order is preserved)
    const idxB = out!.indexOf('second chunk content')
    const idxA = out!.indexOf('first chunk content')
    expect(idxB).toBeLessThan(idxA)
  })

  it('skips results whose ID does not match any candidate chunk', () => {
    const r: RelevanceResult[] = [
      { id: 'unknown.ts:1', score: 0.9 },
      { id: 'a.ts:1', score: 0.7 },
    ]
    const out = assembleContext(r, chunks)
    expect(out).not.toBe(null)
    expect(out).toContain('first chunk content')
    expect(out).not.toContain('unknown.ts:1')
  })

  it('includeHeader=false omits the chunk id annotation', () => {
    const r: RelevanceResult[] = [{ id: 'a.ts:1', score: 0.5 }]
    const out = assembleContext(r, chunks, { includeHeader: false })
    expect(out).toBe('first chunk content')
  })

  it('custom separator is honored', () => {
    const r: RelevanceResult[] = [
      { id: 'a.ts:1', score: 0.5 },
      { id: 'b.ts:1', score: 0.3 },
    ]
    const out = assembleContext(r, chunks, { separator: ' || ', includeHeader: false })
    expect(out).toBe('first chunk content || second chunk content')
  })
})
