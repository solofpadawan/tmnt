#!/usr/bin/env python3
"""TMNT i18n smoke: ?lang=pt / ?lang=en / navigator languages; EN leak scan; PT dump vs baseline."""
import os, sys, json, time, socket, subprocess, re
from playwright.sync_api import sync_playwright
from pathlib import Path

WEB = sys.argv[1] if len(sys.argv) > 1 else '/workspace/tmnt-i18n-20261109-i18n-1127/assemble'
PREV = sys.argv[2] if len(sys.argv) > 2 else '/workspace/tmnt-i18n-20261109-i18n-1127/previews'
REF = sys.argv[3] if len(sys.argv) > 3 else '/workspace/tmnt-i18n-20261109-i18n-1127/ref-pt/old-pt-dump.txt'
os.makedirs(PREV, exist_ok=True)

PT_LEAKS = ['Criar sala', 'Multijogador', 'Assistir', 'Carregando salas', 'Nenhuma sala', 'Sala pública',
  'ou entre com o código', 'Salas abertas', 'Anfitrião', 'Seu apelido', 'Jogador N', 'ASSISTINDO',
  'Copiar link', 'Sair da sala', 'Entrar como jogador', 'Cheia', 'ficha', 'Tela de título']

s = socket.socket(); s.bind(('127.0.0.1', 0)); port = s.getsockname()[1]; s.close()
srv = subprocess.Popen([sys.executable, '-m', 'http.server', str(port), '--bind', '127.0.0.1', '-d', WEB],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(0.8)
BASE = f'http://127.0.0.1:{port}/index.html'
ok = True
results = {}

DUMP_KEYS = [
  'net.btn','net.title','net.nick.label','net.nick.placeholder','net.create','net.publicLabel','net.code.or',
  'net.code.placeholder','net.join','net.watch','net.fullBtn','net.rooms.open','net.rooms.loading','net.rooms.empty',
  'net.th.room','net.th.host','net.th.players','net.th.spec','net.th.stage','net.stage.playing','net.stage.title',
  'net.defaultHost','net.copy','net.whatsapp','net.pendingJoin','net.slot.free','net.slot.you','net.slot.connected',
  'net.slot.host','net.specs.none','net.watching','net.slotFree','net.promote','net.help','net.copied','net.watchingRecv',
  'net.hostGone','net.opening','net.connecting','net.receiving','net.relay','net.fail','net.retry','net.err.prefix',
  'net.err.badCode','net.waText','net.pubStatus','net.privStatus','net.invite','net.roomOnly','net.meta.player1','chat.placeholder','chat.watching','chat.spectator','hint.kb','hint.pad','hint.kbJ','hint.padJ',
  'hint.vaga','hint.vagaPad','hint.wait.connecting','hint.wait.receiving','hint.wait.relay','hint.wait.fail','hint.wait.fail2',
  'rom.h','rom.d','rom.b','rom.n','rom.r'
]

with sync_playwright() as p:
  args = ['--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling']
  def boot(query, chrome_lang=None, shot=None, force_public=False):
    b = p.chromium.launch(args=args)
    ctx_kwargs = {'viewport': {'width': 1100, 'height': 700}}
    if chrome_lang: ctx_kwargs['locale'] = chrome_lang
    ctx = b.new_context(**ctx_kwargs)
    pg = ctx.new_page()
    # Without local roms/tmnt.zip fetch succeeding... it exists in assemble so game boots.
    # For ROM loader shot: use TMNT_PUBLIC=1 via query? It's set by window.TMNT_PUBLIC in itch builds.
    # Force public for loader: inject before load
    if force_public:
      pg.add_init_script('window.TMNT_PUBLIC = 1; try { indexedDB.deleteDatabase("tmnt"); } catch(e) {}')
    pg.goto(BASE + query)
    pg.evaluate('TMNTG.whenReady')
    info = pg.evaluate('''() => ({
      lng: window.SSRI18N && SSRI18N.language,
      create: t('net.create'), btn: document.getElementById('npb').textContent,
      ready: !!(window.t && window.SSRI18N && SSRI18N.ready)
    })''')
    pg.evaluate('document.getElementById("npb").click()')
    time.sleep(0.5)
    # refresh list area
    html = pg.evaluate("document.getElementById('np').innerText")
    dump = pg.evaluate('keys => Object.fromEntries(keys.map(k => [k, t(k)]))', DUMP_KEYS)
    if shot:
      pg.screenshot(path=os.path.join(PREV, shot))
    return b, pg, info, html, dump

  # ?lang=pt
  b, pg, info, html, dump_pt = boot('?lang=pt&sound=0', 'en-US', 'i18n-panel-pt.png')
  results['lang_pt'] = info
  print('PT', info)
  print('PT panel:', html.replace('\n',' | ')[:300])
  if info['create'] != 'Criar sala' or info['lng'] != 'pt' or 'Criar sala' not in html:
    print('FAIL pt labels'); ok = False
  # chat placeholder
  ph = pg.evaluate("document.getElementById('chatin') && document.getElementById('chatin').placeholder")
  print('PT chat ph', ph)
  if ph != 'Mensagem (Enter envia, Esc cancela)':
    print('FAIL pt chat placeholder'); ok = False
  b.close()

  # ?lang=en
  b, pg, info, html, dump_en = boot('?lang=en&sound=0', 'pt-BR', 'i18n-panel-en.png')
  results['lang_en'] = info
  print('EN', info)
  print('EN panel:', html.replace('\n',' | ')[:300])
  leaks = [s for s in PT_LEAKS if s in html or s in (info.get('btn') or '')]
  print('EN leaks', leaks)
  if leaks:
    print('FAIL EN PT leaks'); ok = False
  if info['create'] != 'Create room' or info['lng'] != 'en' or 'Create room' not in html:
    print('FAIL en labels'); ok = False
  # open chat via TAB to capture? placeholder already set
  ph = pg.evaluate("document.getElementById('chatin').placeholder")
  print('EN chat ph', ph)
  if ph != 'Message (Enter sends, Esc cancels)':
    print('FAIL en chat placeholder'); ok = False
  # room list EN headers
  if 'Host' not in html and 'Anfitrião' in html:
    print('FAIL en still has Anfitrião'); ok = False
  # chat bubble tag key
  tag = pg.evaluate("t('chat.watching')")
  if tag != 'SPECTATING':
    print('FAIL en watching tag', tag); ok = False
  b.close()

  # navigator pt-BR without ?lang=
  b, pg, info, html, _ = boot('?sound=0', 'pt-BR', 'i18n-nav-ptBR.png')
  results['nav_pt'] = info
  print('NAV pt-BR', info)
  if info['lng'] != 'pt' or info['create'] != 'Criar sala':
    print('FAIL navigator pt-BR'); ok = False
  b.close()

  # navigator en-US without ?lang=
  b, pg, info, html, _ = boot('?sound=0', 'en-US', 'i18n-nav-enUS.png')
  results['nav_en'] = info
  print('NAV en-US', info)
  if info['lng'] != 'en' or info['create'] != 'Create room':
    print('FAIL navigator en-US'); ok = False
  b.close()

  # ROM loader EN/PT screenshots (force public so local roms/tmnt.zip is skipped)
  for lang, name in [('pt', 'i18n-romload-pt.png'), ('en', 'i18n-romload-en.png')]:
    b = p.chromium.launch(args=args)
    pg = b.new_page(viewport={'width': 960, 'height': 640})
    pg.add_init_script('window.TMNT_PUBLIC = 1; try { indexedDB.deleteDatabase("tmnt"); } catch(e) {}')
    pg.goto(BASE + f'?lang={lang}&sound=0')
    # wait for #romload
    pg.wait_for_selector('#romload', timeout=15000)
    time.sleep(0.4)
    txt = pg.evaluate("document.querySelector('#romload').innerText")
    print('ROM', lang, txt.replace('\n',' | ')[:220])
    if lang == 'en':
      el = [s for s in ['Selecione', 'Escolher arquivo', 'arraste o arquivo'] if s in txt]
      if el: print('FAIL romloader EN leaks', el); ok = False
      if 'tmnt.zip' not in txt or 'Choose file' not in txt: print('FAIL romloader EN missing'); ok = False
    else:
      if 'Selecione o seu' not in txt or 'Escolher arquivo' not in txt: print('FAIL romloader PT'); ok = False
    pg.screenshot(path=os.path.join(PREV, name))
    b.close()

  # Netplay host panel with room list after create (EN + PT) for richer previews
  for lang, shot in [('en', 'i18n-host-en.png'), ('pt', 'i18n-host-pt.png')]:
    b = p.chromium.launch(args=args)
    pg = b.new_page(viewport={'width': 1100, 'height': 700})
    pg.add_init_script('try { localStorage.setItem("tmnt_nick","teste"); localStorage.setItem("tmnt_public","1"); } catch(e) {}')
    pg.goto(BASE + f'?lang={lang}&sound=0')
    pg.evaluate('TMNTG.whenReady')
    pg.evaluate('TMNTNETPLAY.host(true)')
    pg.wait_for_function('!!(TMNTNETPLAY.state && TMNTNETPLAY.state.room)', timeout=20000)
    time.sleep(1)
    pg.evaluate('document.getElementById("npb").click()')
    time.sleep(0.4)
    pg.screenshot(path=os.path.join(PREV, shot))
    # leave
    try: pg.evaluate('TMNTNETPLAY.leave()')
    except Exception: pass
    b.close()

srv.terminate()

print('PT dump keys', len(dump_pt))
Path(os.path.join(os.path.dirname(PREV), 'ref-pt', 'new-pt-dump.txt')).write_text('\n'.join(f'{k}={v}' for k,v in sorted(dump_pt.items())), encoding='utf-8')
# Compare exact catalogue values against hardcoded originals
checks = {
  'net.create': 'Criar sala',
  'net.btn': 'Multijogador (F7)',
  'hint.kb': 'Aperte 5 para colocar ficha, depois Z (ataque) para entrar',
  'hint.pad': 'Aperte Select para colocar ficha, depois A para entrar',
  'rom.h': 'Selecione o seu <b>tmnt.zip</b> da MAME (World 4 Players ver. X)',
  'rom.n': 'Esta página não tem nenhum dado do jogo: use a sua própria ROM. Ela é lida e guardada só no seu navegador; nada é enviado.',
  'net.help': 'Espectadores assistem e podem usar o chat (a mensagem aparece no alto da tela).<br>Para entrar no jogo: ficha (5) e depois ataque, como no fliperama.<br>Chat: <b>TAB</b> abre o campo, <b>Enter</b> envia (aparece num balão sobre o seu personagem), <b>Esc</b> cancela.<br><b>Microfone:</b> ele começa <b>desligado</b>; clique uma vez no botão da seção "Voz" para ativar (clique de novo para desligar). Sua voz só é enviada enquanto você fala. O som do jogo abaixa enquanto alguém fala. Dá para silenciar cada jogador e ajustar o volume da voz. Espectadores só ouvem.',
  'net.waText': 'Bora jogar Tartarugas Ninja comigo! {{link}}',
  'chat.watching': 'ASSISTINDO',
}
diff = {k: (checks[k], dump_pt.get(k)) for k in checks if dump_pt.get(k) != checks[k]}
print('PT exact diffs', diff)
if diff:
  ok = False

print('PASS' if ok else 'FAIL')
sys.exit(0 if ok else 1)
