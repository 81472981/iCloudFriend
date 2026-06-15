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
        options.sortDescriptors = [
            NSSortDescriptor(key: "creationDate", ascending: true),
            NSSortDescriptor(key: "localIdentifier", ascending: true)
        ]

        let result = PHAsset.fetchAssets(with: options)
        var assets: [PHAsset] = []
        assets.reserveCapacity(result.count)
        result.enumerateObjects { asset, _, _ in
            assets.append(asset)
        }
        return assets
    }
}
