import Foundation

private struct SyncStateFile: Codable {
    var version: Int
    var records: [String: SyncRecord]
}

actor SyncStateStore {
    private let fileURL: URL
    private var records: [String: SyncRecord] = [:]

    init() {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("iCloudFriend", isDirectory: true)
        try? FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
        let stateURL = support.appendingPathComponent("sync-state.json")
        fileURL = stateURL
        records = Self.loadRecords(from: stateURL)
    }

    func record(for localIdentifier: String) -> SyncRecord? {
        records[localIdentifier]
    }

    func upsert(_ record: SyncRecord) throws {
        records[record.localIdentifier] = record
        try save()
    }

    func reset() throws {
        records = [:]
        try save()
    }

    private static func loadRecords(from fileURL: URL) -> [String: SyncRecord] {
        guard let data = try? Data(contentsOf: fileURL) else { return [:] }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        if let state = try? decoder.decode(SyncStateFile.self, from: data) {
            return state.records
        }
        return [:]
    }

    private func save() throws {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(SyncStateFile(version: 1, records: records))
        try data.write(to: fileURL, options: [.atomic])
    }
}
