// Карточки для macOS: своё окно на движке Safari (WebKit), работает офлайн.
// Колоды хранятся в ~/Library/Application Support/Kartochki/kartochki.json
import Cocoa
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate {
    var window: NSWindow!
    var web: WKWebView!

    let dataURL: URL = {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Kartochki", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("kartochki.json")
    }()

    func applicationDidFinishLaunching(_ note: Notification) {
        buildMenu()
        let content = WKUserContentController()
        content.add(self, name: "save")
        content.add(self, name: "download")
        let saved = (try? String(contentsOf: dataURL, encoding: .utf8)) ?? "null"
        content.addUserScript(WKUserScript(source: "window.DESKTOP_DATA = \(saved);",
                                           injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let config = WKWebViewConfiguration()
        config.userContentController = content

        web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self
        web.uiDelegate = self

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1100, height: 820),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "Карточки"
        window.minSize = NSSize(width: 420, height: 520)
        window.contentView = web
        window.center()
        window.setFrameAutosaveName("KartochkiMain")

        let dir = Bundle.main.resourceURL!.appendingPathComponent("web", isDirectory: true)
        web.loadFileURL(dir.appendingPathComponent("index.html"), allowingReadAccessTo: dir)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { true }

    // Сообщения из страницы: сохранить колоды, скачать файл экспорта
    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
        if m.name == "save", let text = m.body as? String {
            save(text)
        } else if m.name == "download", let d = m.body as? [String: Any],
                  let name = d["filename"] as? String, let data = d["data"] as? String {
            let panel = NSSavePanel()
            panel.nameFieldStringValue = name
            panel.beginSheetModal(for: window) { r in
                if r == .OK, let url = panel.url { try? data.write(to: url, atomically: true, encoding: .utf8) }
            }
        }
    }

    // Пишем через временный файл, прошлую версию оставляем как .bak
    func save(_ text: String) {
        let fm = FileManager.default
        let tmp = dataURL.appendingPathExtension("tmp")
        let bak = dataURL.appendingPathExtension("bak")
        do {
            try text.write(to: tmp, atomically: true, encoding: .utf8)
            if fm.fileExists(atPath: dataURL.path) {
                try? fm.removeItem(at: bak)
                try? fm.moveItem(at: dataURL, to: bak)
            }
            try fm.moveItem(at: tmp, to: dataURL)
        } catch {
            NSSound.beep()
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
        if let u = a.request.url, u.scheme == "http" || u.scheme == "https" {
            NSWorkspace.shared.open(u)
            decisionHandler(.cancel)
        } else {
            decisionHandler(.allow)
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
