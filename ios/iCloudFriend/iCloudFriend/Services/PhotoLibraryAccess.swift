import Foundation
import Photos

enum PhotoLibraryAccess {
    static func ensureAuthorized() async throws {
        let current = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        switch current {
        case .authorized, .limited:
            return
        case .notDetermined:
            let requested = await PHPhotoLibrary.requestAuthorization(for: .readWrite)
            guard requested == .authorized || requested == .limited else {
                throw BackupError.photosDenied
            }
        case .denied, .restricted:
            throw BackupError.photosDenied
        @unknown default:
            throw BackupError.photosDenied
        }
    }

    static func fetchAllAssets() -> [PHAsset] {
        let options = PHFetchOptions()
        options.includeHiddenAssets = true
        options.includeAllBurstAssets = true

        let result = PHAsset.fetchAssets(with: options)
        var assets: [PHAsset] = []
        assets.reserveCapacity(result.count)
        result.enumerateObjects { asset, _, _ in
            assets.append(asset)
        }
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
}
