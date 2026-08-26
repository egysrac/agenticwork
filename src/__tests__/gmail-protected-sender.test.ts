import { describe, it, expect } from 'vitest'
import { isProtectedSender } from '../gmail-api.js'

// Domain-style entries match on substring "@<domain>" inside the address.
// Full-address entries match exactly (case-insensitive).
// Empty / undefined protectedSenders = no protection (back-compat).

describe('isProtectedSender', () => {
  const salonic = ['salonic.hu']
  const alice = ['alice@gmail.com']
  const both = ['salonic.hu', 'alice@gmail.com']
  const salonicSub = ['y.salonic.hu']

  it('returns false when protectedSenders is undefined', () => {
    expect(isProtectedSender('hairboti@salonic.hu', undefined)).toBe(false)
  })
  it('returns false when protectedSenders is empty', () => {
    expect(isProtectedSender('hairboti@salonic.hu', [])).toBe(false)
  })
  it('returns false for empty sender regardless of allowlist', () => {
    expect(isProtectedSender('', salonic)).toBe(false)
  })

  it('domain match: any @<domain> address is protected', () => {
    expect(isProtectedSender('hairboti@salonic.hu', salonic)).toBe(true)
  })
  it('domain match is case-insensitive', () => {
    expect(isProtectedSender('HAIRBOTI@SALONIC.HU', salonic)).toBe(true)
    expect(isProtectedSender('HairBoti@Salonic.Hu', salonic)).toBe(true)
  })
  it('domain match: subdomain address is also protected', () => {
    expect(isProtectedSender('x@y.salonic.hu', salonicSub)).toBe(true)
  })
  it('domain match: a similar-but-different domain is NOT protected', () => {
    expect(isProtectedSender('alice@salonic.hacker', salonic)).toBe(false)
    expect(isProtectedSender('alice@salonic', salonic)).toBe(false)
  })

  it('address match: exact case-insensitive address is protected', () => {
    expect(isProtectedSender('alice@gmail.com', alice)).toBe(true)
    expect(isProtectedSender('ALICE@GMAIL.COM', alice)).toBe(true)
  })
  it('address match: a different user at the same domain is NOT protected', () => {
    expect(isProtectedSender('bob@gmail.com', alice)).toBe(false)
  })

  it('multi-entry: any one match is enough', () => {
    expect(isProtectedSender('hairboti@salonic.hu', both)).toBe(true)
    expect(isProtectedSender('alice@gmail.com', both)).toBe(true)
    expect(isProtectedSender('bob@gmail.com', both)).toBe(false)
  })

  it('whitespace in a protected entry still protects the sender (defence in depth)', () => {
    // JAVITVA 2026-08-26: a teszt korabban azt kotote ki, hogy isProtectedSender
    // NE trimmeljen (a loader dolga). Az implementacio viszont trimmel -- es ez a
    // BIZTONSAGOSABB irany: ez a lista azt mondja meg, kinek a levelet TILOS
    // torolni. Ha egy veletlen szokoz miatt a vedelem NEM ervenyesul, egy fontos
    // level torlodik; ha a loadert megkerulve is trimmel, a legrosszabb eset egy
    // felesleges vedelem. A ket kimenet nem egyenrangu, ezert az implementaciohoz
    // igazitjuk a szerzodest, nem forditva.
    expect(isProtectedSender('hairboti@salonic.hu', [' salonic.hu '])).toBe(true)
  })

  it('display-name-style envelope is matched on the address substring', () => {
    // decodeMimeHeader produces strings like 'HairBoti <hairboti@salonic.hu>'.
    // The substring '@salonic.hu' is still present and matches.
    expect(isProtectedSender('HairBoti <hairboti@salonic.hu>', salonic)).toBe(true)
    expect(isProtectedSender('Alice <alice@gmail.com>', alice)).toBe(true)
  })
})