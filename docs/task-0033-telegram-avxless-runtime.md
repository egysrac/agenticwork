# TASK-0033 — Telegram Channels AVX-less Node runtime

## Probléma

Az official Telegram Channels plugin `.mcp.json` fájlja Bun futtatót kér. Az AVX/SSE4 nélküli x86_64 hoston a normál és baseline Bun bináris `SIGILL` hibával leáll, miközben a Node-alapú Claude Code működik. A plugin ezért `MCP failed` / `--channels ignored` állapotba kerül.

## Megoldás

`scripts/telegram-node-runtime.sh` kizárólag AVX nélküli Linux x86 hoston és kizárólag az official Telegram plugin cache pontos, nem symlinkelt verziókönyvtárain működik:

1. ellenőrzi a cache-útvonalat, package- és plugin-identitást;
2. elutasítja a symlinkelt útvonalat, `.mcp.json`, `server.ts`, manifestet és `node_modules`-t;
3. `npm install --ignore-scripts --omit=dev --no-audit --no-fund` paranccsal készíti elő a függőségeket, 120 másodperces korláttal;
4. atomikusan menti az eredeti Bun `.mcp.json`-t `.marveen-bun-backup` néven;
5. atomikusan a projekt tulajdonában lévő wrapperre irányítja az MCP parancsot;
6. futáskor Node 22/23 `--experimental-strip-types` módban indítja a validált `server.ts`-t.

A `channels.sh` ezt a tmux session létrehozása előtt futtatja. AVX-képes vagy nem Telegram hoston nincs változás. Token nincs a parancssorban vagy a naplóban.

## Ellenőrzés

```bash
bash scripts/__tests__/telegram-node-runtime.test.sh
bash scripts/__tests__/channels-startup-ownership.test.sh
bash -n scripts/telegram-node-runtime.sh scripts/channels.sh
npm run typecheck
```

Az izolált teszt ellenőrzi a helyes generált konfigurációt, lifecycle-script tiltását, hibás package-identitást, symlinkelt cache/config elutasítását, AVX-képes no-op viselkedést, runtime path confinementet és a Node indítás pontos argumentumait.

## Production canary

1. Futtasd: `scripts/telegram-node-runtime.sh --prepare`.
2. Ellenőrizd, hogy az aktív official Telegram plugin `.mcp.json` wrapperre mutat; titkot ne olvass ki.
3. Kontrollált `channels.sh restart` után ellenőrizd a pane-ben, hogy nincs `--channels ignored` és az MCP státusz healthy.
4. Ellenőrizd a plugin processzt/bot PID-t. Ne küldj próbaüzenetet.

## Rollback

1. Állítsd le a Channels supervisort/sessiont.
2. Az érintett valid official Telegram plugin verziókönyvtárban állítsd vissza a `.mcp.json.marveen-bun-backup` fájlt `.mcp.json` névre atomikus cserével.
3. Távolítsd el vagy kapcsold ki a `channels.sh` AVX-less `--prepare` hívását.
4. Indítsd újra a sessiont. AVX nélküli hoston ez visszaállítja a korábbi, ismerten nem működő Bun állapotot; ezért rollback csak hibakereséshez használható.
