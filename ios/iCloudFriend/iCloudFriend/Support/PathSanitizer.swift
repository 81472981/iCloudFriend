import CryptoKit
import Foundation
import Photos

enum PathSanitizer {
    static func cleanFileName(_ value: String, fallback: String = "resource") -> String {
        let illegal = CharacterSet(charactersIn: "/\\?%*|\"<>:")
            .union(.newlines)
            .union(.controlCharacters)

        let pieces = value
            .components(separatedBy: illegal)
            .joined(separator: "-")
            .trimmingCharacters(in: .whitespacesAndNewlines)

        let cleaned = pieces.isEmpty ? fallback : pieces
        return String(cleaned.prefix(160))
    }

    static func assetFolderName(for asset: PHAsset, preferredFilename: String?) -> String {
        let hash = sha256Hex(asset.localIdentifier)
        let datePart = yearMonthDay(asset.creationDate)
        let filePart = cleanFileName(preferredFilename ?? "asset", fallback: "asset")
            .split(separator: ".")
            .first
            .map(String.init) ?? "asset"
        return "\(datePart)-\(hash.prefix(16))-\(filePart)"
    }

    static func year(_ date: Date?) -> String {
        let calendar = Calendar(identifier: .gregorian)
        let value = date ?? Date(timeIntervalSince1970: 0)
        return String(format: "%04d", calendar.component(.year, from: value))
    }

    static func month(_ date: Date?) -> String {
        let calendar = Calendar(identifier: .gregorian)
        let value = date ?? Date(timeIntervalSince1970: 0)
        return String(format: "%02d", calendar.component(.month, from: value))
    }

    static func relativePath(from root: URL, to file: URL) -> String {
        let rootPath = root.standardizedFileURL.path
        let filePath = file.standardizedFileURL.path
        guard filePath.hasPrefix(rootPath) else { return file.lastPathComponent }
        let start = filePath.index(filePath.startIndex, offsetBy: rootPath.count)
        return String(filePath[start...]).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    }

    static func sha256Hex(_ value: String) -> String {
        let digest = SHA256.hash(data: Data(value.utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    private static func yearMonthDay(_ date: Date?) -> String {
        let calendar = Calendar(identifier: .gregorian)
        let value = date ?? Date(timeIntervalSince1970: 0)
        let year = calendar.component(.year, from: value)
        let month = calendar.component(.month, from: value)
        let day = calendar.component(.day, from: value)
        return String(format: "%04d%02d%02d", year, month, day)
    }
}
