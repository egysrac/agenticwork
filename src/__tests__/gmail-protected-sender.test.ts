import { describe, it, expect } from 'vitest'
import { isProtectedSender } from '../gmail-api.js'
import { decodeMimeHeader } from '../gmail-api.js'

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

  it('FULL-ADDRESS protection survives the "Name <addr>" envelope (GMAILENV826 regression)', () => {
    // Ez a teszt kifejezetten a GMAILENV826 bugot fogja: a vedett lista
    // `alice@gmail.com`, a bejovo level feladoja pedig `Alice <alice@gmail.com>`
    // (ahogy a `decodeMimeHeader(env?.from)` adja vissza az IMAP envelope-bol).
    // A regi implementacio csak `lower === p`-t hasonlitott, ami soha nem
    // egyezett volna -- vedett felado levele torolheto lett volna.
    //
    // A domain-match ugyan mukodott envelope-re is (mert `includes('@'+p)`),
    // de a full-address match NEM. Ez a reteg az, ahol a sima substring match
    // mar nem segit, es kifejezetten a csupasz cimet kell kinyerni.
    expect(isProtectedSender('Alice <alice@gmail.com>', ['alice@gmail.com'])).toBe(true)
    expect(isProtectedSender('ALICE <ALICE@GMAIL.COM>', ['alice@gmail.com'])).toBe(true)
    expect(isProtectedSender('Alice Foo Bar <alice@gmail.com>', ['alice@gmail.com'])).toBe(true)
    // Negativ kontroll: a vedeni nem akart cim ne legyen vedett meg akkor
    // sem, ha valaki "alice@gmail.com"-et tartalmazo display-name-et kuld.
    expect(isProtectedSender('Alice Hacker <mallory@gmail.com>', ['alice@gmail.com'])).toBe(false)
  })
})

// INTEGRACIOS TESZT (2026-08-26): a teljes fetchEnvelopeFrom -> isProtectedSender
// lancot zart lancban teszteli, hogy ha egy IMAP envelope objektum jon be (a
// valodi hivo oldal pont igy adja at), a vedelem tenyleg mukodik. A GMAILENV826
// bug azert maradt rejtve, mert a regi tesztek csak a `isProtectedSender`-t
// hivtak stringgel, NEM a decodeMimeHeader-en keresztulmeno envelope objektummal.
describe('gmail protected-sender integration (IMAP envelope -> isProtectedSender)', () => {
  it('IMAP address object survives the full decode + match pipeline', () => {
    // Az IMAP envelope.from igy erkezik: egy objektum vagy objektum-tomb.
    // A decodeMimeHeader ezt atalakitja "Nev <cim@domain>" formara, es ez
    // kerul be a védelmiellenőrzésbe.
    const imapFrom = [{ name: 'Alice Kovács', address: 'alice@gmail.com' }]
    const decoded = decodeMimeHeader(imapFrom)
    expect(decoded).toBe('Alice Kovács <alice@gmail.com>')

    // A lenyeg: a védett lista csak egy cim -- a teljes pipeline megis ved.
    expect(isProtectedSender(decoded, ['alice@gmail.com'])).toBe(true)
  })

  it('RFC 2047 encoded display name still extracts the bare address', () => {
    // Egyes szerverek RFC 2047 enkolt display-name-et kuldenek, pl.
    // =?UTF-8?Q?Alice_Kov=C3=A1cs?= <alice@gmail.com>
    const imapFrom = '=?UTF-8?Q?Alice_Kov=C3=A1cs?= <alice@gmail.com>'
    const decoded = decodeMimeHeader(imapFrom)
    // A dekódolás után a cimet a <> kozott kell talalni
    expect(decoded).toContain('<alice@gmail.com>')
    expect(isProtectedSender(decoded, ['alice@gmail.com'])).toBe(true)
  })

  it('domain-style protection works even without angle brackets', () => {
    // Ha a szerver csak a csupasz cimet adja (nincs display name, nincs <>)
    const imapFrom = { name: '', address: 'hairboti@salonic.hu' }
    const decoded = decodeMimeHeader(imapFrom)
    expect(decoded).toBe('hairboti@salonic.hu')
    expect(isProtectedSender(decoded, ['salonic.hu'])).toBe(true)
  })
})