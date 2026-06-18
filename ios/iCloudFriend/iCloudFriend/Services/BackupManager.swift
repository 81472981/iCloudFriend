import Foundation
import Photos
import UIKit

@MainActor
final class BackupManager: ObservableObject {
    @Published private(set) var progress = BackupProgress()
    @Published private(set) var isRunning = false

    private let receiverDiscovery: ReceiverDiscovery
    private let stateStore = SyncStateStore()
    private let exporter = AssetResourceExporter()
    private let backgroundTask = BackupBackgroundTask()
    private var task: Task<Void, Never>?

    init(receiverDiscovery: ReceiverDiscovery) {
        self.receiverDiscovery = receiverDiscovery
    }

    func start(mode: BackupMode) {
        guard !isRunning else { return }

        isRunning = true
        progress = BackupProgress(status: .preparing)
        progress.appendLog("Starting \(mode.title.lowercased()) sync")

        task = Task { [weak self] in
            guard let self else { return }
            await self.run(mode: mode)
        }
    }

    func cancel() {
        task?.cancel()
        task = nil
        isRunning = false
        progress.status = .cancelled
        progress.appendLog("Backup cancelled")
        backgroundTask.end()
    }

    func refreshReceiverBackupStatus() async {
        guard !isRunning, let receiver = receiverDiscovery.selectedDevice else { return }

        await refreshLocalMediaCount()
        let client = ReceiverClient(device: receiver)
        await refreshWindowsBackupCount(client: client)
    }

    private func run(mode: BackupMode) async {
        var activeClient: ReceiverClient?
        backgroundTask.begin()
        defer {
            backgroundTask.end()
            isRunning = false
            task = nil
        }

        do {
            guard let receiver = receiverDiscovery.selectedDevice else {
                throw BackupError.noReceiver
            }

            let client = ReceiverClient(device: receiver)
            activeClient = client
            try await client.hello()
            progress.appendLog("Connected to \(receiver.displayName)")

            try await PhotoLibraryAccess.ensureAuthorized()
            let assets = PhotoLibraryAccess.fetchAllAssets()
            progress.status = .running
            progress.totalAssets = assets.count
            progress.appendLog("Found \(assets.count) library assets")
            await refreshWindowsBackupCount(client: client)
            let libraryDiagnostic = assets.isEmpty ? PhotoLibraryAccess.lastDiagnosticSummary : nil
            await reportSyncStatus(client: client, mode: mode, runStatus: "running", message: libraryDiagnostic)

            let tempBackupRoot = try makeTemporaryBackupRoot()
            defer {
                try? FileManager.default.removeItem(at: tempBackupRoot.deletingLastPathComponent())
            }

            for asset in assets {
                try Task.checkCancellation()
                await self.backup(asset: asset, mode: mode, backupRoot: tempBackupRoot, client: client)
                await refreshWindowsBackupCount(client: client)
                await reportSyncStatus(client: client, mode: mode, runStatus: "running")
            }

            if Task.isCancelled {
                progress.status = .cancelled
                progress.appendLog("Backup cancelled")
                await reportSyncStatus(client: client, mode: mode, runStatus: "cancelled")
            } else {
                progress.status = .finished
                progress.currentAssetName = ""
                progress.currentResourceName = ""
                progress.resourceProgress = 1
                await refreshWindowsBackupCount(client: client)
                progress.appendLog("Done: \(progress.completedAssets) assets, \(progress.failedAssets) failed")
                await reportSyncStatus(client: client, mode: mode, runStatus: "finished", message: libraryDiagnostic)
            }
        } catch is CancellationError {
            progress.status = .cancelled
            progress.appendLog("Backup cancelled")
            if let activeClient {
                await reportSyncStatus(client: activeClient, mode: mode, runStatus: "cancelled")
            }
        } catch {
            progress.status = .failed(error.localizedDescription)
            progress.appendLog(error.localizedDescription)
            if let activeClient {
                await reportSyncStatus(
                    client: activeClient,
                    mode: mode,
                    runStatus: "failed",
                    message: error.localizedDescription
                )
            }
        }
    }

