# TMNT (Arcade) — HTML5 remake

Fan remake of Konami's 1989 *Teenage Mutant Ninja Turtles* arcade game, running in the browser and as a Windows desktop app.

This repository contains **only original source code** for the remake (emulator, renderer, input, netplay, tools and tests). It does **not** include the game ROM, Konami graphics, audio, or any other copyrighted assets. You must provide your own legally obtained MAME `tmnt.zip` (World 4 Players ver. X). The in-game loader checks the ROM and can cache it locally in the browser (IndexedDB).

*Teenage Mutant Ninja Turtles* and all related characters, names and artwork are trademarks or copyrights of their respective owners (including Konami, Mirage Studios and others). This is an unofficial fan project and is not affiliated with, endorsed by, or connected to those owners.

**Web build:** `20261120-highscore-0053`.

## Run locally (web)

1. Clone this repository.
2. Serve the `web/` folder over HTTP (a static server is enough for single-player and for the ROM picker):

   ```bash
   python3 -m http.server --directory web 8080
   ```

3. Open `http://localhost:8080/` and select your `tmnt.zip` when asked.

Do not put a ROM in the repo. A local `web/roms/tmnt.zip` is picked up automatically if you place it there for your own use; that path is gitignored.

Online play (rooms, spectators, voice, online highscores) is **web-only**. It uses the `games4me-netplay` Cloudflare Worker (`tmnt_web`). The desktop app has no online multiplayer.

Self-hosting the legacy PHP signaler (`web/net/signal.php`) is optional and needs a `turn_config.php` next to it (not included; never commit secrets).

## Desktop (Windows x64)

The Electron app is local-only: no online play, no ROM bundled. On first launch the loader asks for your `tmnt.zip`.

```bash
cd desktop
npm install
./build.sh
```

The zip is written to `dist/desktop/` (that folder is gitignored).

## Layout

- `web/` — browser game (engine, renderer, ROM loader, netplay)
- `desktop/` — Electron shell and public Windows build script
- `tools/` — packaging and verification helpers
- `test/` — regression and netplay tests (they expect a local ROM; they do not ship one)
- `run/` — optional MAME helper scripts for comparison tests

## URLs

In the web game, links are relative, except the Open Graph / Twitter / canonical tags, which point at the live page: `https://games4me.alwaysdata.net/tmnt_web/`.

---

# TMNT (Arcade) — remake em HTML5

Remake feito por fãs do arcade *Teenage Mutant Ninja Turtles* (Konami, 1989), para o navegador e para um aplicativo de Windows.

Este repositório contém **somente código-fonte original** do remake (emulador, renderizador, controles, jogo online, ferramentas e testes). Ele **não** inclui a ROM do jogo, gráficos da Konami, áudio nem outros materiais protegidos por direitos autorais. Você precisa usar o seu próprio `tmnt.zip` da MAME (World 4 Players ver. X), obtido de forma legal. O carregador do jogo confere a ROM e pode guardá-la no navegador (IndexedDB).

*Teenage Mutant Ninja Turtles* e os personagens, nomes e artes relacionados são marcas ou obras de seus respectivos donos (incluindo Konami, Mirage Studios e outros). Este é um projeto não oficial de fãs e não tem vínculo, endosso ou relação com esses donos.

**Build web:** `20261120-highscore-0053`.

## Rodar localmente (web)

1. Clone este repositório.
2. Sirva a pasta `web/` por HTTP (um servidor estático basta para um jogador e para escolher a ROM):

   ```bash
   python3 -m http.server --directory web 8080
   ```

3. Abra `http://localhost:8080/` e selecione o seu `tmnt.zip` quando o jogo pedir.

Não coloque a ROM no repositório. Se você criar um `web/roms/tmnt.zip` só na sua máquina, o jogo usa esse arquivo automaticamente; esse caminho está no `.gitignore`.

O jogo online (salas, espectadores, voz e placar online) é **somente na versão web**, pelo Worker `games4me-netplay` (`tmnt_web`). O aplicativo para desktop não tem multiplayer online.

Hospedar o sinalizador PHP antigo (`web/net/signal.php`) é opcional e exige um `turn_config.php` ao lado (não vem no repositório; nunca envie segredos no git).

## Desktop (Windows x64)

O app em Electron é só local: sem jogo online e sem ROM embutida. Na primeira abertura o carregador pede o seu `tmnt.zip`.

```bash
cd desktop
npm install
./build.sh
```

O zip vai para `dist/desktop/` (essa pasta fica de fora do git).

## Pastas

- `web/` — jogo no navegador (motor, renderizador, carregador de ROM, netplay)
- `desktop/` — casca Electron e script da build pública para Windows
- `tools/` — ferramentas de empacote e verificação
- `test/` — testes de regressão e netplay (eles usam uma ROM local; ela não vem no repositório)
- `run/` — scripts opcionais da MAME para testes de comparação

## URLs

No jogo web, os links são relativos, exceto as tags Open Graph / Twitter / canonical, que apontam para a página no ar: `https://games4me.alwaysdata.net/tmnt_web/`.
