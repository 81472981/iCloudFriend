import Foundation
import Photos

private enum ResourceExportError: LocalizedError {
    case partialFileIsLongerThanSource(String)

    var errorDescription: String? {
        switch self {
        case .partialFileIsLongerThanSource(let filename):
            return "The partial file for \(filename) was longer than the Photos resource and was reset."
        }
    }
}

final class AssetResourceExporter {
    private let manager = PHAssetResourceManager.default()

    func export(
        resource: PHAssetResource,
        to finalURL: URL,
        backupRoot: URL,
        progress: @escaping @Sendable (_ copiedBytes: Int64) -> Void
    ) async throws -> BackedUpResource {
        try FileManager.default.createDirectory(
            at: finalURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )

        let finalExists = FileManager.default.fileExists(atPath: finalURL.path)
        if finalExists {
            let result = try FileHash.sha256Hex(for: finalURL)
            progress(result.byteCount)
            return makeResourceRecord(
                resource: resource,
                finalURL: finalURL,
                backupRoot: backupRoot,
                hash: result.hash,
                byteCount: result.byteCount
            )
        }

        let partialURL = finalURL.appendingPathExtension("partial")
        let existingBytes = fileSize(at: partialURL)
        try await write(resource: resource, partialURL: partialURL, resumeOffset: existingBytes, progress: progress)

        if FileManager.default.fileExists(atPath: finalURL.path) {
            try FileManager.default.removeItem(at: finalURL)
        }
        try FileManager.default.moveItem(at: partialURL, to: finalURL)

        let result = try FileHash.sha256Hex(for: finalURL)
        return makeResourceRecord(
            resource: resource,
            finalURL: finalURL,
            backupRoot: backupRoot,
            hash: result.hash,
            byteCount: result.byteCount
        )
    }

    private func write(
        resource: PHAssetResource,
        partialURL: URL,
        resumeOffset: Int64,
        progress: @escaping @Sendable (_ copiedBytes: Int64) -> Void
    ) async throws {
        let options = PHAssetResourceRequestOptions()
        options.isNetworkAccessAllowed = true

        if !FileManager.default.fileExists(atPath: partialURL.path) {
            FileManager.default.createFile(atPath: partialURL.path, contents: nil)
        }

        let fileHandle = try FileHandle(forWritingTo: partialURL)
        try fileHandle.seekToEnd()

        let queue = DispatchQueue(label: "com.icloudfriend.resource-writer")

        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            final class Box {
                var skipped: Int64
                var copied: Int64
                var error: Error?
                var didResume = false

                init(offset: Int64) {
                    skipped = offset
                    copied = offset
                }
            }

            let box = Box(offset: resumeOffset)

            _ = manager.requestData(
                for: resource,
                options: options,
                dataReceivedHandler: { data in
                    queue.async {
                        guard box.error == nil else { return }
                        do {
                            try Task.checkCancellation()

                            var chunk = data[...]
                            if box.skipped > 0 {
                                if Int64(chunk.count) <= box.skipped {
                                    box.skipped -= Int64(chunk.count)
                                    return
                                }
                                chunk = chunk.dropFirst(Int(box.skipped))
                                box.skipped = 0
                            }

                            if !chunk.isEmpty {
                                try fileHandle.write(contentsOf: Data(chunk))
                                box.copied += Int64(chunk.count)
                                progress(box.copied)
                            }
                        } catch {
                            box.error = error
                        }
                    }
                },
                completionHandler: { error in
                    queue.async {
                        let closeError: Error?
                        do {
                            try fileHandle.close()
                            closeError = nil
                        } catch {
                            closeError = error
                        }

                        if let writeError = box.error {
                            continuation.resume(throwing: writeError)
                        } else if let error {
                            continuation.resume(throwing: error)
                        } else if let closeError {
                            continuation.resume(throwing: closeError)
                        } else if box.skipped > 0 {
                            try? FileManager.default.removeItem(at: partialURL)
                            continuation.resume(throwing: ResourceExportError.partialFileIsLongerThanSource(resource.originalFilename))
                        } else {
                            continuation.resume()
                        }
                    }
                }
            )
        }
    }

    private func makeResourceRecord(
        resource: PHAssetResource,
        finalURL: URL,
        backupRoot: URL,
        hash: String,
        byteCount: Int64
    ) -> BackedUpResource {
        BackedUpResource(
            originalFilename: resource.originalFilename,
            storedFilename: finalURL.lastPathComponent,
            relativePath: PathSanitizer.relativePath(from: backupRoot, to: finalURL),
            resourceType: resource.type.backupName,
            uniformTypeIdentifier: resource.uniformTypeIdentifier,
            byteCount: byteCount,
            sha256: hash
        )
    }

    private func fileSize(at url: URL) -> Int64 {
        guard let attributes = try? FileManager.default.attributesOfItem(atPath: url.path),
              let size = attributes[.size] as? NSNumber else {
            return 0
        }
        return size.int64Value
    }
}