    private func refreshLocalMediaCount() async {
        do {
            try await PhotoLibraryAccess.ensureAuthorized()
            progress.totalAssets = PhotoLibraryAccess.countAllAssets()
        } catch {
            progress.appendLog("Unable to read iOS count: \(error.localizedDescription)")
        }
    }

    private func refreshWindowsBackupCount(client: ReceiverClient) async {
        do {
            let status = try await client.backupStatus()
            progress.windowsBackedUpAssets = status.visibleMediaCount ?? status.visiblePhotoCount
        } catch {
            progress.appendLog("Unable to read Windows count: \(error.localizedDescription)")
        }
    }

    private func reportSyncStatus(
        client: ReceiverClient,
        mode: BackupMode,
        runStatus: String,
        message: String? = nil
    ) async {
        try? await client.updateSyncStatus(
            deviceName: UIDevice.current.name,
            deviceIdentifier: UIDevice.current.identifierForVendor?.uuidString,
            mode: mode,
            runStatus: runStatus,
            progress: progress,
            message: message
        )
    }

    private func backup(asset: PHAsset, mode: BackupMode, backupRoot: URL, client: ReceiverClient) async {
        let resources = AssetMetadataBuilder.resources(for: asset)
        let displayName = resources.first?.originalFilename ?? asset.localIdentifier
        progress.currentAssetName = displayName
        progress.currentResourceName = ""
        progress.resourceProgress = 0

        guard !resources.isEmpty else {
            progress.failedAssets += 1
            progress.appendLog("Skipped \(displayName): no exportable resources")
            return
        }

        let fingerprint = AssetMetadataBuilder.fingerprint(for: asset, resources: resources)
        let assetFolder = folderURL(for: asset, resources: resources, backupRoot: backupRoot)
        let metadataURL = assetFolder.appendingPathComponent("metadata.json")
        let relativeAssetFolder = PathSanitizer.relativePath(from: backupRoot, to: assetFolder)

        do {
            if mode == .incremental,
               let record = await stateStore.record(for: asset.localIdentifier),
               record.fingerprint == fingerprint,
               try await client.assetIsCurrent(assetFolder: relativeAssetFolder, fingerprint: fingerprint) {
                progress.completedAssets += 1
                progress.resourceProgress = 1
                progress.appendLog("Already current: \(displayName)")
                return
            }

            try FileManager.default.createDirectory(
                at: assetFolder.appendingPathComponent("resources", isDirectory: true),
                withIntermediateDirectories: true
            )

            var backedUpResources: [BackedUpResource] = []
            let targets = resourceTargets(for: resources, assetFolder: assetFolder)

            for (resource, targetURL) in targets {
                try Task.checkCancellation()
                progress.currentResourceName = targetURL.lastPathComponent

                let record = try await exporter.export(
                    resource: resource,
                    to: targetURL,
                    backupRoot: backupRoot
                ) { [weak self] copiedBytes in
                    Task { @MainActor in
                        self?.progress.copiedBytes = copiedBytes
                    }
                }

                backedUpResources.append(record)

                var lastUploadedBytes: Int64 = 0
                try await client.uploadResource(
                    fileURL: targetURL,
                    relativePath: record.relativePath,
                    byteCount: record.byteCount
                ) { [weak self] uploadedBytes in
                    Task { @MainActor in
                        guard let self else { return }
                        let delta = max(0, uploadedBytes - lastUploadedBytes)
                        lastUploadedBytes = uploadedBytes
                        self.progress.copiedBytes += delta
                        self.progress.resourceProgress = record.byteCount > 0
                            ? min(1, Double(uploadedBytes) / Double(record.byteCount))
                            : 1
                    }
                }
            }

            let sidecar = AssetMetadataBuilder.sidecar(
                for: asset,
                fingerprint: fingerprint,
                resources: backedUpResources
            )
            try writeJSON(sidecar, to: metadataURL)

            let event = BackupEvent(
                type: "assetBackedUp",
                localIdentifier: asset.localIdentifier,
                assetFolder: relativeAssetFolder,
                resourceCount: backedUpResources.count,
                backedUpAt: Date()
            )
            try appendEvent(event, backupRoot: backupRoot)
            try await client.commitAsset(sidecar: sidecar, event: event, assetFolder: relativeAssetFolder)

            try await stateStore.upsert(
                SyncRecord(
                    localIdentifier: asset.localIdentifier,
                    fingerprint: fingerprint,
                    assetFolder: relativeAssetFolder,
                    backedUpAt: Date()
                )
            )

            progress.completedAssets += 1
            progress.resourceProgress = 1
            progress.appendLog("Backed up \(displayName)")
            try? FileManager.default.removeItem(at: assetFolder)
        } catch is CancellationError {
            progress.appendLog("Interrupted while backing up \(displayName)")
        } catch {
            progress.failedAssets += 1
            progress.appendLog("Failed \(displayName): \(error.localizedDescription)")
        }
    }

