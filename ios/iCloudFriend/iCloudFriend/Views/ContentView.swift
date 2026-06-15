import SwiftUI

struct ContentView: View {
    @ObservedObject var receiverDiscovery: ReceiverDiscovery
    @ObservedObject var backupManager: BackupManager

    @State private var selectedMode: BackupMode = .incremental

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
                        receiverCard
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

            Text("Original photos, videos, Live Photo pairs, and metadata are sent directly to your Windows receiver.")
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

    private var receiverCard: some View {
        card {
            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    Label("Windows Receiver", systemImage: "wifi.router.fill")
                        .font(.headline)
                    Spacer()
                    Button {
                        receiverDiscovery.refresh()
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                    .buttonStyle(.bordered)
                }

                if receiverDiscovery.devices.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(receiverDiscovery.isScanning ? "Searching same Wi-Fi network..." : "No Windows receiver found")
                            .font(.system(.body, design: .rounded).weight(.semibold))
                        Text("Open the Windows iCloudFriend app on the same Wi-Fi. It advertises a local TLS receiver automatically.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                } else {
                    ForEach(receiverDiscovery.devices) { device in
                        Button {
                            receiverDiscovery.select(device)
                        } label: {
                            HStack(spacing: 12) {
                                Image(systemName: receiverDiscovery.selectedDevice == device ? "checkmark.circle.fill" : "desktopcomputer")
                                    .foregroundStyle(receiverDiscovery.selectedDevice == device ? .green : .secondary)
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(device.displayName)
                                        .font(.system(.body, design: .rounded).weight(.semibold))
                                    Text("\(device.hostName):\(device.port) · TLS")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                                Spacer()
                            }
                        }
                        .buttonStyle(.plain)
                    }
                }

                Label {
                    Text("Discovery uses Bonjour on your local network. Transfers are sent directly to the Windows app over local TLS; no cloud server is used.")
                } icon: {
                    Image(systemName: "lock.shield.fill")
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
                    .disabled(receiverDiscovery.selectedDevice == nil)
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
    let discovery = ReceiverDiscovery()
    return ContentView(receiverDiscovery: discovery, backupManager: BackupManager(receiverDiscovery: discovery))
}
