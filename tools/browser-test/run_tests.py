import subprocess, sys, time, json, os
from playwright.sync_api import sync_playwright
root = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
srv = subprocess.Popen([sys.executable, '-m', 'http.server', '8931', '--bind', '127.0.0.1'], cwd=root, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(0.8)
try:
    with sync_playwright() as p:
        b = p.chromium.launch(); page = b.new_page(); errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        page.goto('http://127.0.0.1:8931/tools/browser-test/index.html')
        page.wait_for_function('window.__results', timeout=60000)
        res = page.evaluate('window.__results')
        for r in res: print(('PASS ' if r['ok'] else 'FAIL ') + r['name'] + ('' if r['ok'] else '\n     ' + r['error']))
        print(f"\n{sum(r['ok'] for r in res)} of {len(res)} passed", '| page errors:', errs or 'none')
        b.close()
finally:
    srv.terminate()