    private func makeTemporaryBackupRoot() throws -> URL {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("iCloudFriendUploadCache", isDirectory: true)
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
            .appendingPathComponent(".icloudfriend", isDirectory: true)
        try prepareBackupRoot(root)
        return root
    }

    private func prepareBackupRoot(_ backupRoot: URL) throws {
        try FileManager.default.createDirectory(
            at: backupRoot.appendingPathComponent("assets", isDirectory: true),
            withIntermediateDirectories: true
        )
        try FileManager.default.createDirectory(
            at: backupRoot.appendingPathComponent("index", isDirectory: true),
            withIntermediateDirectories: true
        )
    }

    private func folderURL(for asset: PHAsset, resources: [PHAssetResource], backupRoot: URL) -> URL {
        let preferred = resources.first?.originalFilename
        let folderName = PathSanitizer.assetFolderName(for: asset, preferredFilename: preferred)
        return backupRoot
            .appendingPathComponent("assets", isDirectory: true)
            .appendingPathComponent(PathSanitizer.year(asset.creationDate), isDirectory: true)
            .appendingPathComponent(PathSanitizer.month(asset.creationDate), isDirectory: true)
            .appendingPathComponent(folderName, isDirectory: true)
    }

    private func resourceTargets(
        for resources: [PHAssetResource],
        assetFolder: URL
    ) -> [(PHAssetResource, URL)] {
        var counts: [String: Int] = [:]
        let resourceFolder = assetFolder.appendingPathComponent("resources", isDirectory: true)

        return resources.map { resource in
            let cleaned = PathSanitizer.cleanFileName(resource.originalFilename, fallback: resource.type.backupName)
            let count = (counts[cleaned] ?? 0) + 1
            counts[cleaned] = count

            let finalName: String
            if count == 1 {
                finalName = cleaned
            } else {
                let url = URL(fileURLWithPath: cleaned)
                let base = url.deletingPathExtension().lastPathComponent
                let ext = url.pathExtension
                finalName = ext.isEmpty ? "\(base)-\(count)" : "\(base)-\(count).\(ext)"
            }

            return (resource, resourceFolder.appendingPathComponent(finalName))
        }
    }

    private func writeJSON<T: Encodable>(_ value: T, to url: URL) throws {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(value)

        let partialURL = url.appendingPathExtension("partial")
        try data.write(to: partialURL, options: [.atomic])
        if FileManager.default.fileExists(atPath: url.path) {
            try FileManager.default.removeItem(at: url)
        }
        try FileManager.default.moveItem(at: partialURL, to: url)
    }

    private func appendEvent(_ event: BackupEvent, backupRoot: URL) throws {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let data = try encoder.encode(event)
        var line = data
        line.append(0x0A)

        let eventsURL = backupRoot.appendingPathComponent("index/events.ndjson")
        if FileManager.default.fileExists(atPath: eventsURL.path) {
            let handle = try FileHandle(forWritingTo: eventsURL)
            try handle.seekToEnd()
            try handle.write(contentsOf: line)
            try handle.close()
        } else {
            try line.write(to: eventsURL, options: [.atomic])
        }
    }
}
