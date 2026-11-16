import Foundation
import CoreFoundation

struct CollectionStore {
    static let maxBytes = 32 * 1024 * 1024
    let url: URL
    let fm = FileManager.default
    var backup: URL { url.appendingPathExtension("bak") }

    func validate(_ data: Data) throws -> [String: Any] {
        guard data.count <= Self.maxBytes,
              let value = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              value["app"] as? String == "kartochki",
              value["version"] as? Int == 1,
              let decks = value["decks"] as? [String: Any],
              value["settings"] is [String: Any] else {
            throw NSError(domain: "Kartochki", code: 1, userInfo: [NSLocalizedDescriptionKey: "Некорректный файл коллекции"])
        }
        var count = 0
        for entry in decks.values {
            guard let deck = entry as? [String: Any], deck["name"] is String,
                  let cards = deck["cards"] as? [[String: Any]],
                  cards.allSatisfy({ ($0["front"] as? String)?.isEmpty == false && $0["back"] is String }) else {
                throw NSError(domain: "Kartochki", code: 2, userInfo: [NSLocalizedDescriptionKey: "Некорректная колода"])
            }
            count += cards.count
        }
        guard count <= 100000 else { throw NSError(domain: "Kartochki", code: 3, userInfo: [NSLocalizedDescriptionKey: "Слишком много карточек"]) }
        try validateFields(value)
        return value
    }

    func read(_ path: URL) throws -> Data {
        let size = try path.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
        guard size <= Self.maxBytes else { throw NSError(domain: "Kartochki", code: 4, userInfo: [NSLocalizedDescriptionKey: "Файл превышает 32 МБ"]) }
        let data = try Data(contentsOf: path)
        _ = try validate(data)
        return data
    }

    func boot() -> [String: Any] {
        do { return ["data": try validate(read(url))] }
        catch {
            if let data = try? read(backup), let value = try? validate(data) {
                return ["data": value, "notice": "Коллекция восстановлена из резервной копии"]
            }
            if !fm.fileExists(atPath: url.path) && !fm.fileExists(atPath: backup.path) { return [:] }
            return ["error": "Не удалось прочитать коллекцию и резервную копию. " + error.localizedDescription]
        }
    }

    func writePrivate(_ data: Data, to path: URL) throws {
        try data.write(to: path, options: .atomic)
        try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path.path)
    }

    func save(_ data: Data) throws {
        _ = try validate(data)
        try fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true,
                               attributes: [.posixPermissions: 0o700])
        try fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: url.deletingLastPathComponent().path)
        if fm.fileExists(atPath: url.path) {
            if let previous = try? read(url) {
                try writePrivate(previous, to: backup)
            } else {
                let damaged = url.deletingLastPathComponent().appendingPathComponent("kartochki-corrupt-\(UUID().uuidString).json")
                try fm.copyItem(at: url, to: damaged)
                try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: damaged.path)
            }
        }
        try writePrivate(data, to: url)
    }
}

extension CollectionStore {
    func validateFields(_ value: [String: Any]) throws {
        let bad = NSError(domain: "Kartochki", code: 5, userInfo: [NSLocalizedDescriptionKey: "Некорректные настройки или прогресс"])
        func number(_ m: [String: Any], _ key: String, _ min: Double = 0, _ max: Double = 1e12, integer: Bool = false) -> Bool {
            guard let raw = m[key] else { return true }
            guard let n = raw as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else { return false }
            let x = n.doubleValue
            return x.isFinite && x >= min && x <= max && (!integer || x.rounded() == x)
        }
        func text(_ x: Any?) -> Bool { guard let s = x as? String else { return false }; return s.utf16.count <= 200000 }
        guard number(value, "version", 1, 1, integer: true), let settings = value["settings"] as? [String: Any], number(settings, "newPerDay", 0, 100000, integer: true) else { throw bad }
        if let theme = settings["theme"], !["light", "dark"].contains(theme as? String ?? "") { throw bad }
        var deckIDs = Set<String>()
        for raw in (value["decks"] as! [String: Any]).values {
            let d = raw as! [String: Any]
            guard text(d["name"]), number(d, "created", 0, 8640000000000000) else { throw bad }
            if let id = d["id"] as? String, !deckIDs.insert(id).inserted { throw bad }
            if let rawLog = d["newLog"], !(rawLog is NSNull) {
                guard let log = rawLog as? [String: Any], let date = log["date"] as? String,
                      date.range(of: #"^\d{4}-\d{2}-\d{2}$"#, options: .regularExpression) != nil,
                      number(log, "count") else { throw bad }
            }
            var ids = Set<String>()
            for c in d["cards"] as! [[String: Any]] {
                guard text(c["front"]), text(c["back"]), !(c["front"] as! String).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw bad }
                if let id = c["id"] as? String, !ids.insert(id).inserted { throw bad }
                if let state = c["state"], !["new", "learn", "review"].contains(state as? String ?? "") { throw bad }
                if c["freq"] != nil {
                    guard number(c, "freq", 0.25, 4), let freq = c["freq"] as? NSNumber, [0.25, 0.5, 1, 2, 4].contains(freq.doubleValue) else { throw bad }
                }
                for key in ["due", "last"] { if !number(c, key, 0, 8640000000000000) { throw bad } }
                for key in ["interval", "reps", "lapses", "step"] { if !number(c, key) { throw bad } }
                if !number(c, "ease", 1.3, 1000) { throw bad }
            }
        }
    }
}
