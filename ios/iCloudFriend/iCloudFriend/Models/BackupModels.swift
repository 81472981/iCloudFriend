import Foundation

enum BackupMode: String, CaseIterable, Identifiable {
    case full
    case incremental

    var id: String { rawValue }

    var title: String {
        switch self {
        case .full:
            return "Full"
        case .incremental:
            return "Incremental"
        }
    }

    var subtitle: String {
        switch self {
        case .full:
            return "Scan every photo and video"
        case .incremental:
            return "Only upload new or changed assets"
        }
    }
}

enum BackupRunStatus: Equatable {
    case idle
    case preparing
    case running
    case finished
    case cancelled
    case failed(String)

    var title: String {
        switch self {
        case .idle:
            return "Ready"
        case .preparing:
            return "Preparing"
        case .running:
            return "Backing up"
        case .finished:
            return "Finished"
        case .cancelled:
            return "Cancelled"
        case .failed:
            return "Needs attention"
        }
    }
}

struct BackupProgress: Equatable {
    var status: BackupRunStatus = .idle
    var totalAssets: Int = 0
    var completedAssets: Int = 0
    var failedAssets: Int = 0
    var currentAssetName: String = ""
    var currentResourceName: String = ""
    var resourceProgress: Double = 0
    var copiedBytes: Int64 = 0
    var logLines: [String] = []

    var assetFraction: Double {
        guard totalAssets > 0 else { return 0 }
        return min(1, Double(completedAssets) / Double(totalAssets))
    }

    var headline: String {
        if case .failed(let message) = status {
            return message
        }
        if currentResourceName.isEmpty {
            return status.title
        }
        return currentResourceName
    }

    mutating func appendLog(_ message: String) {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm:ss"
        logLines.insert("[\(formatter.string(from: Date()))] \(message)", at: 0)
        if logLines.count > 10 {
            logLines.removeLast(logLines.count - 10)
        }
    }
}

struct ReceiverDevice: Identifiable, Equatable {
    let id: String
    let name: String
    let hostName: String
    let port: Int
    let fingerprint: String?
    let protocolVersion: Int

    var baseURL: URL {
        URL(string: "https://\(hostName):\(port)")!
    }

    var displayName: String {
        name.replacingOccurrences(of: "iCloudFriend ", with: "")
    }
}

struct AssetSidecar: Codable {
    let formatVersion: Int
    let appName: String
    let backedUpAt: Date
    let asset: AssetMetadata
    let resources: [BackedUpResource]
}

struct AssetMetadata: Codable {
    let localIdentifier: String
    let fingerprint: String
    let mediaType: String
    let mediaSubtypes: UInt
    let sourceType: UInt
    let creationDate: Date?
    let modificationDate: Date?
    let pixelWidth: Int
    let pixelHeight: Int
    let duration: Double
    let isFavorite: Bool
    let isHidden: Bool
    let location: LocationMetadata?
}

struct LocationMetadata: Codable {
    let latitude: Double
    let longitude: Double
    let altitude: Double
    let horizontalAccuracy: Double
    let verticalAccuracy: Double
    let speed: Double
    let course: Double
    let timestamp: Date
}

struct BackedUpResource: Codable, Hashable {
    let originalFilename: String
    let storedFilename: String
    let relativePath: String
    let resourceType: String
    let uniformTypeIdentifier: String
    let byteCount: Int64
    let sha256: String
}

struct SyncRecord: Codable, Equatable {
    let localIdentifier: String
    let fingerprint: String
    let assetFolder: String
    let backedUpAt: Date
}

struct BackupEvent: Codable {
    let type: String
    let localIdentifier: String
    let assetFolder: String
    let resourceCount: Int
    let backedUpAt: Date
}

enum BackupError: LocalizedError {
    case noDestination
    case noReceiver
    case photosDenied
    case destinationAccessFailed
    case noResources(String)

    var errorDescription: String? {
        switch self {
        case .noDestination:
            return "Choose the Windows SMB folder first."
        case .noReceiver:
            return "Select a Windows receiver first. Keep both devices on the same Wi-Fi and the Windows app open."
        case .photosDenied:
            return "Photo library access is required to back up iCloud Photos."
        case .destinationAccessFailed:
            return "The selected backup folder can no longer be opened."
        case .noResources(let name):
            return "No exportable resources were found for \(name)."
        }
    }
}
