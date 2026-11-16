#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .build
BUILD=$(mktemp -d "$PWD/.build/native-test.XXXXXX")
trap 'rm -rf "$BUILD"' EXIT
python3 - "$BUILD" <<'PY'
from pathlib import Path
import sys,json
out=Path(sys.argv[1]);src=Path('mac/main.swift').read_text()
a=src.index('    let dataURL: URL = {');b=src.index('\n\n    func applicationDidFinishLaunching',a)
src=src[:a]+'    let dataURL = URL(fileURLWithPath: '+json.dumps(str(out/'data'/'kartochki.json'))+')'+src[b:]
runner='''
var attempts = 0
var started = false
let testTimer = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { timer in
 attempts += 1
 if attempts > 100 {
  timer.invalidate()
  delegate.web.evaluateJavaScript("JSON.stringify({url:location.href,body:document.body?.innerText,model:typeof Model,app:typeof createDeck,boot:window.DESKTOP_BOOT,errors:window.TEST_ERRORS})") { value,error in
   print("NATIVE DIAGNOSTIC",value ?? "nil",error ?? "no error");exit(1)
  }
  return
 }
 if started { return }
 delegate.web?.evaluateJavaScript("typeof createDeck === 'function' && location.protocol === 'file:' && document.readyState === 'complete' && !document.querySelector('.startup-cover')") { value, error in
  if (value as? Bool) != true || started { return }
  started = true
  delegate.web.evaluateJavaScript("createDeck('Native test', [makeCard('Question', 'Answer')]);null") { _, error in
   if let error = error { fputs("FAIL: \\(error)\\n", stderr); exit(1) }
   // Close immediately, while the JS -> native save acknowledgement is pending.
   NSApp.terminate(nil)
  }
 }
}
app.run()
'''
src=src.replace('app.run()',runner)
src=src.replace('        let config = WKWebViewConfiguration()', '''        content.addUserScript(WKUserScript(source: "window.TEST_ERRORS=[];window.addEventListener('error',e=>window.TEST_ERRORS.push(e.message));", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let config = WKWebViewConfiguration()\n        config.websiteDataStore = .nonPersistent()''')
(out/'main.swift').write_text(src)
(out/'data').mkdir()
seed={'app':'kartochki','version':1,'settings':{'theme':'light','newPerDay':20},'decks':{'dSeed':{'id':'dSeed','name':'Начальная колода','cards':[{'id':'cSeed','front':'</script>\u2028Привет','back':'Ответ'}]}}}
(out/'data'/'kartochki.json').write_text(json.dumps(seed,ensure_ascii=False))
PY
mkdir -p "$BUILD/data" "$BUILD/Test.app/Contents/MacOS" "$BUILD/Test.app/Contents/Resources"
cp mac/Info.plist "$BUILD/Test.app/Contents/Info.plist"
cp -R web "$BUILD/Test.app/Contents/Resources/web"
xcrun swiftc -module-cache-path "$PWD/mac/.build/module-cache" "$BUILD/main.swift" mac/Storage.swift -o "$BUILD/Test.app/Contents/MacOS/Kartochki"
codesign --force --sign - "$BUILD/Test.app"
"$BUILD/Test.app/Contents/MacOS/Kartochki"
python3 - "$BUILD/data/kartochki.json" <<'PY'
import json,sys
from pathlib import Path
p=Path(sys.argv[1]);data=json.loads(p.read_text());decks=list(data['decks'].values())
assert len(decks)==2
assert next(d for d in decks if d['name']=='Native test')['cards'][0]['front']=='Question'
assert data['decks']['dSeed']['cards'][0]['front']=='</script>\u2028Привет'
print('PASS: actual WKWebView, startup injection, JS bridge, native disk write, immediate close with pending save')
PY
