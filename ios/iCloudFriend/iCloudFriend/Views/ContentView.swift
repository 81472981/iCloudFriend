import SwiftUI

struct ContentView: View {
    @ObservedObject var destinationStore: DestinationBookmarkStore
    @ObservedObject var backupManager: BackupManager

    @State private var selectedMode: BackupMode = .incremental
    @State private var showingFolderPicker = false

    var body: some View {
        NavigationStack {
            ZStack {
                LinearGradient(
                    colors: [
                        Color(red: 0.05, green: 0.14, blue: 0.22),
                        Color(red: 0.03, green: 0.32, blue: 0.42),
                        Color(red: 0.03, green: 0.38, blue: 0.27)
                    ],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing
                )
                .ignoresSafeArea()

                ScrollView {
                    VStack(spacing: 22) {
                        header
                        destinationCard
                        modeCard
                        progressCard
                        logCard
                    }
                    .padding(20)
                }
            }
            .navigationTitle("iCloudFriend")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarColorScheme(.dark, for: .navigationBar)
            .sheet(isPresented: $showingFolderPicker) {
                FolderPicker { url in
                    destinationStore.save(url: url)
                    showingFolderPicker = false
                }
            }
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Image(systemName: "icloud.and.arrow.down.fill")
                    .font(.system(size: 36, weight: .semibold))
                    .foregroundStyle(.white)
                Spacer()
                statusBadge
            }

            Text("Back up iCloud Photos to Windows")
                .font(.system(size: 30, weight: .bold, design: .rounded))
                .foregroundStyle(.white)
                .fixedSize(horizontal: false, vertical: true)

            Text("Original photos, videos, Live Photo pairs, and metadata are saved together on your SMB share.")
                .font(.subheadline)
                .foregroundStyle(.white.opacity(0.78))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, 8)
    }

    private var statusBadge: some View {
        Text(backupManager.progress.status.title)
            .font(.caption.weight(.semibold))
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
            .background(.white.opacity(0.16), in: Capsule())
            .foregroundStyle(.white)
    }

    private var destinationCard: some View {
        card {
            VStack(alignment: .leading, spacing: 14) {
                Label("Windows SMB Folder", systemImage: "externaldrive.connected.to.line.below")
                    .font(.headline)

                Text(destinationStore.destinationLabel)
                    .font(.system(.body, design: .rounded).weight(.semibold))
                    .lineLimit(2)
                    .foregroundStyle(destinationStore.destinationURL == nil ? .secondary : .primary)

                if destinationStore.bookmarkIsStale {
                    Label("Folder permission needs to be refreshed.", systemImage: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .foregroundStyle(.orange)
                }

                HStack {
                    Button {
                        showingFolderPicker = true
                    } label: {
                        Label("Choose Folder", systemImage: "folder.badge.plus")
                    }
                    .buttonStyle(.borderedProminent)

                    if destinationStore.destinationURL != nil {
                        Button("Forget") {
                            destinationStore.clear()
                        }
                        .buttonStyle(.bordered)
                    }
                }

                Label {
                    Text("Connect to the Windows SMB server in the Files app first, then choose the Backup folder inside the iCloudFriend share. The share name itself may not be selectable on iOS.")
                } icon: {
                    Image(systemName: "info.circle.fill")
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }
        }
    }

    private var modeCard: some View {
        card {
            VStack(alignment: .leading, spacing: 14) {
                Text("Sync Mode")
                    .font(.headline)

                Picker("Sync Mode", selection: $selectedMode) {
                    ForEach(BackupMode.allCases) { mode in
                        Text(mode.title).tag(mode)
                    }
                }
                .pickerStyle(.segmented)

                Text(selectedMode.subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var progressCard: some View {
        card {
            VStack(spacing: 18) {
                ProgressRing(
                    value: backupManager.progress.assetFraction,
                    title: backupManager.progress.status.title,
                    subtitle: backupManager.progress.headline
                )

                HStack(spacing: 18) {
                    metric("Assets", "\(backupManager.progress.completedAssets)/\(backupManager.progress.totalAssets)")
                    metric("Failed", "\(backupManager.progress.failedAssets)")
                    metric("Bytes", formattedBytes(backupManager.progress.copiedBytes))
                }

                if backupManager.isRunning {
                    Button(role: .destructive) {
                        backupManager.cancel()
                    } label: {
                        Label("Stop Backup", systemImage: "stop.fill")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                } else {
                    Button {
                        backupManager.start(mode: selectedMode)
                    } label: {
                        Label("Start Backup", systemImage: "play.fill")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(destinationStore.destinationURL == nil)
                }
            }
        }
    }

    private var logCard: some View {
        card {
            VStack(alignment: .leading, spacing: 12) {
                Text("Recent Activity")
                    .font(.headline)

                if backupManager.progress.logLines.isEmpty {
                    Text("No backup activity yet.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(backupManager.progress.logLines, id: \.self) { line in
                        Text(line)
                            .font(.caption.monospaced())
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .lineLimit(2)
                    }
                }
            }
        }
    }

    private func card<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        content()
            .padding(18)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    }

    private func metric(_ title: String, _ value: String) -> some View {
        VStack(spacing: 4) {
            Text(value)
                .font(.headline.monospacedDigit())
            Text(title)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
    }

    private func formattedBytes(_ bytes: Int64) -> String {
        let formatter = ByteCountFormatter()
        formatter.allowedUnits = [.useKB, .useMB, .useGB]
        formatter.countStyle = .file
        return formatter.string(fromByteCount: bytes)
    }
}

#Preview {
    let destination = DestinationBookmarkStore()
    return ContentView(destinationStore: destination, backupManager: BackupManager(destinationStore: destination))
}
