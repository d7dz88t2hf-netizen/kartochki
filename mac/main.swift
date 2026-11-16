// Карточки для macOS: своё окно на движке Safari (WebKit), работает офлайн.
// Колоды хранятся в ~/Library/Application Support/Kartochki/kartochki.json
import Cocoa
import WebKit
import Darwin

final class AppDelegate: NSObject, NSApplicationDelegate, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate, NSWindowDelegate {
    var window: NSWindow!
    var web: WKWebView!

    var fileLock: Int32 = -1
    var terminating = false
    var appURL: URL!
    var store: CollectionStore { CollectionStore(url: dataURL) }

    let dataURL: URL = {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Kartochki", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("kartochki.json")
    }()

    func applicationDidFinishLaunching(_ note: Notification) {
        fileLock = open(dataURL.deletingLastPathComponent().appendingPathComponent("app.lock").path, O_CREAT | O_RDWR, 0o600)
        guard fileLock >= 0, flock(fileLock, LOCK_EX | LOCK_NB) == 0 else {
            let alert = NSAlert(); alert.messageText = "Коллекция уже открыта или недоступна"
            alert.informativeText = "Закройте другой экземпляр «Карточек» и проверьте доступ к папке данных."
            alert.runModal(); NSApp.terminate(nil); return
        }
        buildMenu()
        let content = WKUserContentController()
        content.add(self, name: "save")
        content.add(self, name: "download")
        content.add(self, name: "readyToClose")
        let boot = try! JSONSerialization.data(withJSONObject: store.boot()).base64EncodedString()
        let source = "window.DESKTOP_BOOT = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob('\(boot)'), c => c.charCodeAt(0))));"
        content.addUserScript(WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let config = WKWebViewConfiguration()
        config.userContentController = content
        config.preferences.javaScriptCanOpenWindowsAutomatically = false

        web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self
        web.uiDelegate = self

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1100, height: 820),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.delegate = self
        window.title = "Карточки"
        window.minSize = NSSize(width: 420, height: 520)
        window.contentView = web
        window.center()
        window.setFrameAutosaveName("KartochkiMain")

        let dir = Bundle.main.resourceURL!.appendingPathComponent("web", isDirectory: true)
        appURL = dir.appendingPathComponent("index.html").standardizedFileURL
        web.loadFileURL(appURL, allowingReadAccessTo: dir)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { true }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        NSApp.terminate(nil)
        return false
    }

    func applicationShouldTerminate(_ app: NSApplication) -> NSApplication.TerminateReply {
        if web == nil { return .terminateNow }
        if terminating { return .terminateCancel }
        terminating = true
        web.evaluateJavaScript("window.flushSave ? window.flushSave().then(() => window.webkit.messageHandlers.readyToClose.postMessage(true), () => window.webkit.messageHandlers.readyToClose.postMessage(false)) : window.webkit.messageHandlers.readyToClose.postMessage(true);null") { _, error in
            if error != nil { self.terminating = false; app.reply(toApplicationShouldTerminate: true) }
        }
        return .terminateLater
    }

    func reply(_ id: String, error: String? = nil, cancelled: Bool = false) {
        let args: [Any] = [id, error.map { $0 as Any } ?? NSNull(), cancelled]
        guard let data = try? JSONSerialization.data(withJSONObject: args),
              let json = String(data: data, encoding: .utf8) else { return }
        web.evaluateJavaScript("window.nativeResult(...\(json))", completionHandler: nil)
    }

    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
        guard m.frameInfo.isMainFrame, m.frameInfo.request.url?.standardizedFileURL == appURL else { return }
        if m.name == "readyToClose", let success = m.body as? Bool, terminating {
            terminating = false
            if !success {
                let alert = NSAlert(); alert.messageText = "Изменения не сохранены"
                alert.informativeText = "Повторите сохранение или сделайте резервную копию перед выходом."
                alert.beginSheetModal(for: window)
            }
            NSApp.reply(toApplicationShouldTerminate: success)
            return
        }
        guard let body = m.body as? [String: Any], let id = body["id"] as? String else { return }
        if m.name == "save", let text = body["data"] as? String {
            do { try store.save(Data(text.utf8)); reply(id) }
            catch { reply(id, error: error.localizedDescription) }
        } else if m.name == "download", let name = body["filename"] as? String, let text = body["data"] as? String {
            let panel = NSSavePanel()
            panel.nameFieldStringValue = String(name.prefix(160))
            panel.beginSheetModal(for: window) { result in
                guard result == .OK, let url = panel.url else { self.reply(id, cancelled: true); return }
                do { try text.write(to: url, atomically: true, encoding: .utf8); self.reply(id) }
                catch { self.reply(id, error: error.localizedDescription) }
            }
        }
    }

    // Выбор файла для «Загрузить файл»
    func webView(_ w: WKWebView, runOpenPanelWith p: WKOpenPanelParameters,
                 initiatedByFrame f: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        panel.beginSheetModal(for: window) { r in completionHandler(r == .OK ? panel.urls : nil) }
    }

    // Внешние ссылки открываем в браузере, а не в окне программы
    func webView(_ w: WKWebView, decidePolicyFor a: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let u = a.request.url else { decisionHandler(.cancel); return }
        if u.standardizedFileURL == appURL && a.targetFrame?.isMainFrame == true {
            decisionHandler(.allow)
        } else {
            if (u.scheme == "http" || u.scheme == "https"), a.navigationType == .linkActivated {
                NSWorkspace.shared.open(u)
            }
            decisionHandler(.cancel)
        }
    }

    // Меню: без «Правки» не работают копирование и вставка
    func buildMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem(); main.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "О программе «Карточки»", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Скрыть «Карточки»", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Завершить «Карточки»", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu

        let editItem = NSMenuItem(); main.addItem(editItem)
        let edit = NSMenu(title: "Правка")
        edit.addItem(withTitle: "Отменить", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = edit.addItem(withTitle: "Повторить", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        edit.addItem(.separator())
        edit.addItem(withTitle: "Вырезать", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Скопировать", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Вставить", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Выбрать все", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit

        let winItem = NSMenuItem(); main.addItem(winItem)
        let win = NSMenu(title: "Окно")
        win.addItem(withTitle: "Свернуть", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        win.addItem(withTitle: "Закрыть", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        winItem.submenu = win
        NSApp.mainMenu = main
        NSApp.windowsMenu = win
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
