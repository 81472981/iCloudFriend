import CoreLocation
import CryptoKit
import Foundation
import Photos

enum AssetMetadataBuilder {
    static func resources(for asset: PHAsset) -> [PHAssetResource] {
        PHAssetResource.assetResources(for: asset)
            .sorted { lhs, rhs in
                if lhs.type.backupName == rhs.type.backupName {
                    return lhs.originalFilename < rhs.originalFilename
                }
                return lhs.type.backupName < rhs.type.backupName
            }
    }

    static func fingerprint(for asset: PHAsset, resources: [PHAssetResource]) -> String {
        var parts: [String] = [
            asset.localIdentifier,
            asset.creationDate?.timeIntervalSince1970.description ?? "",
            asset.modificationDate?.timeIntervalSince1970.description ?? "",
            String(asset.pixelWidth),
            String(asset.pixelHeight),
            String(asset.duration),
            String(asset.mediaType.rawValue),
            String(asset.mediaSubtypes.rawValue)
        ]

        parts.append(contentsOf: resources.map {
            "\($0.type.backupName)|\($0.originalFilename)|\($0.uniformTypeIdentifier)"
        })

        let input = parts.joined(separator: "\n")
        let digest = SHA256.hash(data: Data(input.utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    static func sidecar(
        for asset: PHAsset,
        fingerprint: String,
        resources: [BackedUpResource]
    ) -> AssetSidecar {
        AssetSidecar(
            formatVersion: 1,
            appName: "iCloudFriend",
            backedUpAt: Date(),
            asset: AssetMetadata(
                localIdentifier: asset.localIdentifier,
                fingerprint: fingerprint,
                mediaType: asset.mediaType.backupName,
                mediaSubtypes: asset.mediaSubtypes.rawValue,
                sourceType: asset.sourceType.rawValue,
                creationDate: asset.creationDate,
                modificationDate: asset.modificationDate,
                pixelWidth: asset.pixelWidth,
                pixelHeight: asset.pixelHeight,
                duration: asset.duration,
                isFavorite: asset.isFavorite,
                isHidden: asset.isHidden,
                location: asset.location.map(LocationMetadata.init(location:))
            ),
            resources: resources
        )
    }
}

extension LocationMetadata {
    init(location: CLLocation) {
        latitude = location.coordinate.latitude
        longitude = location.coordinate.longitude
        altitude = location.altitude
        horizontalAccuracy = location.horizontalAccuracy
        verticalAccuracy = location.verticalAccuracy
        speed = location.speed
        course = location.course
        timestamp = location.timestamp
    }
}

extension PHAssetMediaType {
    var backupName: String {
        switch self {
        case .unknown:
            return "unknown"
        case .image:
            return "image"
        case .video:
            return "video"
        case .audio:
            return "audio"
        @unknown default:
            return "future-\(rawValue)"
        }
    }
}

extension PHAssetResourceType {
    var backupName: String {
        switch self {
        case .photo:
            return "photo"
        case .video:
            return "video"
        case .audio:
            return "audio"
        case .alternatePhoto:
            return "alternatePhoto"
        case .fullSizePhoto:
            return "fullSizePhoto"
        case .fullSizeVideo:
            return "fullSizeVideo"
        case .adjustmentData:
            return "adjustmentData"
        case .adjustmentBasePhoto:
            return "adjustmentBasePhoto"
        case .adjustmentBaseVideo:
            return "adjustmentBaseVideo"
        case .pairedVideo:
            return "pairedVideo"
        case .fullSizePairedVideo:
            return "fullSizePairedVideo"
        case .adjustmentBasePairedVideo:
            return "adjustmentBasePairedVideo"
        case .photoProxy:
            return "photoProxy"
        @unknown default:
            return "future-\(rawValue)"
        }
    }
}
