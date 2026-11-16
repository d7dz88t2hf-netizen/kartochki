import Foundation

@main struct StorageTests {
 static func main() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let store = CollectionStore(url: directory.appendingPathComponent("kartochki.json"))
    let sample = Data(#"{"app":"kartochki","version":1,"decks":{"d1":{"name":"Тест","cards":[{"front":"Q","back":"A"}]}},"settings":{}}"#.utf8)
    precondition(store.boot().isEmpty)
    try store.save(sample)
    try store.save(sample)
    let backup = try store.read(store.backup)
    precondition(backup == sample)
    do { try store.save(Data("{}".utf8)); fatalError("Accepted invalid data") } catch {}
    let primary = try store.read(store.url)
    precondition(primary == sample)
    try Data("broken".utf8).write(to: store.url)
    precondition(store.boot()["notice"] != nil)
    try store.save(sample)
    let files = try FileManager.default.contentsOfDirectory(atPath: directory.path)
    precondition(files.contains { $0.hasPrefix("kartochki-corrupt-") })
    try Data("broken".utf8).write(to: store.url)
    try Data("broken".utf8).write(to: store.backup)
    precondition(store.boot()["error"] != nil)
    print("PASS: Swift storage, backup, invalid writes, recovery and damaged file preservation")
 }
}
