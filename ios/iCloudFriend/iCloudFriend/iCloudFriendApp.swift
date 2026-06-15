import SwiftUI

@main
struct iCloudFriendApp: App {
    @StateObject private var receiverDiscovery: ReceiverDiscovery
    @StateObject private var backupManager: BackupManager

    init() {
        let receiverDiscovery = ReceiverDiscovery()
        _receiverDiscovery = StateObject(wrappedValue: receiverDiscovery)
        _backupManager = StateObject(wrappedValue: BackupManager(receiverDiscovery: receiverDiscovery))
    }

    var body: some Scene {
        WindowGroup {
            ContentView(receiverDiscovery: receiverDiscovery, backupManager: backupManager)
                .task {
                    receiverDiscovery.start()
                }
        }
    }
}
