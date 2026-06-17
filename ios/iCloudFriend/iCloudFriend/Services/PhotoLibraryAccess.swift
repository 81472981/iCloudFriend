import Foundation
import Photos

enum PhotoLibraryAccess {
    static private(set) var lastDiagnosticSummary: String?

    static func ensureAuthorized() async throws {
        let current = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        let legacy = PHPhotoLibrary.authorizationStatus()

        if isAllowed(current) || isAllowed(legacy) {
            return
        }

        if current == .notDetermined {
            let requested = await PHPhotoLibrary.requestAuthorization(for: .readWrite)
            if isAllowed(requested) {
                return
            }
        }

        if legacy == .notDetermined {
            let requested = await requestLegacyAuthorization()
            if isAllowed(requested) {
                return
            }
        }

        throw BackupError.photosDenied
    }

    static func fetchAllAssets() -> [PHAsset] {
        let options = PHFetchOptions()
        options.includeHiddenAssets = true
        options.includeAllBurstAssets = true
        options.includeAssetSourceTypes = [.typeUserLibrary, .typeCloudShared, .typeiTunesSynced]

        let defaultAssets = assets(from: PHAsset.fetchAssets(with: nil))
        let optionAssets = assets(from: PHAsset.fetchAssets(with: options))
        let defaultImages = assets(from: PHAsset.fetchAssets(with: .image, options: nil))
        let optionImages = assets(from: PHAsset.fetchAssets(with: .image, options: options))
        let defaultVideos = assets(from: PHAsset.fetchAssets(with: .video, options: nil))
        let optionVideos = assets(from: PHAsset.fetchAssets(with: .video, options: options))

        let summary = """
        PhotoLibraryAccess diagnostics: readWrite=\(statusName(PHPhotoLibrary.authorizationStatus(for: .readWrite))) \
        legacy=\(statusName(PHPhotoLibrary.authorizationStatus())) \
        default=\(defaultAssets.count) options=\(optionAssets.count) \
        imagesDefault=\(defaultImages.count) imagesOptions=\(optionImages.count) \
        videosDefault=\(defaultVideos.count) videosOptions=\(optionVideos.count)
        """
        lastDiagnosticSummary = summary
        print(summary)

        if !defaultAssets.isEmpty {
            return sortedAssets(defaultAssets)
        }

        if !optionAssets.isEmpty {
            return sortedAssets(optionAssets)
        }

        let mediaAssets = uniqueAssets(defaultImages + defaultVideos)
        if !mediaAssets.isEmpty {
            return sortedAssets(mediaAssets)
        }

        return sortedAssets(uniqueAssets(optionImages + optionVideos))
    }

    private static func assets(from result: PHFetchResult<PHAsset>) -> [PHAsset] {
        var assets: [PHAsset] = []
        assets.reserveCapacity(result.count)
        result.enumerateObjects { asset, _, _ in
            assets.append(asset)
        }
        return assets
    }

    private static func uniqueAssets(_ assets: [PHAsset]) -> [PHAsset] {
        var seen = Set<String>()
        return assets.filter { asset in
            seen.insert(asset.localIdentifier).inserted
        }
    }

    private static func sortedAssets(_ assets: [PHAsset]) -> [PHAsset] {
        return assets.sorted { left, right in
            switch (left.creationDate, right.creationDate) {
            case let (leftDate?, rightDate?) where leftDate != rightDate:
                return leftDate < rightDate
            case (nil, _?):
                return false
            case (_?, nil):
                return true
            default:
                return left.localIdentifier < right.localIdentifier
            }
        }
    }

    private static func isAllowed(_ status: PHAuthorizationStatus) -> Bool {
        switch status {
        case .authorized, .limited:
            return true
        case .notDetermined, .denied, .restricted:
            return false
        @unknown default:
            return false
        }
    }

    private static func requestLegacyAuthorization() async -> PHAuthorizationStatus {
        await withCheckedContinuation { continuation in
            PHPhotoLibrary.requestAuthorization { status in
                continuation.resume(returning: status)
            }
        }
    }

    private static func statusName(_ status: PHAuthorizationStatus) -> String {
        switch status {
        case .notDetermined:
            return "notDetermined"
        case .restricted:
            return "restricted"
        case .denied:
            return "denied"
        case .authorized:
            return "authorized"
        case .limited:
            return "limited"
        @unknown default:
            return "unknown"
        }
    }
}
