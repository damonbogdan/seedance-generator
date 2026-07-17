import Cocoa
import WebKit

// Свой уникальный порт: 5178 делил с Vite-сервером Clay Studio → оболочка грузила чужой UI.
let PORT = 5265
// Единый первоисточник: приложение всегда запускает сервер из рабочей git-папки,
// поэтому любая наша правка кода попадает в приложение при следующем запуске.
let PROJECT = "/Users/dimonbogdanov/Claude/seedance-generator"
let NODE = "/usr/local/bin/node"
// 127.0.0.1, а не localhost: localhost на macOS резолвится в IPv6 ::1, и туда мог сесть чужой сервер;
// наш сервер и portOpen() работают по IPv4 127.0.0.1 — грузим ровно его.
let APP_URL = "http://127.0.0.1:\(PORT)"

func portOpen() -> Bool {
    let s = socket(AF_INET, SOCK_STREAM, 0)
    if s < 0 { return false }
    defer { close(s) }
    var addr = sockaddr_in()
    addr.sin_family = sa_family_t(AF_INET)
    addr.sin_port = UInt16(PORT).bigEndian
    addr.sin_addr.s_addr = inet_addr("127.0.0.1")
    let r = withUnsafePointer(to: &addr) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            connect(s, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
        }
    }
    return r == 0
}

var serverProcess: Process?

func startServer() {
    if portOpen() { return }
    let home = NSHomeDirectory()
    let dir = "\(home)/seedance"
    try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    let logPath = "\(dir)/server.log"
    if !FileManager.default.fileExists(atPath: logPath) {
        FileManager.default.createFile(atPath: logPath, contents: nil)
    }
    let p = Process()
    p.executableURL = URL(fileURLWithPath: NODE)
    p.arguments = ["server.mjs"]
    p.currentDirectoryURL = URL(fileURLWithPath: PROJECT)
    if let fh = try? FileHandle(forWritingTo: URL(fileURLWithPath: logPath)) {
        fh.seekToEndOfFile()
        p.standardOutput = fh
        p.standardError = fh
    }
    try? p.run()
    serverProcess = p
    for _ in 0..<30 { if portOpen() { break }; usleep(400_000) }
}

class AppDelegate: NSObject, NSApplicationDelegate, WKUIDelegate, WKNavigationDelegate {
    var window: NSWindow!
    var webView: WKWebView!

    func applicationDidFinishLaunching(_ note: Notification) {
        startServer()

        let cfg = WKWebViewConfiguration()
        cfg.mediaTypesRequiringUserActionForPlayback = []
        webView = WKWebView(frame: .zero, configuration: cfg)
        webView.uiDelegate = self
        webView.navigationDelegate = self

        let rect = NSRect(x: 0, y: 0, width: 1280, height: 900)
        window = NSWindow(contentRect: rect,
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "Damon Videogen"
        window.center()
        window.setFrameAutosaveName("SeedanceMain")
        window.contentView = webView
        window.makeKeyAndOrderFront(nil)

        if let url = URL(string: APP_URL) {
            webView.load(URLRequest(url: url))
        }
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ s: NSApplication) -> Bool { true }
    func applicationWillTerminate(_ note: Notification) { serverProcess?.terminate() }

    // <input type=file> → нативный диалог выбора файлов
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = false
        panel.canChooseFiles = true
        panel.begin { resp in completionHandler(resp == .OK ? panel.urls : nil) }
    }

    // JS-диалоги (alert/confirm/prompt) — иначе confirm() удаления и prompt() не работают в WKWebView
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let a = NSAlert(); a.messageText = message; a.addButton(withTitle: "OK"); a.runModal(); completionHandler()
    }
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let a = NSAlert(); a.messageText = message
        a.addButton(withTitle: "OK"); a.addButton(withTitle: "Отмена")
        completionHandler(a.runModal() == .alertFirstButtonReturn)
    }
    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String,
                 defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let a = NSAlert(); a.messageText = prompt
        a.addButton(withTitle: "OK"); a.addButton(withTitle: "Отмена")
        let tf = NSTextField(frame: NSRect(x: 0, y: 0, width: 280, height: 24)); tf.stringValue = defaultText ?? ""
        a.accessoryView = tf
        completionHandler(a.runModal() == .alertFirstButtonReturn ? tf.stringValue : nil)
    }

    // target="_blank" (напр. «Купить токены») → открыть в системном браузере
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url { NSWorkspace.shared.open(url) }
        return nil
    }

    // внешние ссылки и скачивание результата — в системный браузер, не внутри окна приложения
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let url = navigationAction.request.url {
            let host = url.host ?? ""
            let isLocal = host == "localhost" || host == "127.0.0.1"
            let isDownload = url.path.contains("/api/media/")
            if navigationAction.navigationType == .linkActivated && (!isLocal || isDownload) {
                NSWorkspace.shared.open(url)
                decisionHandler(.cancel)
                return
            }
        }
        decisionHandler(.allow)
    }
}

func buildMenu() {
    let mainMenu = NSMenu()

    let appItem = NSMenuItem()
    mainMenu.addItem(appItem)
    let appMenu = NSMenu()
    appItem.submenu = appMenu
    appMenu.addItem(withTitle: "About Damon Videogen", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
    appMenu.addItem(NSMenuItem.separator())
    appMenu.addItem(withTitle: "Hide", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
    appMenu.addItem(withTitle: "Quit Damon Videogen", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")

    let editItem = NSMenuItem()
    mainMenu.addItem(editItem)
    let editMenu = NSMenu(title: "Edit")
    editItem.submenu = editMenu
    editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
    editMenu.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
    editMenu.addItem(NSMenuItem.separator())
    editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
    editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
    editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
    editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")

    NSApp.mainMenu = mainMenu
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = AppDelegate()
app.delegate = delegate
buildMenu()
app.run()
