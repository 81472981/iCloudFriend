import SwiftUI

@main
struct iCloudFriendApp: App {
    @StateObject private var destinationStore: DestinationBookmarkStore
    @StateObject private var backupManager: BackupManager

    init() {
        let destinationStore = DestinationBookmarkStore()
        _destinationStore = StateObject(wrappedValue: destinationStore)
        _backupManager = StateObject(wrappedValue: BackupManager(destinationStore: destinationStore))
    }

    var body: some Scene {
        WindowGroup {
            ContentView(destinationStore: destinationStore, backupManager: backupManager)
                .task {
                    destinationStore.resolveStoredBookmark()
                }
        }
    }
}
